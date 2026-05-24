/**
 * clone-project-tool — real host-level git clone for the agentic chat.
 *
 * Unlike sandbox tools (which run isolated /tmp dirs that vanish), this
 * tool executes `git clone` on the actual Mac host filesystem so the
 * user gets a real working copy they can open, edit, and run.
 *
 * Security boundaries:
 *   - Only trusted Git hosts (no arbitrary hosts).
 *   - Dest path locked to `~/Desktop/sira-projects/` (configurable via
 *     env `SIRAGPT_PROJECTS_DIR`).
 *   - Max 5 min wall-clock (large repos like pytorch/pytorch).
 *   - Deep guard rails: no `--config`, no pipe/shell injection.
 *   - Already-cloned repos reuse the existing directory (fast-forward).
 *   - Runs in a child_process via `git clone` directly, not through a
 *     shell, to avoid injection via URL fragments.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ALLOWED_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);

const GIT_CLONE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_OUTPUT_BYTES = 32 * 1024;
const SAFE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;

// Matches https://github.com/owner/repo, github.com/owner/repo, and git@github.com:owner/repo.git
const GITHUB_RE = /^(?:(?:https?:\/\/)?(?:www\.)?(github\.com|gitlab\.com|bitbucket\.org)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?|git@(github\.com):([\w.-]+)\/([\w.-]+?)(?:\.git)?)$/i;

function projectsDir() {
  return process.env.SIRAGPT_PROJECTS_DIR || path.join(os.homedir(), 'Desktop', 'sira-projects');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isWithinDir(parent, child) {
  const parentPath = path.resolve(parent);
  const childPath = path.resolve(child);
  return childPath === parentPath || childPath.startsWith(parentPath + path.sep);
}

function safeCloneUrl(raw) {
  const s = String(raw || '').trim();
  const m = GITHUB_RE.exec(s);
  if (!m) return null;
  // m[1] = host (http form), m[2] = owner, m[3] = repo
  // OR m[4] = host (SSH form), m[5] = owner, m[6] = repo
  const host = (m[1] || m[4] || '').toLowerCase();
  const owner = m[2] || m[5];
  const repo = m[3] || m[6];
  if (!host || !ALLOWED_HOSTS.has(host) || !owner || !repo) return null;
  // Construct a clean URL: no shell metacharacters, no fragments,
  // always https, always with .git suffix for bare-clone compat.
  return `https://${host}/${owner}/${repo}.git`;
}

function safeBranchName(raw) {
  const branch = String(raw || '').trim();
  if (!branch) return '';
  if (!SAFE_BRANCH_RE.test(branch)) return null;
  if (branch.includes('..') || branch.includes('@{') || branch.includes('//')) return null;
  if (branch.endsWith('.') || branch.endsWith('/') || branch.endsWith('.lock')) return null;
  return branch;
}

function repoDirName(cloneUrl) {
  const cleanUrl = cloneUrl.replace(/\.git$/, '');
  const m = GITHUB_RE.exec(cleanUrl);
  if (!m) return null;
  const owner = m[2] || m[5];
  const repo = m[3] || m[6];
  if (!owner || !repo) return null;
  return `${owner}-${repo}`;
}

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: os.homedir(), GIT_TERMINAL_PROMPT: '0' },
      timeout: GIT_CLONE_TIMEOUT_MS,
    });

    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = Buffer.alloc(0);

    child.stdout.on('data', (chunk) => {
      stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
      if (stdoutBuf.length > MAX_OUTPUT_BYTES * 2) {
        child.kill('SIGKILL');
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrBuf = Buffer.concat([stderrBuf, chunk]);
      if (stderrBuf.length > MAX_OUTPUT_BYTES * 2) {
        child.kill('SIGKILL');
      }
    });

    child.on('close', (code, signal) => {
      const stdout = stdoutBuf.toString('utf8').slice(0, MAX_OUTPUT_BYTES);
      const stderr = stderrBuf.toString('utf8').slice(0, MAX_OUTPUT_BYTES);
      resolve({
        ok: code === 0,
        exitCode: code,
        signal,
        stdout,
        stderr,
      });
    });

    child.on('error', (err) => {
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: `spawn error: ${err.message}`,
      });
    });
  });
}

/**
 * Clone a GitHub/GitLab/Bitbucket repo to the local projects directory.
 *
 * @param {object} args
 * @param {string} args.url    — Full repo URL, e.g. "https://github.com/open-webui/open-webui"
 * @param {string} [args.branch]  — Optional branch/tag to checkout during clone.
 * @param {object} ctx
 * @returns {Promise<{ok, path, message, branch?, stdout, stderr, cloneDurationMs?}>}
 */
async function cloneProject(args, ctx = {}) {
  const url = String(args?.url || '').trim();
  if (!url) {
    return { ok: false, error: 'Se requiere una URL de repositorio' };
  }

  const cloneUrl = safeCloneUrl(url);
  if (!cloneUrl) {
    return {
      ok: false,
      error: 'URL no válida. Solo se aceptan repositorios de github.com, gitlab.com o bitbucket.org. Ejemplo: https://github.com/open-webui/open-webui',
    };
  }

  const baseDir = projectsDir();
  ensureDir(baseDir);

  const dirName = repoDirName(cloneUrl);
  const destPath = path.join(baseDir, dirName);
  if (!isWithinDir(baseDir, destPath)) {
    return { ok: false, error: 'Ruta de destino inválida para el repositorio solicitado' };
  }
  const branch = safeBranchName(args?.branch);
  if (branch === null) {
    return {
      ok: false,
      error: 'Nombre de rama inválido. Usa solo letras, números, punto, guion, guion bajo o slash, sin espacios ni opciones de línea de comandos.',
    };
  }

  ctx.onEvent?.({ type: 'tool_call', tool: 'clone_project', preview: `Clonando ${cloneUrl} → ${destPath}` });
  ctx.onEvent?.({ type: 'stage', label: `Clonando ${dirName}`, pct: 10 });

  // If directory already exists, try git pull instead
  if (fs.existsSync(destPath) && fs.existsSync(path.join(destPath, '.git'))) {
    ctx.onEvent?.({ type: 'stage', label: 'Repositorio ya existe, actualizando...', pct: 30 });
    const pullArgs = branch ? ['pull', '--ff-only', 'origin', branch] : ['pull', '--ff-only'];
    const result = await runGit(pullArgs, destPath);
    if (result.ok) {
      ctx.onEvent?.({ type: 'stage', label: 'Repositorio actualizado', pct: 100 });
      return {
        ok: true,
        path: destPath,
        message: `Repositorio actualizado en ${destPath}`,
        alreadyExisted: true,
        branch,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }
    // If pull fails, report but let user decide
    return {
      ok: false,
      path: destPath,
      error: `El directorio ${destPath} ya existe pero git pull falló: ${result.stderr.slice(0, 500)}. Puedes eliminarlo manualmente e intentar de nuevo.`,
      alreadyExisted: true,
      branch,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  // Fresh clone
  const startMs = Date.now();
  ctx.onEvent?.({ type: 'stage', label: `Clonando ${dirName}...`, pct: 30 });

  const cloneArgs = ['clone', '--depth', '1'];
  if (branch) cloneArgs.push('--branch', branch);
  cloneArgs.push('--', cloneUrl, destPath);
  const result = await runGit(cloneArgs, baseDir);
  const cloneDurationMs = Date.now() - startMs;

  if (result.ok) {
    ctx.onEvent?.({ type: 'stage', label: `✓ ${dirName} clonado`, pct: 100 });
    ctx.onEvent?.({ type: 'tool_output', tool: 'clone_project', ok: true, preview: `Clonado en ${destPath}` });
    return {
      ok: true,
      path: destPath,
      message: `✅ Repositorio clonado exitosamente en: ${destPath}`,
      branch,
      cloneDurationMs,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  // Clean up partial clone on failure
  if (fs.existsSync(destPath)) {
    try { fs.rmSync(destPath, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  const errMsg = result.stderr || result.stdout || 'Error desconocido';
  ctx.onEvent?.({ type: 'tool_output', tool: 'clone_project', ok: false, preview: errMsg.slice(0, 500) });
  return {
    ok: false,
    error: `Error al clonar: ${errMsg.slice(0, 800)}`,
    branch,
    cloneDurationMs,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * List already-cloned projects in the projects directory.
 */
function listProjects() {
  const baseDir = projectsDir();
  if (!fs.existsSync(baseDir)) return [];
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory() && fs.existsSync(path.join(baseDir, e.name, '.git')))
    .map(e => ({ name: e.name, path: path.join(baseDir, e.name) }));
}

/**
 * Tool definition for the agentic-chat-stream / react-agent.
 */
const cloneProjectTool = {
  name: 'clone_project',
  description: 'Clone a GitHub/GitLab/Bitbucket repository to the local projects directory (~/Desktop/sira-projects/). Use this when the user asks to download, clone, descargar, or get a repo locally. Only supports github.com, gitlab.com, and bitbucket.org URLs. Clones with --depth 1 for speed. If the repo already exists it will try to update it with git pull.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Full repository URL, e.g. "https://github.com/open-webui/open-webui" or just "github.com/open-webui/open-webui"',
      },
      branch: {
        type: 'string',
        description: 'Branch name (default: main). Also accepts "master" or any other branch.',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
  execute: cloneProject,
};

module.exports = {
  cloneProject,
  cloneProjectTool,
  listProjects,
  projectsDir,
  // Exported for testing:
  _internal: { safeCloneUrl, repoDirName, safeBranchName, isWithinDir, GITHUB_RE, ALLOWED_HOSTS },
};

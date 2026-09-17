'use strict';

/**
 * codex/workspace-changes — cambios del workspace de un proyecto frente a su
 * rama base (Etapa 7 de paridad con Claude Code: vista «Cambios» y «Crear PR»
 * desde un chat de /agentes).
 *
 * Puro sobre el runner (argv, nunca shell) para que los tests sean offline.
 * `getWorkspaceChanges` es de solo lectura. `prepareWorkspaceBranch` es la
 * única mutación: deja los cambios del chat en una rama `run/<id>` con un
 * commit, que es lo que `self-hosting.publishSelfHostedPullRequest` sabe
 * publicar (diff `base...run/<id>` → blobs/tree/commit/PR vía API de GitHub).
 */

const { runBranchName, isSafeBranchName } = require('./git-workflow');
const { gitCommitAll, boundedCommitText } = require('./workspace');

const DIFF_CAP = 500_000;
const MAX_FILES = 500;
const MAX_UNTRACKED_DIFFS = 40;

class WorkspaceChangesError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'WorkspaceChangesError';
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

function sanitizeBase(baseBranch) {
  const base = String(baseBranch || 'main').trim();
  if (!isSafeBranchName(base) || base.startsWith('run/')) {
    throw new WorkspaceChangesError('invalid_source_branch', 'source branch is invalid', 400);
  }
  return base;
}

async function git(runner, projectId, args, { okExit = [0] } = {}) {
  if (!runner || typeof runner.exec !== 'function') throw new TypeError('runner.exec is required');
  const out = await runner.exec(projectId, ['git', ...args]);
  const exitCode = Number.isInteger(out?.exitCode) ? out.exitCode : 1;
  if (!okExit.includes(exitCode)) {
    throw new WorkspaceChangesError('git_failed', `git ${args[0]} failed (exit ${exitCode})`, 502, {
      operation: args[0],
      detail: String(out?.stderr || out?.stdout || '').slice(0, 400),
    });
  }
  return { exitCode, stdout: String(out?.stdout || ''), stderr: String(out?.stderr || '') };
}

const STATUS_BY_LETTER = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
  U: 'conflict',
};

/** `git diff --name-status -z <base>` → [{ path, status, from? }]. */
function parseNameStatus(text) {
  const tokens = String(text || '').split('\0');
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const code = tokens[i];
    if (!code) continue;
    const letter = code[0];
    const status = STATUS_BY_LETTER[letter] || 'modified';
    if (letter === 'R' || letter === 'C') {
      const from = tokens[i + 1];
      const path = tokens[i + 2];
      i += 2;
      if (path) out.push({ path, status, from: from || null });
      continue;
    }
    const path = tokens[i + 1];
    i += 1;
    if (path) out.push({ path, status });
  }
  return out;
}

/** `git diff --numstat -z <base>` → Map(path → { additions, deletions, binary }). */
function parseNumstat(text) {
  const tokens = String(text || '').split('\0');
  const map = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = tokens[i];
    if (!entry) continue;
    const parts = entry.split('\t');
    if (parts.length < 3) continue;
    const [add, del, inlinePath] = parts;
    const binary = add === '-' || del === '-';
    const stat = {
      additions: binary ? 0 : Number.parseInt(add, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(del, 10) || 0,
      binary,
    };
    let path = inlinePath;
    if (!path) {
      // Rename/copy: "add\tdel\t" + "\0old\0new".
      path = tokens[i + 2];
      i += 2;
    }
    if (path) map.set(path, stat);
  }
  return map;
}

/** `git status --porcelain=v1 -z --untracked-files=all` → { untracked, dirtyPaths }. */
function parsePorcelain(text) {
  const tokens = String(text || '').split('\0');
  const untracked = [];
  const dirtyPaths = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = tokens[i];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (xy === '??') {
      if (path) untracked.push(path);
      continue;
    }
    if (xy[0] === 'R' || xy[0] === 'C') {
      // Staged rename/copy: the next token is the original path.
      i += 1;
    }
    if (path) dirtyPaths.add(path);
  }
  return { untracked, dirtyPaths };
}

function countDiffLines(diffText) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

/**
 * Snapshot de solo lectura: archivos cambiados frente a `baseBranch` (commits
 * por delante + working tree + untracked), diff unificado (cap) y resumen.
 */
async function getWorkspaceChanges({ runner, projectId, baseBranch, diffCap = DIFF_CAP } = {}) {
  if (!projectId) throw new WorkspaceChangesError('project_required', 'projectId is required', 400);
  const base = sanitizeBase(baseBranch);

  const baseRef = await git(runner, projectId, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { okExit: [0, 1] });
  const baseSha = baseRef.stdout.trim();
  if (baseRef.exitCode !== 0 || !baseSha) {
    throw new WorkspaceChangesError('base_missing', `base branch ${base} is not present in the workspace`, 409);
  }
  const headBranchOut = await git(runner, projectId, ['rev-parse', '--abbrev-ref', 'HEAD'], { okExit: [0, 128] });
  const headBranchRaw = headBranchOut.stdout.trim();
  const headBranch = headBranchOut.exitCode === 0 && headBranchRaw && headBranchRaw !== 'HEAD' ? headBranchRaw : null;
  const headSha = (await git(runner, projectId, ['rev-parse', 'HEAD'])).stdout.trim();
  const aheadOut = await git(runner, projectId, ['rev-list', '--count', `${base}..HEAD`], { okExit: [0, 128] });
  const ahead = aheadOut.exitCode === 0 ? Number.parseInt(aheadOut.stdout, 10) || 0 : 0;

  const nameStatus = parseNameStatus((await git(runner, projectId, ['diff', '--name-status', '-z', base])).stdout);
  const numstat = parseNumstat((await git(runner, projectId, ['diff', '--numstat', '-z', base])).stdout);
  const porcelain = parsePorcelain(
    (await git(runner, projectId, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout,
  );

  let diff = (await git(runner, projectId, ['diff', base])).stdout;
  const files = nameStatus.slice(0, MAX_FILES).map((entry) => {
    const stat = numstat.get(entry.path) || { additions: 0, deletions: 0, binary: false };
    return {
      path: entry.path,
      status: entry.status,
      ...(entry.from ? { from: entry.from } : {}),
      additions: stat.additions,
      deletions: stat.deletions,
      binary: stat.binary,
      uncommitted: porcelain.dirtyPaths.has(entry.path),
    };
  });

  let inlined = 0;
  const tracked = new Set(files.map((f) => f.path));
  for (const path of porcelain.untracked.slice(0, Math.max(0, MAX_FILES - files.length))) {
    if (tracked.has(path)) continue;
    let additions = 0;
    let binary = false;
    if (inlined < MAX_UNTRACKED_DIFFS && diff.length < diffCap) {
      // eslint-disable-next-line no-await-in-loop
      const out = await git(runner, projectId, ['diff', '--no-index', '--', '/dev/null', path], { okExit: [0, 1] });
      inlined += 1;
      binary = /^Binary files /m.test(out.stdout);
      additions = binary ? 0 : countDiffLines(out.stdout).additions;
      if (out.stdout) diff += `${diff && !diff.endsWith('\n') ? '\n' : ''}${out.stdout}`;
    }
    files.push({ path, status: 'untracked', additions, deletions: 0, binary, uncommitted: true });
  }

  let truncated = false;
  if (diff.length > diffCap) {
    diff = `${diff.slice(0, diffCap)}\n…[diff truncado]`;
    truncated = true;
  }
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  return {
    ok: true,
    base: { branch: base, sha: baseSha },
    head: { branch: headBranch, sha: headSha, ahead },
    files,
    filesChanged: files.length,
    additions,
    deletions,
    diff,
    truncated,
    dirty: porcelain.dirtyPaths.size > 0 || porcelain.untracked.length > 0,
  };
}

/** Id de run estable en forma pero único por publicación: `agentes-<proyecto>-<yyyymmddHHMM>`. */
function workspaceRunId(projectId, now = new Date()) {
  const short = String(projectId || '').replace(/[^A-Za-z0-9]/g, '').slice(-8).toLowerCase() || 'chat';
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  return `agentes-${short}-${stamp}`;
}

/**
 * Deja los cambios del chat en `run/<runId>` con un commit (identidad Codex
 * Agent), sin tocar la rama base. Working tree limpio y sin commits por
 * delante ⇒ `no_changes` y ninguna mutación.
 */
async function prepareWorkspaceBranch({ runner, projectId, baseBranch, runId, title, body = '' } = {}) {
  if (!projectId) throw new WorkspaceChangesError('project_required', 'projectId is required', 400);
  const base = sanitizeBase(baseBranch);
  const workBranch = runBranchName(runId);
  if (!workBranch) throw new WorkspaceChangesError('invalid_run_id', 'run id is invalid', 400);

  const porcelain = parsePorcelain(
    (await git(runner, projectId, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout,
  );
  const aheadOut = await git(runner, projectId, ['rev-list', '--count', `${base}..HEAD`], { okExit: [0, 128] });
  const ahead = aheadOut.exitCode === 0 ? Number.parseInt(aheadOut.stdout, 10) || 0 : 0;
  const dirty = porcelain.dirtyPaths.size > 0 || porcelain.untracked.length > 0;
  if (!dirty && ahead === 0) return { status: 'no_changes', branch: null, commitSha: null, committed: false };

  await git(runner, projectId, ['checkout', '-B', workBranch]);
  let commitSha;
  if (dirty) {
    const message = boundedCommitText(title, 120) || 'feat(agentes): cambios desde el chat';
    try {
      commitSha = await gitCommitAll(runner, projectId, message, { body });
    } catch (err) {
      throw new WorkspaceChangesError('git_failed', String(err?.message || 'git commit failed'), 502);
    }
  } else {
    commitSha = (await git(runner, projectId, ['rev-parse', 'HEAD'])).stdout.trim();
  }
  return { status: 'prepared', branch: workBranch, commitSha, committed: dirty };
}

module.exports = {
  DIFF_CAP,
  MAX_UNTRACKED_DIFFS,
  WorkspaceChangesError,
  parseNameStatus,
  parseNumstat,
  parsePorcelain,
  countDiffLines,
  getWorkspaceChanges,
  workspaceRunId,
  prepareWorkspaceBranch,
};

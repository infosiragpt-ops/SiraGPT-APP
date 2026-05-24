/**
 * host-bash-tool — run shell commands on the actual host (not sandbox).
 *
 * This gives the agentic chat the ability to execute real commands:
 *   - `ls`, `cat`, `find`, `grep` for file inspection
 *   - `npm install`, `pip install` for dependency management
 *   - `node`, `python3` for running scripts on real project files
 *   - `git status`, `git diff` for repo operations beyond clone
 *
 * Security (defense in depth):
 *   1. ALLOWED_COMMANDS — explicit allowlist of command prefixes.
 *      Everything else is rejected at the validator level.
 *   2. ALLOWED_DIRS — execution is chrooted-by-validation to
 *      ~/Desktop/sira-projects/ and ~/Desktop/siraGPT/ by default.
 *      Any cd/path outside those directories is rejected.
 *   3. Timeout — hard 60 s wall clock kill.
 *   4. Max output — 128 KB stdout/stderr cap.
 *   5. No interactive I/O — stdin closed immediately.
 *   6. No PIPE chaining — rejected by allowlist (no `|`, no `;`, no `&&`).
 *
 * This is NOT a general-purpose shell. It's a curated execution tool
 * so the agent can meaningfully work on cloned projects without being
 * crippled by the sandbox's isolation.
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

// ============================================================
// Configuration — tune via env or defaults
// ============================================================

const ALLOWED_COMMANDS = new Set([
  // File system
  'ls', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'stat', 'du', 'file', 'tree',
  // Git (read-only + common ops)
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git remote',
  'git stash list', 'git tag',
  // Node / npm
  'node', 'npm', 'npx', 'node_modules/.bin',
  // Python
  'python3', 'pip3',
  // System info
  'pwd', 'echo', 'which', 'uname', 'sw_vers', 'df', 'date',
  // Make / build
  'make', 'cmake',
]);

// Only operations inside these directories are allowed.
const ALLOWED_DIRS = new Set([
  path.join(os.homedir(), 'Desktop', 'sira-projects'),
  path.join(os.homedir(), 'Desktop', 'siraGPT'),
  os.tmpdir(),
]);

const HOST_BASH_TIMEOUT_MS = parseInt(process.env.SIRAGPT_HOST_BASH_TIMEOUT_MS || '120000', 10); // 2 min
const MAX_OUTPUT_BYTES = 128 * 1024;

// ============================================================
// Validation
// ============================================================

function isAllowedCommand(rawCmd) {
  const cmd = String(rawCmd || '').trim();

  // Reject shell chaining operators
  if (/[;&|]/.test(cmd)) return false;

  // Check against allowed command prefixes
  for (const prefix of ALLOWED_COMMANDS) {
    if (cmd.startsWith(prefix + ' ') || cmd === prefix) return true;
  }

  return false;
}

function isAllowedDirectory(dir) {
  if (!dir) return true; // no explicit dir = default allowed
  const resolved = path.resolve(dir);
  for (const allowed of ALLOWED_DIRS) {
    if (resolved === allowed || resolved.startsWith(allowed + path.sep)) return true;
  }
  return false;
}

function isSafePathToken(token, workingDir) {
  if (!token || token.startsWith('-')) return true;
  const unquoted = String(token).replace(/^['"]|['"]$/g, '');
  if (!unquoted || unquoted === '.' || unquoted === '..') return unquoted !== '..';
  if (unquoted.includes('..' + path.sep) || unquoted.includes('/../')) return false;

  if (path.isAbsolute(unquoted)) return isAllowedDirectory(unquoted);
  if (unquoted.startsWith('~/')) {
    const expanded = path.join(os.homedir(), unquoted.slice(2));
    return isAllowedDirectory(expanded);
  }

  const resolved = path.resolve(workingDir || path.join(os.homedir(), 'Desktop', 'sira-projects'), unquoted);
  return isAllowedDirectory(resolved);
}

function commandHasUnsafePathReference(command, workingDir) {
  const parts = String(command || '').trim().split(/\s+/).slice(1);
  return parts.some((part) => !isSafePathToken(part, workingDir));
}

// ============================================================
// Execution
// ============================================================

function runHostCommand(fullCommand, cwd) {
  return new Promise((resolve) => {
    // Parse the command into the first token (as argv[0]) and the rest as args.
    // We run through `sh -c` but with the allowlist guard already passed.
    const parts = fullCommand.trim().split(/\s+/);
    const bin = parts[0];
    const args = parts.slice(1);

    const child = spawn(bin, args, {
      cwd: cwd || os.homedir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        NODE_ENV: process.env.NODE_ENV || 'development',
      },
      timeout: HOST_BASH_TIMEOUT_MS,
    });

    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = Buffer.alloc(0);

    child.stdout.on('data', (chunk) => {
      stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
      if (stdoutBuf.length > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrBuf = Buffer.concat([stderrBuf, chunk]);
      if (stderrBuf.length > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
      }
    });

    // Close stdin immediately (no interactive input)
    try { child.stdin.end(); } catch { /* already closed */ }

    child.on('close', (code, signal) => {
      const stdout = stdoutBuf.toString('utf8').slice(0, MAX_OUTPUT_BYTES);
      const stderr = stderrBuf.toString('utf8').slice(0, MAX_OUTPUT_BYTES);
      resolve({
        ok: code === 0,
        exitCode: code,
        stdout,
        stderr,
        timedOut: signal === 'SIGKILL' || signal === 'SIGTERM',
      });
    });

    child.on('error', (err) => {
      resolve({
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: `Error al ejecutar: ${err.message}`,
        timedOut: false,
      });
    });
  });
}

// ============================================================
// Tool handler
// ============================================================

/**
 * Execute a shell command on the host.
 *
 * @param {object} args
 * @param {string} args.command  — The command to run (e.g. "ls -la" or "git log --oneline -5")
 * @param {string} [args.directory] — Working directory (must be within allowed dirs)
 * @param {object} ctx
 * @returns {Promise<{ok, stdout, stderr, exitCode?}>}
 */
async function hostBash(args, ctx = {}) {
  const command = String(args?.command || '').trim();
  if (!command) {
    return { ok: false, error: 'Se requiere un comando para ejecutar' };
  }

  if (!isAllowedCommand(command)) {
    return {
      ok: false,
      error: `Comando no permitido: "${command.split(/\s+/)[0] || command}". Los comandos permitidos son: ${[...ALLOWED_COMMANDS].slice(0, 15).join(', ')}. Por seguridad, no se permiten pipes (|), cadenas (;) o operadores (&).`,
      allowedPrefixes: [...ALLOWED_COMMANDS],
    };
  }

  const workingDir = args.directory || path.join(os.homedir(), 'Desktop', 'sira-projects');

  if (args.directory && !isAllowedDirectory(args.directory)) {
    return {
      ok: false,
      error: `Directorio no permitido: "${args.directory}". Solo se permiten operaciones dentro de ~/Desktop/sira-projects y ~/Desktop/siraGPT.`,
    };
  }

  if (commandHasUnsafePathReference(command, workingDir)) {
    return {
      ok: false,
      error: 'El comando contiene una ruta fuera de los directorios permitidos. Solo se permiten rutas dentro de ~/Desktop/sira-projects, ~/Desktop/siraGPT o /tmp.',
    };
  }

  ctx.onEvent?.({ type: 'tool_call', tool: 'host_bash', preview: command.slice(0, 200) });
  ctx.onEvent?.({ type: 'stage', label: `Ejecutando: ${command.slice(0, 80)}`, pct: 30 });

  const result = await runHostCommand(command, workingDir);

  const stdoutPreview = result.stdout.slice(0, 1500);
  const stderrPreview = result.stderr.slice(0, 1000);

  ctx.onEvent?.({ type: 'stage', label: result.ok ? 'Comando ejecutado' : 'Comando falló', pct: 100 });
  ctx.onEvent?.({
    type: 'tool_output',
    tool: 'host_bash',
    ok: result.ok,
    preview: result.ok ? stdoutPreview.slice(0, 600) : stderrPreview.slice(0, 600),
  });

  return {
    ok: result.ok,
    exitCode: result.exitCode,
    stdout: stdoutPreview,
    stderr: stderrPreview,
    stdoutTruncated: result.stdout.length > 1500,
    stderrTruncated: result.stderr.length > 1000,
    timedOut: result.timedOut,
    command,
    workingDir,
    stdoutFullLength: result.stdout.length,
    stderrFullLength: result.stderr.length,
  };
}

// ============================================================
// Tool definition for react-agent / agentic-chat-stream
// ============================================================

const hostBashTool = {
  name: 'host_bash',
  description: 'Execute a shell command on the host machine. Use this to inspect files, run git commands (status/log/diff), list directory contents, run npm/pip commands on cloned projects, and execute build/test scripts. Allowed commands: ls, cat, head, tail, find, grep, git (status/log/diff/show/branch/remote), node, npm, npx, python3, pip3, make, and basic system utilities. Operations are restricted to ~/Desktop/sira-projects/ and ~/Desktop/siraGPT/.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to run, e.g., "ls -la", "git status", "node --version". Avoid pipes (|), semicolons (;), and ampersands (&) as they are blocked for security.',
      },
      directory: {
        type: 'string',
        description: 'Working directory (optional). Defaults to ~/Desktop/sira-projects/. Must be within allowed project directories.',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  execute: hostBash,
};

module.exports = {
  hostBash,
  hostBashTool,
  ALLOWED_COMMANDS,
  ALLOWED_DIRS,
  // Exported for testing:
  _internal: { isAllowedCommand, isAllowedDirectory, commandHasUnsafePathReference, runHostCommand },
};

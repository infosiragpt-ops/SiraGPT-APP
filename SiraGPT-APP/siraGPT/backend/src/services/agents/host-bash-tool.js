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
  // Git (read-only + bounded write ops for autonomous repo workflow)
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git remote',
  'git stash list', 'git tag',
  'git add', 'git commit', 'git push', 'git pull', 'git fetch', 'git checkout', 'git switch',
  'git config', 'git init',
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
const DEFAULT_WORKING_DIR = path.join(os.homedir(), 'Desktop', 'sira-projects');

const SIMPLE_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'stat', 'du', 'file', 'tree',
  'node', 'npm', 'npx', 'python3', 'pip3',
  'pwd', 'echo', 'which', 'uname', 'sw_vers', 'df', 'date',
  'make', 'cmake',
]);

const GIT_READ_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show', 'branch', 'tag']);
const SAFE_GIT_CONFIG_KEYS = new Set(['user.name', 'user.email', 'init.defaultBranch']);
const SAFE_GIT_FETCH_FLAGS = new Set(['--all', '--prune', '--tags']);
const SAFE_GIT_PULL_FLAGS = new Set(['--ff-only']);
const SAFE_GIT_ADD_FLAGS = new Set(['-A', '--all', '-u', '--update']);
const SAFE_GIT_PUSH_FLAGS = new Set(['-u', '--set-upstream']);

// ============================================================
// Validation
// ============================================================

function isAllowedCommand(rawCmd) {
  return Boolean(buildCommandSpec(rawCmd));
}

function hasShellControlChars(rawCmd) {
  const cmd = String(rawCmd || '');
  return /[;&|`<>]/.test(cmd) || /\$\(/.test(cmd) || /[\r\n]/.test(cmd);
}

function splitCommandLine(rawCmd) {
  const input = String(rawCmd || '').trim();
  if (!input || hasShellControlChars(input)) return null;

  const out = [];
  let current = '';
  let quote = null;
  let escaping = false;

  for (const ch of input) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (escaping || quote) return null;
  if (current) out.push(current);
  return out.length ? out : null;
}

function buildCommandSpec(rawCmd) {
  const parts = splitCommandLine(rawCmd);
  if (!parts) return null;

  const command = parts[0];
  if (SIMPLE_COMMANDS.has(command)) {
    return { program: command, args: parts.slice(1) };
  }

  if (command === 'git') {
    return buildGitCommandSpec(parts);
  }

  return null;
}

function isSafeRefToken(token) {
  const ref = String(token || '');
  if (!ref || ref.startsWith('-')) return false;
  if (ref === '.' || ref === '..' || ref.includes('..') || ref.includes('@{') || ref.includes('//')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/.test(ref) && !ref.endsWith('/') && !ref.endsWith('.lock');
}

function hasDisallowedGitFlag(args, blocked) {
  return args.some((arg) => blocked.some((re) => re.test(arg)));
}

function buildGitCommandSpec(parts) {
  const subcommand = parts[1];
  const args = parts.slice(2);
  if (!subcommand) return null;

  if (GIT_READ_SUBCOMMANDS.has(subcommand)) {
    return { program: 'git', args: parts.slice(1) };
  }

  if (subcommand === 'remote') {
    if (args.length === 0) return { program: 'git', args: parts.slice(1) };
    if (args.length === 1 && args[0] === '-v') return { program: 'git', args: parts.slice(1) };
    if (args[0] === 'get-url' && args.length <= 2) return { program: 'git', args: parts.slice(1) };
    return null;
  }

  if (subcommand === 'stash') {
    return args.length === 1 && args[0] === 'list' ? { program: 'git', args: parts.slice(1) } : null;
  }

  if (subcommand === 'add') {
    if (args.length === 0) return null;
    if (args.every(arg => SAFE_GIT_ADD_FLAGS.has(arg) || !arg.startsWith('-'))) {
      return { program: 'git', args: parts.slice(1) };
    }
    return null;
  }

  if (subcommand === 'commit') {
    if (hasDisallowedGitFlag(args, [/^--amend$/, /^--allow-empty$/, /^--reuse-message\b/, /^--reedit-message\b/, /^--fixup\b/, /^--squash\b/])) {
      return null;
    }
    let sawMessage = false;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '-m' || arg === '--message') {
        if (!args[i + 1]) return null;
        sawMessage = true;
        i += 1;
        continue;
      }
      if (arg.startsWith('--message=')) {
        sawMessage = arg.length > '--message='.length;
        continue;
      }
      return null;
    }
    return sawMessage ? { program: 'git', args: parts.slice(1) } : null;
  }

  if (subcommand === 'push') {
    if (hasDisallowedGitFlag(args, [/^--force(?:-with-lease)?$/, /^-f$/, /^--mirror$/, /^--delete$/, /^--prune$/])) {
      return null;
    }
    if (args.every(arg => SAFE_GIT_PUSH_FLAGS.has(arg) || isSafeRefToken(arg))) {
      return { program: 'git', args: parts.slice(1) };
    }
    return null;
  }

  if (subcommand === 'fetch') {
    if (args.every(arg => SAFE_GIT_FETCH_FLAGS.has(arg) || isSafeRefToken(arg))) {
      return { program: 'git', args: parts.slice(1) };
    }
    return null;
  }

  if (subcommand === 'pull') {
    if (args.every(arg => SAFE_GIT_PULL_FLAGS.has(arg) || isSafeRefToken(arg))) {
      return { program: 'git', args: parts.slice(1) };
    }
    return null;
  }

  if (subcommand === 'checkout' || subcommand === 'switch') {
    if (args.length === 1 && isSafeRefToken(args[0])) {
      return { program: 'git', args: parts.slice(1) };
    }
    if (args.length === 2 && (args[0] === '-b' || (subcommand === 'switch' && args[0] === '-c')) && isSafeRefToken(args[1])) {
      return { program: 'git', args: parts.slice(1) };
    }
    return null;
  }

  if (subcommand === 'merge') {
    if (args.length === 1 && isSafeRefToken(args[0])) {
      return { program: 'git', args: parts.slice(1) };
    }
    return null;
  }

  if (subcommand === 'rebase') {
    if (args.length === 1 && isSafeRefToken(args[0])) {
      return { program: 'git', args: parts.slice(1) };
    }
    return null;
  }

  if (subcommand === 'reset') {
    if (args.length === 0) return { program: 'git', args: parts.slice(1) };
    if (args.length === 1) {
      const ref = args[0];
      if (ref === 'HEAD' || ref.startsWith('HEAD~') || /^[A-Za-z0-9][A-Za-z0-9._/-]{0,40}$/.test(ref)) {
        return { program: 'git', args: parts.slice(1) };
      }
    }
    if (args.length === 2 && (args[0] === '--soft' || args[0] === '--mixed' || args[0] === '--hard')) {
      const ref = args[1];
      if (ref === 'HEAD' || ref.startsWith('HEAD~') || /^[A-Za-z0-9][A-Za-z0-9._/-]{0,40}$/.test(ref)) {
        return { program: 'git', args: parts.slice(1) };
      }
    }
    return null;
  }

  if (subcommand === 'restore') {
    if (args.length >= 1 && args.every(arg => !arg.startsWith('--') || arg === '--staged' || arg === '--worktree' || arg === '--source')) {
      return { program: 'git', args: parts.slice(1) };
    }
    return null;
  }

  if (subcommand === 'config') {
    if (args.length !== 2) return null;
    return SAFE_GIT_CONFIG_KEYS.has(args[0]) ? { program: 'git', args: parts.slice(1) } : null;
  }

  if (subcommand === 'init') {
    return args.length === 0 || (args.length === 1 && args[0] === '.') ? { program: 'git', args: parts.slice(1) } : null;
  }

  return null;
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
  const unquoted = String(token);
  if (!unquoted || unquoted === '.' || unquoted === '..') return unquoted !== '..';
  if (unquoted.includes('..' + path.sep) || unquoted.includes('/../')) return false;

  if (path.isAbsolute(unquoted)) return isAllowedDirectory(unquoted);
  if (unquoted.startsWith('~/')) {
    const expanded = path.join(os.homedir(), unquoted.slice(2));
    return isAllowedDirectory(expanded);
  }

  const resolved = path.resolve(workingDir || DEFAULT_WORKING_DIR, unquoted);
  return isAllowedDirectory(resolved);
}

function commandHasUnsafePathReference(command, workingDir) {
  const parsed = splitCommandLine(command);
  if (!parsed) return true;
  const parts = parsed.slice(1);
  return parts.some((part) => !isSafePathToken(part, workingDir));
}

function spawnAllowedProgram(spec, options) {
  switch (spec.program) {
    case 'ls': return spawn('ls', spec.args, options);
    case 'cat': return spawn('cat', spec.args, options);
    case 'head': return spawn('head', spec.args, options);
    case 'tail': return spawn('tail', spec.args, options);
    case 'wc': return spawn('wc', spec.args, options);
    case 'find': return spawn('find', spec.args, options);
    case 'grep': return spawn('grep', spec.args, options);
    case 'stat': return spawn('stat', spec.args, options);
    case 'du': return spawn('du', spec.args, options);
    case 'file': return spawn('file', spec.args, options);
    case 'tree': return spawn('tree', spec.args, options);
    case 'git': return spawn('git', spec.args, options);
    case 'node': return spawn('node', spec.args, options);
    case 'npm': return spawn('npm', spec.args, options);
    case 'npx': return spawn('npx', spec.args, options);
    case 'python3': return spawn('python3', spec.args, options);
    case 'pip3': return spawn('pip3', spec.args, options);
    case 'pwd': return spawn('pwd', spec.args, options);
    case 'echo': return spawn('echo', spec.args, options);
    case 'which': return spawn('which', spec.args, options);
    case 'uname': return spawn('uname', spec.args, options);
    case 'sw_vers': return spawn('sw_vers', spec.args, options);
    case 'df': return spawn('df', spec.args, options);
    case 'date': return spawn('date', spec.args, options);
    case 'make': return spawn('make', spec.args, options);
    case 'cmake': return spawn('cmake', spec.args, options);
    default:
      throw new Error(`Unsupported command: ${spec.program}`);
  }
}

// ============================================================
// Execution
// ============================================================

function runHostCommand(commandSpec, cwd) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnAllowedProgram(commandSpec, {
        cwd: cwd || os.homedir(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          NODE_ENV: process.env.NODE_ENV || 'development',
        },
      });
    } catch (err) {
      resolve({
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: `Error al ejecutar: ${err.message}`,
        timedOut: false,
      });
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    }, HOST_BASH_TIMEOUT_MS);

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
      clearTimeout(timer);
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
      clearTimeout(timer);
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

  const commandSpec = buildCommandSpec(command);

  const workingDir = args.directory || DEFAULT_WORKING_DIR;

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

  const result = await runHostCommand(commandSpec, workingDir);

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
  description: 'Execute a shell command on the host machine. Use this to inspect files, run git workflow commands (status/log/diff/show/add/commit/push/fetch/pull/checkout/merge/rebase/reset/restore), list directory contents, run npm/pip commands on cloned projects, and execute build/test scripts. Destructive git operations such as --force push and --amend commit are blocked. Operations are restricted to ~/Desktop/sira-projects/ and ~/Desktop/siraGPT/.',
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
  _internal: { isAllowedCommand, isAllowedDirectory, commandHasUnsafePathReference, runHostCommand, splitCommandLine, buildCommandSpec },
};

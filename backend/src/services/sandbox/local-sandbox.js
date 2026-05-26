'use strict';

/**
 * local-sandbox — bounded child_process executor for cases where
 * the operator does not run E2B (services/sandbox/e2b-sandbox.js).
 *
 * What this is:
 *   A "best-effort" guard rail. It enforces:
 *     - language allowlist (python / node / bash)
 *     - process-level timeout via AbortController + SIGKILL
 *     - stdout/stderr byte cap with truncation flag
 *     - no shell interpolation (spawn + arg array, never exec)
 *     - hard kill of the child on timeout / abort signal
 *
 * What this is NOT:
 *   A security sandbox. The child still runs with the parent
 *   process's user permissions. If the operator needs strict
 *   isolation, route through E2B (or wrap a Docker / firejail /
 *   seatbelt invocation in `command` themselves). The interface
 *   matches e2b-sandbox.executeCode so a future router can pick the
 *   strongest available backend transparently.
 *
 * Public API:
 *   resolveLocalConfig(env)                    env → config (pure)
 *   executeLocal(args, env?, opts?)            run code under guards
 *   isLocalSandboxAvailable(env, language)     env probe (no spawn)
 *   ALLOWED_LANGUAGES                          frozen set
 */

const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 30_000;
const HARD_MAX_TIMEOUT_MS = 5 * 60_000;
const MIN_TIMEOUT_MS = 100;

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB per stream
const HARD_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

const ALLOWED_LANGUAGES = Object.freeze(new Set(['python', 'node', 'bash']));

// Language → { interpreter, code-flag }. We pass user code as a single
// argv element so the shell never sees it — no quoting, no injection,
// even if the code contains `; rm -rf /` or backticks.
const INTERPRETERS = Object.freeze({
  python: () => [process.env.PYTHON_BIN || 'python3', ['-c']],
  node:   () => [process.env.NODE_BIN || process.execPath, ['-e']],
  bash:   () => [process.env.BASH_BIN || 'bash', ['-c']],
});

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function resolveLocalConfig(env = process.env) {
  const enabled = parseBoolean(env.LOCAL_SANDBOX_ENABLED, true);
  return {
    enabled,
    defaultTimeoutMs: clampInt(env.LOCAL_SANDBOX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, HARD_MAX_TIMEOUT_MS),
    maxOutputBytes: clampInt(env.LOCAL_SANDBOX_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES, 1024, HARD_MAX_OUTPUT_BYTES),
    pythonBin: env.PYTHON_BIN || 'python3',
    nodeBin: env.NODE_BIN || process.execPath,
    bashBin: env.BASH_BIN || 'bash',
  };
}

function isLocalSandboxAvailable(env = process.env, language = 'python') {
  const cfg = resolveLocalConfig(env);
  if (!cfg.enabled) return false;
  return ALLOWED_LANGUAGES.has(String(language || '').toLowerCase());
}

/**
 * Run user code under the local sandbox.
 *
 * Discriminated-union result mirrors e2b-sandbox.executeCode so a
 * router can dispatch to either backend without branching the caller.
 *
 * @param {object} args
 * @param {string} args.code         user-supplied source
 * @param {string} [args.language='python']
 * @param {number} [args.timeoutMs]  deadline (clamped)
 * @param {number} [args.maxOutputBytes]
 * @param {object} [env]             defaults to process.env
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] external cancel
 * @param {Function} [opts.spawnImpl] override child_process.spawn (tests)
 */
async function executeLocal(args = {}, env = process.env, opts = {}) {
  const cfg = resolveLocalConfig(env);
  if (!cfg.enabled) {
    return { ok: false, code: 'sandbox_disabled', message: 'local sandbox disabled (set LOCAL_SANDBOX_ENABLED=1)' };
  }

  const language = String(args.language || 'python').toLowerCase();
  if (!ALLOWED_LANGUAGES.has(language)) {
    return {
      ok: false,
      code: 'sandbox_language_not_allowed',
      message: `language "${language}" not allowed; supported: ${Array.from(ALLOWED_LANGUAGES).join(', ')}`,
    };
  }
  const code = String(args.code || '');
  if (!code.trim()) {
    return { ok: false, code: 'sandbox_empty_code', message: 'code is required' };
  }

  const timeoutMs = clampInt(args.timeoutMs, cfg.defaultTimeoutMs, MIN_TIMEOUT_MS, HARD_MAX_TIMEOUT_MS);
  const maxOutputBytes = clampInt(args.maxOutputBytes, cfg.maxOutputBytes, 1024, HARD_MAX_OUTPUT_BYTES);

  const [bin, baseArgs] = INTERPRETERS[language]();
  const argv = [...baseArgs, code];
  const spawnImpl = typeof opts.spawnImpl === 'function' ? opts.spawnImpl : spawn;

  const startedAt = Date.now();
  let child;
  try {
    child = spawnImpl(bin, argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // No `shell: true` — the code is one argv element, the shell
      // never parses it.
      env: { ...env, NODE_OPTIONS: '' },
    });
  } catch (err) {
    return { ok: false, code: 'sandbox_spawn_failed', message: err && err.message };
  }

  return new Promise((resolve) => {
    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let killedReason = null;
    let timer = null;
    let externalAbortHandler = null;

    function appendCapped(buf, chunk, which) {
      const remaining = Math.max(0, maxOutputBytes - buf.length);
      if (remaining === 0) {
        if (which === 'stdout') stdoutTruncated = true;
        else stderrTruncated = true;
        return buf;
      }
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      const next = Buffer.concat([buf, slice]);
      if (chunk.length > remaining) {
        if (which === 'stdout') stdoutTruncated = true;
        else stderrTruncated = true;
      }
      return next;
    }

    if (child.stdout) {
      child.stdout.on('data', (chunk) => { stdoutBuf = appendCapped(stdoutBuf, chunk, 'stdout'); });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => { stderrBuf = appendCapped(stderrBuf, chunk, 'stderr'); });
    }

    function killChild(reason) {
      if (killedReason) return;
      killedReason = reason;
      try { child.kill('SIGKILL'); } catch { /* swallow */ }
    }

    timer = setTimeout(() => killChild('timeout'), timeoutMs);

    if (opts.signal) {
      if (opts.signal.aborted) {
        killChild('aborted');
      } else {
        externalAbortHandler = () => killChild('aborted');
        opts.signal.addEventListener('abort', externalAbortHandler, { once: true });
      }
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (externalAbortHandler && opts.signal) {
        try { opts.signal.removeEventListener('abort', externalAbortHandler); } catch { /* ignore */ }
      }
      resolve({
        ok: false,
        code: 'sandbox_runtime_error',
        message: err && err.message,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on('close', (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      if (externalAbortHandler && opts.signal) {
        try { opts.signal.removeEventListener('abort', externalAbortHandler); } catch { /* ignore */ }
      }
      const durationMs = Date.now() - startedAt;
      const stdout = stdoutBuf.toString('utf8');
      const stderr = stderrBuf.toString('utf8');

      if (killedReason === 'timeout') {
        resolve({
          ok: false,
          code: 'sandbox_timeout',
          message: `local sandbox killed after ${durationMs}ms (deadline ${timeoutMs}ms)`,
          stdout, stderr,
          stdoutTruncated, stderrTruncated,
          durationMs,
        });
        return;
      }
      if (killedReason === 'aborted') {
        resolve({
          ok: false,
          code: 'sandbox_aborted',
          message: 'local sandbox aborted by caller signal',
          stdout, stderr,
          stdoutTruncated, stderrTruncated,
          durationMs,
        });
        return;
      }

      resolve({
        ok: true,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        exitCode: typeof exitCode === 'number' ? exitCode : null,
        signal: signal || null,
        durationMs,
      });
    });
  });
}

module.exports = {
  executeLocal,
  isLocalSandboxAvailable,
  resolveLocalConfig,
  ALLOWED_LANGUAGES,
  DEFAULT_TIMEOUT_MS,
  HARD_MAX_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
};

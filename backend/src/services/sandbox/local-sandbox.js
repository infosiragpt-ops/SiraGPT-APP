'use strict';

/**
 * local-sandbox — bounded child_process executor for cases where
 * the operator does not run E2B or the remote Docker sandbox.
 *
 * Guards enforced:
 *   - language allowlist (python / node / bash)
 *   - process-level concurrency semaphore (default 12, env-configurable)
 *   - process-level timeout via SIGKILL
 *   - stdout/stderr byte cap with truncation flag
 *   - no shell interpolation (spawn + arg array, never exec)
 *   - Python memory cap via resource.setrlimit preamble (512 MiB)
 *   - working-directory pinned to session workdir (cwd option)
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

// ---------------------------------------------------------------------------
// Concurrency semaphore — prevents >N simultaneous child processes
// regardless of how many parallel sandbox_bash tool calls arrive.
// ---------------------------------------------------------------------------
class Semaphore {
  constructor(limit) {
    this._limit = limit;
    this._count = 0;
    this._queue = [];
  }

  /** Resolves when a slot is free; optionally rejects after deadlineMs. */
  acquire(deadlineMs) {
    if (this._count < this._limit) {
      this._count++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let timer;
      const entry = { resolve, reject };
      this._queue.push(entry);
      if (deadlineMs != null && Number.isFinite(deadlineMs) && deadlineMs > 0) {
        timer = setTimeout(() => {
          const idx = this._queue.indexOf(entry);
          if (idx !== -1) this._queue.splice(idx, 1);
          reject(Object.assign(new Error('sandbox_queue_timeout'), { code: 'sandbox_queue_timeout' }));
        }, deadlineMs);
        entry._timer = timer;
      }
    });
  }

  release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      if (next._timer) clearTimeout(next._timer);
      next.resolve();
    } else {
      this._count = Math.max(0, this._count - 1);
    }
  }
}

const DEFAULT_CONCURRENCY = 12;

// Module-level singleton — shared across all executeLocal calls in this process.
let _sem = null;
function getSemaphore(limit) {
  if (!_sem || _sem._limit !== limit) _sem = new Semaphore(limit);
  return _sem;
}

// Python preamble: cap virtual address space to 512 MiB before user code runs.
// Uses the Python `resource` module (POSIX only; silently skipped on Windows).
const PYTHON_RESOURCE_PREAMBLE = `
import resource as _r, sys as _sys
try:
    _LIMIT = 512 * 1024 * 1024
    _r.setrlimit(_r.RLIMIT_AS, (_LIMIT, _LIMIT))
except Exception:
    pass
del _r
`.trimStart();

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
    concurrency: clampInt(env.LOCAL_SANDBOX_CONCURRENCY, DEFAULT_CONCURRENCY, 1, 256),
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

  // Prepend memory-limit preamble for Python to contain runaway allocations.
  const finalCode = language === 'python' ? PYTHON_RESOURCE_PREAMBLE + code : code;

  const [bin, baseArgs] = INTERPRETERS[language]();
  const argv = [...baseArgs, finalCode];
  const spawnImpl = typeof opts.spawnImpl === 'function' ? opts.spawnImpl : spawn;

  // Acquire a concurrency slot before spawning.  The deadline is half the
  // execution timeout so a queued call still has time to run if it gets through.
  const sem = getSemaphore(cfg.concurrency);
  const queueDeadlineMs = Math.max(1000, timeoutMs / 2);
  try {
    await sem.acquire(queueDeadlineMs);
  } catch (err) {
    return {
      ok: false,
      code: 'sandbox_queue_timeout',
      message: `sandbox is at capacity (${cfg.concurrency} concurrent processes); try again shortly`,
    };
  }

  const startedAt = Date.now();
  let child;
  try {
    child = spawnImpl(bin, argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // No `shell: true` — the code is one argv element, the shell never sees it.
      env: { ...env, NODE_OPTIONS: '' },
      // Pin child cwd to the session workdir when provided so scripts can
      // open('./file.docx') without absolute paths.
      // Accepts both args.cwd (standard) and args.workdir (sandbox-doc-tools alias).
      ...(args.cwd || args.workdir ? { cwd: args.cwd || args.workdir } : {}),
    });
  } catch (err) {
    sem.release();
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
      sem.release();
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
      sem.release();
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

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
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

const DEFAULT_TIMEOUT_MS = 30_000;
const HARD_MAX_TIMEOUT_MS = 5 * 60_000;
const MIN_TIMEOUT_MS = 100;

// ---------------------------------------------------------------------------
// Child env allowlist. The backend process env carries credentials
// (DATABASE_URL, R2/API tokens, CODE_RUNNER_CONTROL_TOKEN, …); handing the
// whole thing to untrusted user code turns sandbox_bash into an exfiltration
// primitive. Only a minimal allowlist crosses the boundary; anything that
// smells like a secret is dropped even if allowlisted.
// ---------------------------------------------------------------------------
const ENV_ALLOWLIST = [
  'PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'PYTHONPATH', 'PYTHONUSERBASE', 'PYTHONHOME', 'VIRTUAL_ENV',
  'NODE_PATH',
];

const SENSITIVE_ENV_RE = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|DATABASE_URL|REDIS|SMTP/i;

function buildChildEnv(env) {
  const source = env || process.env;
  const childEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0 && !SENSITIVE_ENV_RE.test(key)) {
      childEnv[key] = value;
    }
  }
  childEnv.HOME = path.join(os.tmpdir(), 'sira-home');
  childEnv.NODE_OPTIONS = '';
  return childEnv;
}

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

// Session workdirs we are allowed to reap (sira-sbx-* under os.tmpdir()).
const registeredSandboxWorkdirs = [];

function registerLocalSandboxWorkdir(dir, opts) {
  try {
    const w61 = require('../agent-runner/engine-3h61');
    if (typeof w61.registerSandboxWorkdirClosed === 'function') {
      return w61.registerSandboxWorkdirClosed(registeredSandboxWorkdirs, dir, opts);
    }
  } catch (_) { /* 3H61 fail-open */ }
  return { registered: false, path: dir == null ? '' : String(dir) };
}

function reapLocalSandboxOrphans(opts = {}) {
  try {
    const w61 = require('../agent-runner/engine-3h61');
    if (typeof w61.reapOrphanSandboxDirsClosed === 'function') {
      return w61.reapOrphanSandboxDirsClosed(registeredSandboxWorkdirs, opts);
    }
  } catch (_) { /* 3H61 fail-open */ }
  return { reap: [], removed: [], count: 0, code: null };
}

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

  const [bin0, baseArgs] = INTERPRETERS[language]();
  let bin = bin0;
  let argv = [...baseArgs, finalCode];
  const spawnImpl = typeof opts.spawnImpl === 'function' ? opts.spawnImpl : spawn;
  let sandboxGuards = null;
  try {
    const w64 = require('../agent-runner/engine-3h64');
    const ad = require('../agent-runner/engine-adapter');
    if (typeof w64.applySandboxSpawnGuardsClosed === 'function') {
      sandboxGuards = w64.applySandboxSpawnGuardsClosed({
        bin: bin,
        argv: argv,
        env: env,
        sandboxKillAfterGraceMs: ad.sandboxKillAfterGraceMs,
        sandboxNetFailClosed: ad.sandboxNetFailClosed,
        sandboxNoNewPrivs: ad.sandboxNoNewPrivs,
        wrapSandboxSpawnWithRssCpu: ad.wrapSandboxSpawnWithRssCpu,
        tmpCleanupOnCancel: ad.tmpCleanupOnCancel,
        reapBackgroundBashOnAbort: ad.reapBackgroundBashOnAbort,
        pollBackgroundBash: ad.pollBackgroundBash,
      });
      // wrapSandboxSpawnWithRssCpu uses `ulimit -v` (virtual address
      // space). V8 reserves multi-GB ranges, so applying the wrap to
      // the node interpreter FatalOOMs. Still call the live helper;
      // only apply bash+ulimit to python/bash.
      const looksLikeNode = /node(\.exe)?$/i.test(String(bin0))
        || bin0 === process.execPath;
      if (sandboxGuards && sandboxGuards.bin && Array.isArray(sandboxGuards.argv) && !looksLikeNode) {
        bin = sandboxGuards.bin;
        argv = sandboxGuards.argv;
      }
    }
  } catch (_) { /* 3H64 spawn wrap fail-open */ }

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

  const startedAt = performance.now();
  const elapsedMs = () => Math.max(0, Math.round(performance.now() - startedAt));
  const sessionWorkdir = args.cwd || args.workdir || null;
  if (sessionWorkdir) registerLocalSandboxWorkdir(sessionWorkdir);
  try { reapLocalSandboxOrphans({ now: Date.now() }); } catch (_) { /* best-effort */ }
  let child;
  try {
    child = spawnImpl(bin, argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // No `shell: true` — the code is one argv element, the shell never sees it.
      env: buildChildEnv(env),
      // Pin child cwd to the session workdir when provided so scripts can
      // open('./file.docx') without absolute paths.
      // Accepts both args.cwd (standard) and args.workdir (sandbox-doc-tools alias).
      ...(args.cwd || args.workdir ? { cwd: args.cwd || args.workdir } : {}),
    });
  } catch (err) {
    sem.release();
    return { ok: false, code: 'sandbox_spawn_failed', message: err && err.message };
  }
  try {
    const w66bg = require('../agent-runner/engine-3h66');
    const adBg = require('../agent-runner/engine-adapter');
    if (w66bg && typeof w66bg.applyReadHygieneClosed === 'function') {
      w66bg.applyReadHygieneClosed({
        bashId: child && child.pid,
        cmd: String(language || 'bash'),
        kill: function () { try { if (child) child.kill('SIGKILL'); } catch (_) { /* swallow */ } },
        stripUtf8BomOnRead: adBg.stripUtf8BomOnRead,
        sliceReadWindow: adBg.sliceReadWindow,
        formatReadWithLineNumbers: adBg.formatReadWithLineNumbers,
        startBackgroundBash: adBg.startBackgroundBash,
        resetBackgroundBash: adBg.resetBackgroundBash,
      });
    }
  } catch (_) { /* 3H66 bash track fail-open */ }

  return new Promise((resolve) => {
    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let killedReason = null;
    let timer = null;
    let externalAbortHandler = null;

    function appendCapped(buf, chunk, which) {
      try {
        const w60 = require('../agent-runner/engine-3h60');
        if (typeof w60.sandboxStreamChunkCap === 'function') {
          const capped = w60.sandboxStreamChunkCap({
            chunk,
            used: buf.length,
            cap: maxOutputBytes,
          });
          if (capped && capped.truncated) {
            if (which === 'stdout') stdoutTruncated = true;
            else stderrTruncated = true;
          }
          if (capped && capped.chunk) {
            return Buffer.concat([buf, Buffer.from(capped.chunk)]);
          }
        }
      } catch (_) { /* 3H60 fail-open */ }
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

    function releaseChild() {
      try { if (child.stdout) child.stdout.removeAllListeners(); } catch (_) { /* ignore */ }
      try { if (child.stderr) child.stderr.removeAllListeners(); } catch (_) { /* ignore */ }
      try { child.removeAllListeners(); } catch (_) { /* ignore */ }
      try { if (child.stdout && !child.stdout.destroyed) child.stdout.destroy(); } catch (_) { /* ignore */ }
      try { if (child.stderr && !child.stderr.destroyed) child.stderr.destroy(); } catch (_) { /* ignore */ }
      try { if (typeof child.unref === 'function') child.unref(); } catch (_) { /* ignore */ }
    }

    function killChild(reason) {
      if (killedReason) return;
      killedReason = reason;
      try {
        const adKill = require('../agent-runner/engine-adapter');
        if (typeof adKill.sandboxKillAfterGraceMs === 'function') {
          adKill.sandboxKillAfterGraceMs({
            pid: (child && child.pid) || 1,
            graceMs: 20,
            killFn: function (_id, sig) {
              try { child.kill(sig || 'SIGKILL'); } catch (_) { /* swallow */ }
            },
            setTimeoutFn: setTimeout,
          });
        } else {
          try { child.kill('SIGKILL'); } catch { /* swallow */ }
        }
      } catch (_) {
        try { child.kill('SIGKILL'); } catch { /* swallow */ }
      }
      if (reason === 'aborted') {
        try {
          const w60 = require('../agent-runner/engine-3h60');
          if (typeof w60.sandboxFinallyCleanupOnAbort === 'function') {
            w60.sandboxFinallyCleanupOnAbort({
              aborted: true,
              workdir: args.cwd || args.workdir || null,
              pid: child && child.pid,
            });
          }
        } catch (_) { /* 3H60 fail-open */ }
        try {
          const w66r = require('../agent-runner/engine-3h66');
          const adR = require('../agent-runner/engine-adapter');
          if (w66r && typeof w66r.applyReadHygieneClosed === 'function') {
            w66r.applyReadHygieneClosed({
              reset: true,
              stripUtf8BomOnRead: adR.stripUtf8BomOnRead,
              sliceReadWindow: adR.sliceReadWindow,
              formatReadWithLineNumbers: adR.formatReadWithLineNumbers,
              startBackgroundBash: adR.startBackgroundBash,
              resetBackgroundBash: adR.resetBackgroundBash,
            });
          }
        } catch (_) { /* 3H66 bash reset fail-open */ }
      }
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
      releaseChild();
      if (externalAbortHandler && opts.signal) {
        try { opts.signal.removeEventListener('abort', externalAbortHandler); } catch { /* ignore */ }
      }
      resolve({
        ok: false,
        code: 'sandbox_runtime_error',
        message: err && err.message,
        durationMs: elapsedMs(),
      });
    });

    child.on('close', (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      sem.release();
      if (externalAbortHandler && opts.signal) {
        try { opts.signal.removeEventListener('abort', externalAbortHandler); } catch { /* ignore */ }
      }
      let durationMs = elapsedMs();
      let stdout = stdoutBuf.toString('utf8');
      let stderr = stderrBuf.toString('utf8');
      try {
        const w67out = require('../agent-runner/engine-3h67');
        const adOut = require('../agent-runner/engine-adapter');
        if (typeof w67out.applySandboxOutCapClosed === 'function') {
          const capped = w67out.applySandboxOutCapClosed({
            stdout,
            stderr,
            stripAnsiFromSandboxOut: adOut.stripAnsiFromSandboxOut,
            stderrByteCapPerCommand: adOut.stderrByteCapPerCommand,
            stdoutByteCapPerCommand: adOut.stdoutByteCapPerCommand,
            combinedStdoutStderr96KiB: adOut.combinedStdoutStderr96KiB,
            capStdoutLine8KiB: adOut.capStdoutLine8KiB,
          });
          if (capped) {
            if (capped.stdout != null) stdout = capped.stdout;
            if (capped.stderr != null) stderr = capped.stderr;
            if (capped.truncated) {
              stdoutTruncated = true;
              stderrTruncated = true;
            }
          }
        }
      } catch (_) { /* 3H67 sandbox out cap fail-open */ }
      releaseChild();

      if (killedReason === 'timeout') {
        durationMs = Math.max(durationMs, timeoutMs);
        let cleaned = null;
        try {
          const w61 = require('../agent-runner/engine-3h61');
          if (typeof w61.cleanupSandboxOnTimeoutClosed === 'function') {
            cleaned = w61.cleanupSandboxOnTimeoutClosed({
              elapsedMs: durationMs,
              timeoutMs,
              workdir: sessionWorkdir,
            });
          } else {
            const w59 = require('../agent-runner/engine-3h59');
            if (typeof w59.sandboxTimeoutThenCleanup === 'function') {
              cleaned = w59.sandboxTimeoutThenCleanup({
                elapsedMs: durationMs,
                timeoutMs,
                workdir: sessionWorkdir,
              });
            }
          }
        } catch (_) { /* 3H61/3H59 fail-open */ }
        if (sessionWorkdir) {
          try {
            const idx = registeredSandboxWorkdirs.findIndex((d) => {
              const p = typeof d === 'string' ? d : d && d.path;
              return p === sessionWorkdir;
            });
            if (idx !== -1) registeredSandboxWorkdirs[idx] = {
              path: sessionWorkdir,
              mtimeMs: Date.now(),
              orphan: true,
            };
          } catch (_) { /* ignore */ }
        }
        resolve({
          ok: false,
          code: 'sandbox_timeout',
          message: `local sandbox killed after ${durationMs}ms (deadline ${timeoutMs}ms)`,
          stdout, stderr,
          stdoutTruncated, stderrTruncated,
          durationMs,
          cleaned: Boolean(cleaned && cleaned.cleanup),
          cleanupCode: cleaned && cleaned.code,
        });
        return;
      }
      if (killedReason === 'aborted') {
        try {
          const w64ab = require('../agent-runner/engine-3h64');
          const adAb = require('../agent-runner/engine-adapter');
          if (typeof w64ab.applySandboxSpawnGuardsClosed === 'function') {
            w64ab.applySandboxSpawnGuardsClosed({
              aborted: true,
              dirs: sessionWorkdir ? [sessionWorkdir] : [],
              pid: child && child.pid,
              sandboxKillAfterGraceMs: adAb.sandboxKillAfterGraceMs,
              sandboxNetFailClosed: adAb.sandboxNetFailClosed,
              sandboxNoNewPrivs: adAb.sandboxNoNewPrivs,
              wrapSandboxSpawnWithRssCpu: adAb.wrapSandboxSpawnWithRssCpu,
              tmpCleanupOnCancel: adAb.tmpCleanupOnCancel,
              reapBackgroundBashOnAbort: adAb.reapBackgroundBashOnAbort,
              pollBackgroundBash: adAb.pollBackgroundBash,
            });
          }
        } catch (_) { /* 3H64 abort cleanup fail-open */ }
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
  buildChildEnv,
  registerLocalSandboxWorkdir,
  reapLocalSandboxOrphans,
  ALLOWED_LANGUAGES,
  DEFAULT_TIMEOUT_MS,
  HARD_MAX_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
};

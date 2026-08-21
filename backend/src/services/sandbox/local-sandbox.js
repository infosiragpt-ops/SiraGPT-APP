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
try { require('../agent-runner/engine-correctness').orphanTmpReaperOnStart(); } catch (_) {}
const { performance } = require('perf_hooks');

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

  let resilience = null;
  try { resilience = require('../agent-runner/engine-resilience'); } catch (_) { resilience = null; }
  const limits = resilience && typeof resilience.resolveSandboxLimits === 'function'
    ? resilience.resolveSandboxLimits()
    : { rssBytes: 512 * 1024 * 1024, cpuSec: 30, method: 'rlimit_fallback', usesRunsc: false, interpreter: 'local', umask: 0o077 };
  const preamble = language === 'python'
    ? ((resilience && resilience.pythonRlimitPreamble)
      ? resilience.pythonRlimitPreamble({ rssBytes: limits.rssBytes, cpuSec: limits.cpuSec })
      : PYTHON_RESOURCE_PREAMBLE)
    : '';
  const finalCode = language === 'python' ? preamble + code : code;

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

  const startedAt = performance.now();
  const elapsedMs = () => Math.max(0, Math.round(performance.now() - startedAt));
  let child;
  let runtime = null;
  try { runtime = require('../agent-runner/engine-runtime'); } catch (_) { runtime = null; }
  let lifecycle = null;
  try { lifecycle = require('../agent-runner/engine-lifecycle'); } catch (_) { lifecycle = null; }
  try {
    let childEnv = runtime && typeof runtime.scrubSandboxEnv === 'function'
      ? runtime.scrubSandboxEnv(env)
      : { PATH: env.PATH, HOME: env.HOME || '/tmp', TMPDIR: env.TMPDIR || '/tmp', LANG: env.LANG || 'C.UTF-8', NODE_OPTIONS: '' };
    try {
      const ad = require('../agent-runner/engine-adapter');
      if (ad && typeof ad.sanitizeSandboxEnvHard === 'function') childEnv = ad.sanitizeSandboxEnvHard(childEnv);
      if (ad && typeof ad.scrubSecretsFromChildEnv === 'function') {
        const scrubbed = ad.scrubSecretsFromChildEnv(childEnv);
        if (scrubbed && scrubbed.env) childEnv = scrubbed.env;
      }
      if (ad && typeof ad.envScrubLdPreload === 'function') {
        const ld = ad.envScrubLdPreload(childEnv);
        if (ld && ld.env) childEnv = ld.env;
      }
      if (ad && typeof ad.sandboxNetFailClosed === 'function') {
        const net = ad.sandboxNetFailClosed(env);
        if (net && net.ok === false) {
          if (args && (args.network || args.net || args.allowNet)) {
            sem.release();
            return { ok: false, code: 'network_denied', message: 'sandbox net deny-all (SANDBOX_NET_ALLOW unset)' };
          }
        }
      }
    } catch (_) {}
    const hints = resilience && typeof resilience.linuxSpawnHints === 'function'
      ? resilience.linuxSpawnHints()
      : { detached: process.platform !== 'win32', usesRunsc: false };
    const workdir = args.cwd || args.workdir || null;
    if (workdir && resilience && typeof resilience.registerSandboxTmp === 'function') {
      try { resilience.registerSandboxTmp(workdir); } catch (_) {}
    }
    try {
      const adUl = require('../agent-runner/engine-adapter');
      if (adUl && typeof adUl.wrapSandboxSpawnWithUlimit === 'function') {
        const wrapped = adUl.wrapSandboxSpawnWithUlimit(bin, argv, {});
        if (wrapped && wrapped.bin) {
          bin = wrapped.bin;
          argv = wrapped.argv;
        }
        if (adUl && typeof adUl.sandboxTmpfsHint === 'function') {
          try { adUl.sandboxTmpfsHint({ tmpdir: workdir || childEnv.TMPDIR || '/tmp' }); } catch (_) {}
        }
        if (adUl && typeof adUl.sandboxNoNewPrivs === 'function') {
          try {
            const nnp = adUl.sandboxNoNewPrivs({ bin, argv });
            if (nnp && nnp.bin) bin = nnp.bin;
            if (nnp && Array.isArray(nnp.argv) && nnp.argv.length) argv = nnp.argv;
          } catch (_) {}
        }
        if (adUl && typeof adUl.wrapSandboxSpawnWithRssCpu === 'function') {
          const rss = adUl.wrapSandboxSpawnWithRssCpu(bin, argv, {});
          if (rss && rss.bin) { bin = rss.bin; argv = rss.argv; }
        } else if (adUl && typeof adUl.sandboxRssCpuUlimit === 'function') {
          const rss = adUl.sandboxRssCpuUlimit({});
          if (rss && rss.prefix && Array.isArray(argv) && argv[0] === '-c' && argv[1]) {
            argv = [argv[0], rss.prefix + argv[1], ...argv.slice(2)];
          }
        }
      }
    } catch (_) {}
    child = spawnImpl(bin, argv, {
      stdio: hints.stdio || ['ignore', 'pipe', 'pipe'],
      // No `shell: true` — the code is one argv element, the shell never sees it.
      env: childEnv,
      detached: hints.detached !== false && process.platform !== 'win32',
      // Pin child cwd to the session workdir when provided so scripts can
      // open('./file.docx') without absolute paths.
      // Accepts both args.cwd (standard) and args.workdir (sandbox-doc-tools alias).
      ...(workdir ? { cwd: workdir } : {}),
    });
    try {
      if (args && args.background) {
        const adBg = require('../agent-runner/engine-adapter');
        const bgId = String(args.backgroundId || args.id || ('bg_' + Date.now()));
        const childRef = child;
        adBg.startBackgroundBash(bgId, {
          cmd: String(args.code || args.command || '').slice(0, 180),
          kill: () => {
            try {
              if (adBg && typeof adBg.killProcessGroup === 'function' && childRef && childRef.pid) {
                adBg.killProcessGroup(childRef.pid, { signal: 'SIGTERM' });
              } else if (childRef && !childRef.killed) childRef.kill('SIGTERM');
            } catch (_) {}
          },
        });
      }
    } catch (_) {}
  } catch (err) {
    sem.release();
    return { ok: false, code: 'sandbox_spawn', message: err && err.message };
  }

  return new Promise((resolve) => {
    const stdoutRing = resilience && resilience.createByteRing
      ? resilience.createByteRing(maxOutputBytes)
      : null;
    const stderrRing = resilience && resilience.createByteRing
      ? resilience.createByteRing(maxOutputBytes)
      : null;
    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let killedReason = null;
    let timer = null;
    let idleTimer = null;
    let lastByteAt = Date.now();
    let externalAbortHandler = null;
    let settled = false;
    const execHb = resilience && typeof resilience.startExecHeartbeat === 'function'
      ? resilience.startExecHeartbeat((frame) => {
        if (typeof opts.onHeartbeat === 'function') {
          try { opts.onHeartbeat(frame); } catch (_) {}
        }
        if (typeof opts.onChunk === 'function' && frame) {
          try { opts.onChunk('', 'heartbeat'); } catch (_) {}
        }
      }, { kind: 'sandbox', intervalMs: 5000 })
      : { stop() {} };

    function appendCapped(buf, chunk, which) {
      if (which === 'stdout' && stdoutRing) {
        const st = stdoutRing.push(chunk);
        stdoutTruncated = st.dropped > 0;
        return Buffer.from(stdoutRing.toString(), 'utf8');
      }
      if (which === 'stderr' && stderrRing) {
        const st = stderrRing.push(chunk);
        stderrTruncated = st.dropped > 0;
        return Buffer.from(stderrRing.toString(), 'utf8');
      }
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

    const chunkState = { seen: 0, startedAt: Date.now(), maxBytes: maxOutputBytes };
    let reapTimer = null;
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        lastByteAt = Date.now();
        stdoutBuf = appendCapped(stdoutBuf, chunk, 'stdout');
        if (runtime && typeof opts.onChunk === 'function') {
          try { runtime.emitStreamChunk(opts.onChunk, chunk, 'stdout', chunkState); } catch (_) {}
        }
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        lastByteAt = Date.now();
        stderrBuf = appendCapped(stderrBuf, chunk, 'stderr');
        if (runtime && typeof opts.onChunk === 'function') {
          try { runtime.emitStreamChunk(opts.onChunk, chunk, 'stderr', chunkState); } catch (_) {}
        }
      });
    }

    function killChild(reason) {
      if (killedReason) return;
      killedReason = reason;
      try {
        let adKill = null;
        try { adKill = require('../agent-runner/engine-adapter'); } catch (_) { adKill = null; }
        if (adKill && typeof adKill.sandboxKillAfterGraceMs === 'function' && child && child.pid) {
          adKill.sandboxKillAfterGraceMs({
            pid: child.pid,
            graceMs: 1500,
            killFn: (id, sig) => {
              try {
                if (sig === 'SIGTERM' && typeof adKill.killProcessGroup === 'function') {
                  adKill.killProcessGroup(id, { signal: 'SIGTERM' });
                } else if (sig === 'SIGKILL' && typeof adKill.killProcessGroup === 'function') {
                  adKill.killProcessGroup(id, { signal: 'SIGKILL' });
                } else if (child && !child.killed) child.kill(sig);
              } catch (_) {}
            },
          });
        } else if (adKill && typeof adKill.killProcessGroup === 'function' && child && child.pid) {
          adKill.killProcessGroup(child.pid, { signal: 'SIGKILL' });
        } else if (resilience && typeof resilience.killProcessGroup === 'function') {
          resilience.killProcessGroup(child.pid);
        } else if (runtime && typeof runtime.killProcessTree === 'function') {
          runtime.killProcessTree(child.pid);
        } else {
          child.kill('SIGKILL');
        }
      } catch { /* swallow */ }
      if (!reapTimer) {
        const grace = (runtime && runtime.REAP_GRACE_MS) || 1500;
        reapTimer = setTimeout(() => {
          try {
            if (settled) return;
            if (runtime && typeof runtime.shouldForceSettle === 'function') {
              const gate = runtime.shouldForceSettle({ killedAt: Date.now() - grace, now: Date.now(), closed: settled, graceMs: grace });
              if (!gate.settle) return;
            }
            child.emit('close', null, 'SIGKILL');
          } catch { /* swallow */ }
        }, grace);
        if (reapTimer && typeof reapTimer.unref === 'function') reapTimer.unref();
      }
    }

    timer = setTimeout(() => killChild('timeout'), timeoutMs);
    let rssTimer = null;
    if (lifecycle && typeof lifecycle.sandboxWatchdogTick === 'function') {
      const workdirReg = args.cwd || args.workdir;
      if (workdirReg) {
        try { lifecycle.registerTmpForCrashCleanup(workdirReg); } catch (_) {}
      }
      rssTimer = setInterval(() => {
        if (settled) return;
        let rssBytes = null;
        try {
          const rss = lifecycle.readLinuxRssBytes(child.pid);
          rssBytes = rss && rss.rssBytes;
        } catch (_) {}
        const tick = lifecycle.sandboxWatchdogTick({
          startedAt: Date.now() - elapsedMs(),
          now: Date.now(),
          wallMs: timeoutMs,
          rssBytes,
          rssLimit: (limits && limits.rssBytes) || lifecycle.RSS_DEFAULT_BYTES,
          pid: child.pid,
          kill: (id, sig) => {
            try {
              return lifecycle.termThenKill(id, { kill: (p, s) => { try { process.kill(p, s); return true; } catch (_) { return false; } } }).sent !== false;
            } catch (_) { return false; }
          },
        });
        if (tick && tick.kill) killChild(tick.reason === 'rss' ? 'rss' : 'timeout');
      }, 500);
      if (rssTimer && typeof rssTimer.unref === 'function') rssTimer.unref();
    }
    const idleMs = Number(args.idleMs) || 8000;
    idleTimer = setInterval(() => {
      if (settled) return;
      let idle = { stop: false };
      try {
        if (resilience && typeof resilience.detectIdleTimeout === 'function') {
          idle = resilience.detectIdleTimeout({ lastByteAt, now: Date.now(), idleMs });
        } else if (Date.now() - lastByteAt >= idleMs) {
          idle = { stop: true };
        }
      } catch (_) { idle = { stop: false }; }
      if (idle && idle.stop) killChild('timeout');
    }, Math.max(250, Math.min(2000, idleMs / 2)));
    if (idleTimer && typeof idleTimer.unref === 'function') idleTimer.unref();

    if (opts.signal) {
      if (opts.signal.aborted) {
        killChild('aborted');
      } else {
        externalAbortHandler = () => killChild('aborted');
        opts.signal.addEventListener('abort', externalAbortHandler, { once: true });
      }
    }

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (idleTimer) clearInterval(idleTimer); } catch (_) {}
      try { execHb.stop(); } catch (_) {}
      try { if (reapTimer) clearTimeout(reapTimer); } catch (_) {}
      sem.release();
      if (externalAbortHandler && opts.signal) {
        try { opts.signal.removeEventListener('abort', externalAbortHandler); } catch { /* ignore */ }
      }
      try {
        const workdir = args.cwd || args.workdir;
        if (workdir && resilience && typeof resilience.cleanupSandboxTmp === 'function' && args.cleanupWorkdir) {
          resilience.cleanupSandboxTmp(workdir);
        }
        if (lifecycle && typeof lifecycle.guaranteedTmpCleanup === 'function') {
          lifecycle.guaranteedTmpCleanup(workdir);
        }
        try {
          const ad = require('../agent-runner/engine-adapter');
          if (killedReason === 'abort' || killedReason === 'timeout' || (opts.signal && opts.signal.aborted)) {
            ad.tmpCleanupOnCancel(workdir ? [workdir] : []);
          }
          if (typeof ad.tmpdirCleanupFinally === 'function' && workdir && args.cleanupWorkdir) {
            ad.tmpdirCleanupFinally(workdir, () => {});
          }
        } catch (_) {}
      } catch (_) {}
      try { if (rssTimer) clearInterval(rssTimer); } catch (_) {}
      resolve({
        ok: false,
        code: 'sandbox_runtime_error',
        message: err && err.message,
        durationMs: elapsedMs(),
      });
    });

    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (idleTimer) clearInterval(idleTimer); } catch (_) {}
      try { execHb.stop(); } catch (_) {}
      try { if (reapTimer) clearTimeout(reapTimer); } catch (_) {}
      sem.release();
      if (externalAbortHandler && opts.signal) {
        try { opts.signal.removeEventListener('abort', externalAbortHandler); } catch { /* ignore */ }
      }
      try {
        const workdir = args.cwd || args.workdir;
        if (workdir && resilience && typeof resilience.cleanupSandboxTmp === 'function' && args.cleanupWorkdir) {
          resilience.cleanupSandboxTmp(workdir);
        }
        if (lifecycle && typeof lifecycle.guaranteedTmpCleanup === 'function') {
          lifecycle.guaranteedTmpCleanup(workdir);
        }
        try {
          const ad = require('../agent-runner/engine-adapter');
          if (killedReason === 'abort' || killedReason === 'timeout' || (opts.signal && opts.signal.aborted)) {
            ad.tmpCleanupOnCancel(workdir ? [workdir] : []);
          }
          if (typeof ad.tmpdirCleanupFinally === 'function' && workdir && args.cleanupWorkdir) {
            ad.tmpdirCleanupFinally(workdir, () => {});
          }
        } catch (_) {}
      } catch (_) {}
      try { if (rssTimer) clearInterval(rssTimer); } catch (_) {}
      let durationMs = elapsedMs();
      let stdout = stdoutRing ? stdoutRing.toString() : stdoutBuf.toString('utf8');
      let stderr = stderrRing ? stderrRing.toString() : stderrBuf.toString('utf8');
      try {
        const ad = require('../agent-runner/engine-adapter');
        const capOut = ad.capCommandStdout(stdout, { maxBytes: maxOutputBytes });
        if (capOut.truncated) { stdout = capOut.text; stdoutTruncated = true; }
        if (typeof ad.stdoutByteCapPerCommand === 'function') {
          const cap40 = ad.stdoutByteCapPerCommand(stdout, { maxBytes: 64 * 1024 });
          if (cap40 && cap40.truncated) { stdout = cap40.text; stdoutTruncated = true; }
        }
        const capErr = ad.capCommandStdout(stderr, { maxBytes: maxOutputBytes });
        if (capErr.truncated) { stderr = capErr.text; stderrTruncated = true; }
        if (typeof ad.splitStdoutStderrToolResult === 'function') {
          const split = ad.splitStdoutStderrToolResult({ stdout, stderr, maxBytes: maxOutputBytes });
          stdout = split.stdout;
          stderr = split.stderr;
          if (split.stdoutTruncated) stdoutTruncated = true;
          if (split.stderrTruncated) stderrTruncated = true;
        }
        if (typeof ad.splitStdoutStderrToolResult === 'function') {
          const split = ad.splitStdoutStderrToolResult({ stdout, stderr, maxBytes: maxOutputBytes });
          stdout = split.stdout;
          stderr = split.stderr;
          if (split.stdoutTruncated) stdoutTruncated = true;
          if (split.stderrTruncated) stderrTruncated = true;
        }
        if (typeof ad.refuseReadThroughSymlink === 'function') { try { ad.refuseReadThroughSymlink(args.cwd || args.workdir || '', {}); } catch (_) {} }
        if (typeof ad.stderrByteCapPerCommand === 'function') {
          const seCap = ad.stderrByteCapPerCommand(stderr, { maxBytes: 64 * 1024 });
          if (seCap && seCap.text != null) {
            stderr = seCap.text;
            if (seCap.truncated) stderrTruncated = true;
          }
        }
        if (typeof ad.redactHomePathsInResults === 'function') {
          const rhOut = ad.redactHomePathsInResults(stdout);
          if (rhOut && rhOut.text != null) stdout = rhOut.text;
          const rhErr = ad.redactHomePathsInResults(stderr);
          if (rhErr && rhErr.text != null) stderr = rhErr.text;
        }
      } catch (_) {}

      if (killedReason === 'timeout') {
        durationMs = Math.max(durationMs, timeoutMs);
        try {
          if (ad && typeof ad.sandboxTmpCleanupOnTimeout === 'function') {
            ad.sandboxTmpCleanupOnTimeout({ timedOut: true, tmpDir: args.cwd || args.workdir || args.tmpDir });
          }
        } catch (_) {}
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

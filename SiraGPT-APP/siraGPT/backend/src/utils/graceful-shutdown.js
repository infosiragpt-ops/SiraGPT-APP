'use strict';

/**
 * graceful-shutdown — registry of shutdown hooks executed in reverse-
 * LIFO order on SIGTERM / SIGINT (or manual trigger). Each hook gets
 * its own deadline; hooks that throw / hang are reported but never
 * stop the rest from running. Designed for HTTP servers (close()),
 * lease mutexes (#26 GC), audit log flush (#14), Bloom snapshot
 * persistence, etc.
 *
 * Why reverse-LIFO: the order things were started up is usually the
 * inverse of the order they should shut down (DB pool last to open,
 * first to close). Hooks added later assume earlier hooks are still
 * alive.
 *
 * Public API:
 *   const reg = createShutdownRegistry({
 *     deadlineMs = 10_000,
 *     signals = ['SIGTERM', 'SIGINT'],
 *     onLog,                       // ({ name, status, error?, elapsedMs })
 *     attachSignals = true,
 *   })
 *   reg.register(name, fn)         → unregister()
 *   await reg.shutdown(reason?)    → { ok, errors[], elapsedMs }
 *   reg.detach()                   — unwire signal listeners
 *   reg.isShuttingDown() / reg.snapshot()
 */

const DEFAULT_DEADLINE_MS = 10_000;

function createShutdownRegistry(opts = {}) {
  const deadlineMs = Number.isFinite(opts.deadlineMs) && opts.deadlineMs > 0
    ? Math.floor(opts.deadlineMs)
    : DEFAULT_DEADLINE_MS;
  const signals = Array.isArray(opts.signals) ? opts.signals.slice() : ['SIGTERM', 'SIGINT'];
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : null;
  const attachSignals = opts.attachSignals !== false;

  /** @type {Array<{name, fn, addedAt}>} */
  const hooks = [];
  const signalHandlers = [];
  let shuttingDown = false;
  let resolved = null;

  function register(name, fn) {
    if (typeof fn !== 'function') throw new TypeError('shutdown.register: fn required');
    if (typeof name !== 'string' || !name) throw new TypeError('shutdown.register: name required');
    if (shuttingDown) throw new Error('shutdown.register: already shutting down');
    const entry = { name, fn, addedAt: Date.now() };
    hooks.push(entry);
    return () => {
      const i = hooks.indexOf(entry);
      if (i !== -1) hooks.splice(i, 1);
    };
  }

  function fireLog(payload) {
    if (!onLog) return;
    try { onLog(payload); } catch { /* swallow */ }
  }

  async function runOne(entry) {
    const t0 = Date.now();
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => entry.fn()),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`hook "${entry.name}" timed out after ${deadlineMs}ms`)), deadlineMs);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      fireLog({ name: entry.name, status: 'ok', elapsedMs: Date.now() - t0 });
      return null;
    } catch (err) {
      fireLog({ name: entry.name, status: 'fail', elapsedMs: Date.now() - t0, error: err });
      return { name: entry.name, error: err };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function shutdown(reason = 'manual') {
    if (resolved) return resolved;
    shuttingDown = true;
    const startedAt = Date.now();
    fireLog({ name: '_shutdown_start', status: 'info', reason, hooks: hooks.length });
    const errors = [];
    // Reverse-LIFO walk; copy first so registers during shutdown
    // (defensive) don't mutate the slice mid-run.
    const order = hooks.slice().reverse();
    for (const entry of order) {
      const r = await runOne(entry);
      if (r) errors.push(r);
    }
    const result = {
      ok: errors.length === 0,
      errors,
      elapsedMs: Date.now() - startedAt,
      reason,
    };
    fireLog({ name: '_shutdown_end', status: result.ok ? 'ok' : 'partial', errors: errors.length, elapsedMs: result.elapsedMs });
    resolved = Promise.resolve(result);
    return result;
  }

  function attach() {
    if (signalHandlers.length > 0) return;
    for (const sig of signals) {
      const h = () => { shutdown(sig); };
      try { process.on(sig, h); signalHandlers.push({ sig, h }); }
      catch { /* swallow — sandboxed envs may forbid */ }
    }
  }

  function detach() {
    for (const { sig, h } of signalHandlers) {
      try { process.off(sig, h); } catch { /* swallow */ }
    }
    signalHandlers.length = 0;
  }

  function isShuttingDown() { return shuttingDown; }

  function snapshot() {
    return {
      hooks: hooks.length,
      shuttingDown,
      deadlineMs,
      signals: signals.slice(),
    };
  }

  if (attachSignals) attach();

  return { register, shutdown, detach, attach, isShuttingDown, snapshot };
}

module.exports = {
  createShutdownRegistry,
  DEFAULT_DEADLINE_MS,
};

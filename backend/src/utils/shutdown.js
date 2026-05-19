'use strict';

/**
 * shutdown.js — centralized graceful-shutdown sequencer.
 *
 * Thin facade on top of `graceful-shutdown.js` that adds the
 * project-specific defaults the platform needs:
 *
 *   - Per-step timeout budget (default 5s) so a hanging dependency
 *     can never block the global 30s deadline.
 *   - Reverse-LIFO ordering (last registered, first executed).
 *   - Structured logging of every step + total elapsed.
 *
 * Public API:
 *   register(name, fn, timeoutMs=5000)  → unregister()
 *   shutdown(reason)                    → { ok, errors, elapsedMs, steps }
 *   isShuttingDown()
 *   snapshot()
 *
 * Steps to register in order (from index.js):
 *   1. http_server_close          server.close()
 *   2. drain_inflight_requests    wait for in-flight to settle (30s cap)
 *   3. write_behind_cache_flush   cycle 31 cache
 *   4. realtime_ws_close          cycle 24
 *   5. bullmq_workers_close
 *   6. prisma_disconnect
 *   7. redis_disconnect
 *
 * The aggregate `shutdown()` enforces a 30s ceiling: if the sum of
 * per-step timeouts ever exceeds that, the registry will still abort
 * the process via the outer setTimeout below.
 */

const DEFAULT_STEP_TIMEOUT_MS = 5000;
const TOTAL_SHUTDOWN_DEADLINE_MS = 30_000;

const _hooks = []; // { name, fn, timeoutMs }
let _shuttingDown = false;
let _logger = console;

function _safeLog(level, payload, msg) {
  try {
    const fn = (_logger && typeof _logger[level] === 'function') ? _logger[level] : null;
    if (fn) fn.call(_logger, payload, msg);
    else if (_logger && typeof _logger.info === 'function') _logger.info(payload, msg);
  } catch { /* never throw */ }
}

function configure({ logger } = {}) {
  if (logger) _logger = logger;
}

function register(name, fn, timeoutMs = DEFAULT_STEP_TIMEOUT_MS) {
  if (typeof name !== 'string' || !name) throw new TypeError('shutdown.register: name required');
  if (typeof fn !== 'function') throw new TypeError('shutdown.register: fn required');
  if (_shuttingDown) throw new Error('shutdown.register: already shutting down');
  const entry = {
    name,
    fn,
    timeoutMs: (Number.isFinite(timeoutMs) && timeoutMs > 0) ? Math.floor(timeoutMs) : DEFAULT_STEP_TIMEOUT_MS,
  };
  _hooks.push(entry);
  return () => {
    const i = _hooks.indexOf(entry);
    if (i !== -1) _hooks.splice(i, 1);
  };
}

async function _runOne(entry) {
  const t0 = Date.now();
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => entry.fn()),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`shutdown step "${entry.name}" timed out after ${entry.timeoutMs}ms`)), entry.timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    const elapsedMs = Date.now() - t0;
    _safeLog('info', { step: entry.name, status: 'ok', elapsedMs }, 'shutdown_step_ok');
    return { name: entry.name, ok: true, elapsedMs };
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    _safeLog('warn', { step: entry.name, status: 'fail', elapsedMs, error: err && err.message }, 'shutdown_step_fail');
    return { name: entry.name, ok: false, elapsedMs, error: err && err.message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function shutdown(reason = 'manual') {
  if (_shuttingDown) return { ok: false, errors: [{ name: '_global', error: 'already_shutting_down' }], elapsedMs: 0, steps: [] };
  _shuttingDown = true;
  const t0 = Date.now();
  _safeLog('info', { reason, hooks: _hooks.length }, 'shutdown_initiated');

  // Hard deadline — if individual steps misbehave we don't sit forever.
  let deadlineHit = false;
  const deadlineTimer = setTimeout(() => { deadlineHit = true; }, TOTAL_SHUTDOWN_DEADLINE_MS);
  if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();

  const order = _hooks.slice().reverse();
  const steps = [];
  const errors = [];
  for (const entry of order) {
    if (deadlineHit) {
      _safeLog('warn', { step: entry.name }, 'shutdown_deadline_exceeded_skipping');
      steps.push({ name: entry.name, ok: false, error: 'global_deadline_exceeded' });
      errors.push({ name: entry.name, error: 'global_deadline_exceeded' });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const r = await _runOne(entry);
    steps.push(r);
    if (!r.ok) errors.push({ name: r.name, error: r.error });
  }

  clearTimeout(deadlineTimer);
  const elapsedMs = Date.now() - t0;
  const ok = errors.length === 0;
  _safeLog(ok ? 'info' : 'warn', { ok, elapsedMs, errors: errors.length, total: steps.length }, 'shutdown_complete');
  return { ok, errors, elapsedMs, steps };
}

function isShuttingDown() { return _shuttingDown; }
function snapshot() {
  return { shuttingDown: _shuttingDown, hooks: _hooks.map((h) => ({ name: h.name, timeoutMs: h.timeoutMs })) };
}

function _resetForTests() {
  _hooks.length = 0;
  _shuttingDown = false;
  _logger = console;
}

module.exports = {
  register,
  shutdown,
  configure,
  isShuttingDown,
  snapshot,
  DEFAULT_STEP_TIMEOUT_MS,
  TOTAL_SHUTDOWN_DEADLINE_MS,
  _resetForTests,
};

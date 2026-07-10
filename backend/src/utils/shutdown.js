'use strict';

/**
 * shutdown.js — centralized graceful-shutdown sequencer.
 *
 * Thin facade on top of `graceful-shutdown.js` that adds the
 * project-specific defaults the platform needs:
 *
 *   - Per-step timeout budget (default 5s) so a hanging dependency
 *     can never block the global 30s deadline.
 *   - Reverse-LIFO ordering (last registered, first executed) by default.
 *   - Optional explicit execution order for dependency-sensitive production
 *     hooks without changing legacy callers.
 *   - Structured logging of every step + total elapsed.
 *
 * Public API:
 *   register(name, fn, timeoutMs=5000)  → unregister()
 *   configure({ logger, executionOrder })
 *   shutdown(reason)                    → { ok, errors, elapsedMs, steps }
 *   isShuttingDown()
 *   snapshot()
 *
 * Production execution order is declared in PRODUCTION_SHUTDOWN_ORDER:
 * stop producers, stop accepting connections, drain/flush work, then close
 * queues, telemetry, and persistence dependencies.
 *
 * The aggregate `shutdown()` enforces a 30s ceiling: if the sum of
 * per-step timeouts ever exceeds that, the registry will still abort
 * the process via the outer setTimeout below.
 */

const DEFAULT_STEP_TIMEOUT_MS = 5000;
const TOTAL_SHUTDOWN_DEADLINE_MS = 30_000;
const PRODUCTION_SHUTDOWN_ORDER = Object.freeze([
  'scheduler_stop',
  'database_pool_autoscaler_stop',
  'system_cron_stop',
  'realtime_ws_close',
  'computer_use_ws_close',
  'http_server_close',
  'drain_inflight_requests',
  'write_behind_cache_flush',
  'bullmq_workers_close',
  'queue_health_probe_close',
  'observability_flush',
  'prisma_disconnect',
  'redis_disconnect',
]);

const _hooks = []; // { name, fn, timeoutMs }
let _shuttingDown = false;
let _logger = console;
let _executionOrder = null;

function _safeLog(level, payload, msg) {
  try {
    const fn = (_logger && typeof _logger[level] === 'function') ? _logger[level] : null;
    if (fn) fn.call(_logger, payload, msg);
    else if (_logger && typeof _logger.info === 'function') _logger.info(payload, msg);
  } catch { /* never throw */ }
}

function configure(options = {}) {
  const { logger } = options;
  if (logger) _logger = logger;
  if (Object.prototype.hasOwnProperty.call(options, 'executionOrder')) {
    const { executionOrder } = options;
    if (executionOrder == null) {
      _executionOrder = null;
    } else {
      if (!Array.isArray(executionOrder)) {
        throw new TypeError('shutdown.configure: executionOrder must be an array');
      }
      const names = executionOrder.map((name) => String(name || ''));
      if (names.some((name) => !name) || new Set(names).size !== names.length) {
        throw new TypeError('shutdown.configure: executionOrder requires unique non-empty names');
      }
      _executionOrder = names;
    }
  }
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

  const reverseLifo = _hooks.slice().reverse();
  let order = reverseLifo;
  if (_executionOrder) {
    const positions = new Map(_executionOrder.map((name, index) => [name, index]));
    order = reverseLifo
      .map((entry, reverseIndex) => ({ entry, reverseIndex }))
      .sort((a, b) => {
        const aPosition = positions.has(a.entry.name)
          ? positions.get(a.entry.name)
          : Number.POSITIVE_INFINITY;
        const bPosition = positions.has(b.entry.name)
          ? positions.get(b.entry.name)
          : Number.POSITIVE_INFINITY;
        if (aPosition !== bPosition) return aPosition < bPosition ? -1 : 1;
        return a.reverseIndex - b.reverseIndex;
      })
      .map(({ entry }) => entry);
  }
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
  return {
    shuttingDown: _shuttingDown,
    hooks: _hooks.map((h) => ({ name: h.name, timeoutMs: h.timeoutMs })),
    executionOrder: _executionOrder ? [..._executionOrder] : null,
  };
}

function _resetForTests() {
  _hooks.length = 0;
  _shuttingDown = false;
  _logger = console;
  _executionOrder = null;
}

module.exports = {
  register,
  shutdown,
  configure,
  isShuttingDown,
  snapshot,
  DEFAULT_STEP_TIMEOUT_MS,
  TOTAL_SHUTDOWN_DEADLINE_MS,
  PRODUCTION_SHUTDOWN_ORDER,
  _resetForTests,
};

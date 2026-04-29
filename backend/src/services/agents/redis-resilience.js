// Helpers for keeping the BullMQ-backed agent task pipeline alive when
// Redis hiccups. ioredis surfaces every transient outage as an 'error'
// event on the connection AND as a rejected promise on any in-flight
// command — without listeners, those rejections crash the Node process.

const TRANSIENT_REDIS_ERROR_RE = /(connection is closed|connection lost|connection reset|read econn|write econn|stream isn'?t writeable|enotfound|etimedout|econnrefused|ENOTCONN|EPIPE|reply error: loading|reconnecting)/i;

function isTransientRedisError(err) {
  if (!err) return false;
  const msg = String(err.message || err).toLowerCase();
  if (TRANSIENT_REDIS_ERROR_RE.test(msg)) return true;
  // ioredis sometimes uses err.code instead of message text.
  const code = String(err.code || '').toUpperCase();
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'ENOTCONN'].includes(code);
}

// Capped exponential backoff for ioredis retryStrategy. Starts at ~2s,
// grows ×1.5 per attempt, never sleeps longer than 30s. Returning a
// number tells ioredis to keep trying — we never give up so a long
// outage just delays jobs instead of killing the worker.
function reconnectDelay(attempt) {
  const base = 2000;
  const grown = base * Math.pow(1.5, Math.max(attempt, 1) - 1);
  return Math.min(Math.round(grown), 30000);
}

// Throttled logger. Avoids spamming logs once per millisecond when
// Redis is down — only emits at most once per `windowMs`.
function createThrottledLogger(windowMs = 60000) {
  let lastLog = 0;
  return (write) => {
    const now = Date.now();
    if (now - lastLog < windowMs) return;
    lastLog = now;
    try { write(); } catch { /* logging itself must not throw */ }
  };
}

// Attaches resilience listeners to an ioredis connection. Idempotent:
// calling twice on the same connection is a no-op.
function attachRedisListeners(connection, { label = 'redis', logger = console } = {}) {
  if (!connection || connection.__resilienceAttached) return connection;
  connection.__resilienceAttached = true;
  const throttled = createThrottledLogger();
  connection.on('error', (err) => {
    if (isTransientRedisError(err)) {
      throttled(() => logger.warn(`[${label}] transient connection error: ${err.message || err}`));
    } else {
      logger.error(`[${label}] unexpected error:`, err);
    }
  });
  connection.on('reconnecting', (delay) => {
    throttled(() => logger.warn(`[${label}] reconnecting in ${delay}ms`));
  });
  connection.on('end', () => {
    logger.warn(`[${label}] connection ended (will not auto-reconnect from this state)`);
  });
  return connection;
}

// Process-level guard for unhandled rejections that originate from
// BullMQ's internal Redis calls (e.g. Job.updateProgress when Redis
// is mid-failover). We swallow only those — anything else is logged
// loudly because it likely indicates a real bug.
let processGuardsInstalled = false;
function installProcessGuards({ logger = console } = {}) {
  if (processGuardsInstalled) return;
  processGuardsInstalled = true;
  process.on('unhandledRejection', (reason) => {
    if (isTransientRedisError(reason)) {
      logger.warn('[agent-task-worker] swallowed transient Redis rejection:', reason?.message || reason);
      return;
    }
    logger.error('[agent-task-worker] unhandled rejection:', reason);
  });
}

module.exports = {
  attachRedisListeners,
  createThrottledLogger,
  installProcessGuards,
  isTransientRedisError,
  reconnectDelay,
};

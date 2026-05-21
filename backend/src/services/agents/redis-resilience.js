// Helpers for keeping the BullMQ-backed agent task pipeline alive when
// Redis hiccups. ioredis surfaces every transient outage as an 'error'
// event on the connection AND as a rejected promise on any in-flight
// command — without listeners, those rejections crash the Node process.

const TRANSIENT_REDIS_ERROR_RE = /(connection is closed|connection lost|connection reset|read econn|write econn|stream isn'?t writeable|enotfound|etimedout|econnrefused|ENOTCONN|EPIPE|reply error: loading|reconnecting|max requests limit exceeded|max daily request limit|max commands per second|quota exceeded|rate limit exceeded|max payload size exceeded|max concurrent connections|max database size|max memory)/i;

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

// Circuit-breaker state. When Redis surfaces a transient error
// (Upstash daily limit, connection drop, rate-limit, etc.) we record
// the timestamp so route handlers can skip the queue and fall back to
// the in-process runtime without waiting for a hung `q.add()` to time
// out. The window auto-clears so we re-enable queued mode once Redis
// recovers.
let lastRedisFailureAt = 0;
let lastRedisFailureMessage = '';
const DEFAULT_UNHEALTHY_WINDOW_MS = 60_000;

function markRedisFailure(err) {
  lastRedisFailureAt = Date.now();
  lastRedisFailureMessage = err && err.message ? String(err.message) : String(err || 'unknown');
}

function isRedisRecentlyUnhealthy(windowMs = DEFAULT_UNHEALTHY_WINDOW_MS) {
  if (!lastRedisFailureAt) return false;
  return Date.now() - lastRedisFailureAt < windowMs;
}

function getLastRedisFailureMessage() {
  return lastRedisFailureMessage;
}

function clearRedisFailureMarker() {
  lastRedisFailureAt = 0;
  lastRedisFailureMessage = '';
}

// Attaches resilience listeners to an ioredis connection. Idempotent:
// calling twice on the same connection is a no-op.
function attachRedisListeners(connection, { label = 'redis', logger = console } = {}) {
  if (!connection || connection.__resilienceAttached) return connection;
  connection.__resilienceAttached = true;
  const throttled = createThrottledLogger();
  connection.on('error', (err) => {
    if (isTransientRedisError(err)) {
      markRedisFailure(err);
      throttled(() => logger.warn(`[${label}] transient connection error: ${err.message || err}`));
    } else {
      logger.error(`[${label}] unexpected error:`, err);
    }
  });
  connection.on('reconnecting', (delay) => {
    throttled(() => logger.warn(`[${label}] reconnecting in ${delay}ms`));
  });
  connection.on('end', () => {
    // `end` fires when ioredis has stopped retrying (typically after
    // Upstash returns a fatal "max requests limit exceeded" or the
    // connection idles out). The circuit breaker in `markRedisFailure`
    // already routes traffic to the local runtime, so this is a soft
    // notice, not an actionable error.
    const err = new Error(`${label} connection ended`);
    markRedisFailure(err);
    throttled(() => logger.warn(`[${label}] connection ended; serving requests via local runtime until Redis recovers; queued tasks will use local fallback until Redis reconnects`));
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
  // Throttle the swallow log: when Upstash hits its daily quota
  // BullMQ retries fire many rejections per second; logging every
  // one of them buries the rest of the boot output. One line per
  // minute is enough to signal the circuit is open.
  const throttled = createThrottledLogger();
  let suppressedSinceLast = 0;
  process.on('unhandledRejection', (reason) => {
    if (isTransientRedisError(reason)) {
      suppressedSinceLast += 1;
      throttled(() => {
        const extra = suppressedSinceLast > 1 ? ` (+${suppressedSinceLast - 1} suppressed)` : '';
        logger.warn(`[agent-task-worker] swallowed transient Redis rejection${extra}:`, reason?.message || reason);
        suppressedSinceLast = 0;
      });
      return;
    }
    logger.error('[agent-task-worker] unhandled rejection:', reason);
  });
}

module.exports = {
  attachRedisListeners,
  clearRedisFailureMarker,
  createThrottledLogger,
  getLastRedisFailureMessage,
  installProcessGuards,
  isRedisRecentlyUnhealthy,
  isTransientRedisError,
  markRedisFailure,
  reconnectDelay,
};

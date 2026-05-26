'use strict';

/**
 * prisma-accelerate-retry — wrap a Prisma call with a short retry loop
 * that handles transient Prisma Accelerate connection errors (P6008,
 * P5000 "Database request failed") without surfacing them to the user.
 *
 * This is a hotfix while the root-cause work (automatic fallback from
 * Accelerate to DIRECT_DATABASE_URL) is still pending. The login flow
 * was 500-ing whenever Accelerate's connection pool hiccuped; with
 * this helper we retry up to `maxAttempts` times with exponential
 * backoff before giving up. On terminal failure the caller receives
 * the original error, tagged with `error.databaseUnavailable = true`
 * so a route handler can render a friendly Spanish message instead of
 * a stack trace.
 *
 * Default policy: 3 attempts, 200 ms → 400 ms → 800 ms backoff.
 * That keeps the worst-case latency under ~1.5 s while smoothing out
 * a typical Accelerate pool recovery.
 */

const RETRYABLE_PRISMA_CODES = new Set(['P6008', 'P5000', 'P1001', 'P1002', 'P1008', 'P1017']);

function isAccelerateTransientError(err) {
  if (!err) return false;
  if (RETRYABLE_PRISMA_CODES.has(err.code)) return true;
  const msg = String(err.message || '').toLowerCase();
  if (msg.includes('p6008')) return true;
  if (msg.includes('accelerate was not able to connect')) return true;
  if (msg.includes('error requesting query engine from pool')) return true;
  if (msg.includes('database request failed')) return true;
  if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('socket hang up')) return true;
  if (msg.includes('fetch failed') && msg.includes('prisma')) return true;
  return false;
}

async function withAccelerateRetry(fn, {
  maxAttempts = 3,
  baseDelayMs = 200,
  label = 'prisma',
  logger = console,
} = {}) {
  if (typeof fn !== 'function') {
    throw new TypeError('withAccelerateRetry: fn must be a function');
  }
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isAccelerateTransientError(err) || attempt === maxAttempts) {
        if (isAccelerateTransientError(err)) {
          try { err.databaseUnavailable = true; } catch (_e) { /* frozen err */ }
          logger.error(`[${label}] Accelerate unavailable after ${attempt} attempts: ${err.code || ''} ${err.message || err}`);
        }
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      logger.warn(`[${label}] Accelerate transient error (attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms): ${err.code || ''} ${err.message || err}`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

module.exports = {
  withAccelerateRetry,
  isAccelerateTransientError,
  _internal: { RETRYABLE_PRISMA_CODES },
};

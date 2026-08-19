/**
 * job-utils — shared helpers for the system-cron / housekeeping jobs.
 *
 * Currently exports `wrapWithRetry(fn, opts)` which wraps an async job
 * handler with a small retry loop. The cron handlers in this directory
 * are designed to be safe to re-run (idempotent), so transient errors
 * (network blips, DB connection resets, ECONNRESET) should not cause a
 * 24h gap until the next cron tick.
 *
 * Why this lives here (not in src/utils/retry-with-backoff.js):
 *   - That helper targets per-call retries inside request paths and is
 *     wired through CircuitBreaker + classifyTaskError. Cron jobs run
 *     in isolation, on a long-period schedule, with their own error
 *     classification needs (we only retry on connection/network noise,
 *     not on programmer errors).
 *   - Keeping `wrapWithRetry` here means new jobs added under
 *     `src/jobs/` get a one-liner retry policy without pulling in the
 *     full retry/cb stack.
 *
 * Defaults: 3 attempts (initial + 2 retries), exponential backoff
 * 500ms → 1s → 2s with jitter. Override via `opts`.
 *
 * Tests: backend/tests/job-utils.test.js
 */

'use strict';

// Classify an error as "transient" — network/DB-connection failures that
// are worth retrying. Anything else (TypeError, validation, etc.) bubbles
// immediately so the next cron tick can pick it up after a real fix.
function isTransientError(err) {
  if (!err) return false;
  const code = err.code || err.errno || '';
  const msg = String(err.message || err);
  const transientCodes = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'EPIPE',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    // Prisma transient connection errors
    'P1001', // Cannot reach database server
    'P1002', // Database server timed out
    'P1008', // Operations timed out
    'P1017', // Server has closed the connection
  ]);
  if (transientCodes.has(String(code))) return true;
  // Heuristic on message — pg / fetch surface these as plain Error.
  if (/connection (terminated|reset|closed|refused)/i.test(msg)) return true;
  if (/network|socket hang up|timeout/i.test(msg)) return true;
  return false;
}

function computeDelay(attempt, baseMs, maxMs) {
  const exp = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  // Full jitter to avoid synchronised retries across multiple workers.
  return Math.round(Math.random() * exp);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap a job handler with retry-on-transient-error semantics.
 *
 *   const safe = wrapWithRetry(() => job.run({ logger }), {
 *     maxAttempts: 3,
 *     baseDelayMs: 500,
 *     maxDelayMs: 5_000,
 *     isTransient: isTransientError,
 *     onRetry: ({ attempt, delayMs, error }) => logger.warn(...),
 *   });
 *   const result = await safe();
 *
 * @param {Function} fn — async () => any
 * @param {object}   [opts]
 * @param {number}   [opts.maxAttempts=3]   Initial attempt + retries
 * @param {number}   [opts.baseDelayMs=500] Base exponential delay
 * @param {number}   [opts.maxDelayMs=5000] Cap on exponential delay
 * @param {Function} [opts.isTransient]     (err) => boolean — override classifier
 * @param {Function} [opts.onRetry]         ({attempt,delayMs,error,reason}) => void
 * @param {Function} [opts.sleep]           Override sleep (for tests)
 * @returns {Function} wrapped async function
 */
function wrapWithRetry(fn, opts = {}) {
  if (typeof fn !== 'function') {
    throw new TypeError('wrapWithRetry: fn must be a function');
  }
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 5_000;
  const classify = typeof opts.isTransient === 'function' ? opts.isTransient : isTransientError;
  const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : null;
  const sleeper = typeof opts.sleep === 'function' ? opts.sleep : sleep;

  return async function wrappedJob(...args) {
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await fn(...args);
      } catch (err) {
        lastErr = err;
        const transient = classify(err);
        const isLast = attempt >= maxAttempts - 1;
        if (!transient || isLast) throw err;
        const delayMs = computeDelay(attempt, baseDelayMs, maxDelayMs);
        if (onRetry) {
          try {
            onRetry({
              attempt: attempt + 1,
              delayMs,
              error: err,
              reason: err && (err.code || err.errno) ? String(err.code || err.errno) : 'transient',
            });
          } catch (_) { /* never let onRetry break the loop */ }
        }
        // eslint-disable-next-line no-await-in-loop
        await sleeper(delayMs);
      }
    }
    // Loop exits via return/throw; defensive fallback.
    if (lastErr) throw lastErr;
    throw new Error('wrapWithRetry: unreachable');
  };
}

module.exports = {
  wrapWithRetry,
  isTransientError,
  computeDelay,
};

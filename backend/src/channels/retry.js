'use strict';

/**
 * Bounded exponential backoff retry helper used by channel adapters for
 * outbound API calls. Retries on network errors and 429/5xx responses.
 *
 * `fn` receives `(attempt)` and must return `{ ok, status, body, retryAfterMs? }`
 * for HTTP-shaped operations, or throw to indicate a transport-level failure.
 */
async function retryWithBackoff(fn, {
  maxAttempts = 4,
  baseDelayMs = 200,
  maxDelayMs = 5_000,
  jitter = true,
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
} = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fn(attempt);
      if (res && res.ok) return res;
      const retriable = res && (res.status === 429 || (res.status >= 500 && res.status < 600));
      if (!retriable || attempt === maxAttempts) return res;
      const wait = retryAfterDelay(res.retryAfterMs, maxDelayMs)
        ?? backoffDelay(attempt, baseDelayMs, maxDelayMs, jitter);
      await sleep(wait);
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) throw err;
      await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs, jitter));
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('retryWithBackoff: exhausted attempts');
}

function backoffDelay(attempt, base, max, jitter) {
  const exp = Math.min(max, base * 2 ** (attempt - 1));
  if (!jitter) return exp;
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

function retryAfterDelay(retryAfterMs, maxDelayMs) {
  if (retryAfterMs === undefined || retryAfterMs === null) return undefined;
  const delay = Number(retryAfterMs);
  if (!Number.isFinite(delay) || delay < 0) return undefined;
  return Math.min(delay, maxDelayMs);
}

module.exports = { retryWithBackoff, backoffDelay, retryAfterDelay };

/**
 * rate-limiter — per-host token bucket + exponential backoff.
 *
 * Pure: the clock is injected so tests can advance time without
 * real waits. The bucket refills linearly at `capacity / windowMs`
 * tokens per ms.
 *
 * Returned from `acquireDelay(host)`:
 *   - `delay: number` — ms the caller should wait before firing
 *     the request. 0 means "fire now".
 *   - `reason` — "ready" | "backoff" | "throttled".
 *
 * `recordFailure(host, { is5xx, isRateLimitHeader })` raises the
 * host's backoff using a multiplicative policy (max = ceiling).
 * `recordSuccess` resets it.
 */

const DEFAULT_CAPACITY = 10;        // tokens per bucket
const DEFAULT_WINDOW_MS = 60_000;   // refill 10 tokens per minute
const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;

function createRateLimiter({ clock, capacity = DEFAULT_CAPACITY, windowMs = DEFAULT_WINDOW_MS, maxBackoffMs = DEFAULT_MAX_BACKOFF_MS } = {}) {
  const now = () => (clock ? clock() : Date.now());
  const buckets = new Map(); // host → { tokens, lastRefill, backoffMs, backoffUntil }

  function getBucket(host) {
    let b = buckets.get(host);
    if (!b) {
      b = { tokens: capacity, lastRefill: now(), backoffMs: 0, backoffUntil: 0 };
      buckets.set(host, b);
    }
    return b;
  }

  function refill(b) {
    const t = now();
    const elapsed = t - b.lastRefill;
    if (elapsed <= 0) return;
    const add = (capacity / windowMs) * elapsed;
    b.tokens = Math.min(capacity, b.tokens + add);
    b.lastRefill = t;
  }

  function acquireDelay(host) {
    const b = getBucket(host);
    const t = now();
    if (t < b.backoffUntil) return { delay: b.backoffUntil - t, reason: "backoff" };
    refill(b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { delay: 0, reason: "ready" };
    }
    // Time until one token is available
    const need = 1 - b.tokens;
    const delay = Math.ceil((need / (capacity / windowMs)));
    return { delay, reason: "throttled" };
  }

  function recordSuccess(host) {
    const b = getBucket(host);
    b.backoffMs = 0;
    b.backoffUntil = 0;
  }

  function recordFailure(host, { is5xx = false, isRateLimitHeader = false, retryAfterMs } = {}) {
    const b = getBucket(host);
    if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      b.backoffMs = Math.min(maxBackoffMs, retryAfterMs);
    } else {
      const base = b.backoffMs === 0 ? 1000 : b.backoffMs * 2;
      const multiplier = isRateLimitHeader ? 2 : (is5xx ? 1.5 : 1);
      b.backoffMs = Math.min(maxBackoffMs, Math.ceil(base * multiplier));
    }
    b.backoffUntil = now() + b.backoffMs;
    return { backoffMs: b.backoffMs, backoffUntil: b.backoffUntil };
  }

  function snapshot() {
    const out = {};
    for (const [h, b] of buckets.entries()) {
      out[h] = { tokens: Math.round(b.tokens * 100) / 100, backoffMs: b.backoffMs, backoffUntil: b.backoffUntil };
    }
    return out;
  }

  return { acquireDelay, recordSuccess, recordFailure, snapshot };
}

module.exports = {
  createRateLimiter,
  DEFAULT_CAPACITY,
  DEFAULT_WINDOW_MS,
  DEFAULT_MAX_BACKOFF_MS,
};

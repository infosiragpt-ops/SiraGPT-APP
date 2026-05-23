'use strict';

/**
 * token-bucket — classic per-key rate limiter with continuous refill
 * and configurable burst. Complements:
 *   - the existing rate-limit/ middleware (per-route HTTP),
 *   - the token-bulkhead (#18) which limits concurrent in-flight,
 *     this one limits requests-per-time-window per key (tenant /
 *     user / IP / API-key) regardless of concurrency.
 *
 * Continuous refill: instead of resetting at window boundaries, we
 * add (refillRatePerSec * elapsed) tokens up to capacity on every
 * tryConsume(). A burst up to `capacity` is permitted from idle.
 *
 * Public API:
 *   const rl = createTokenBucketLimiter({
 *     capacity,                    // tokens per bucket (default 60)
 *     refillRatePerSec,            // tokens added per second (default 1)
 *     maxKeys,                     // LRU cap (default 10_000)
 *     now,                         // clock injector
 *   })
 *   rl.tryConsume(key, n=1)
 *     → { allowed: true,  remaining, retryAfterMs: 0 }
 *     → { allowed: false, remaining, retryAfterMs }
 *   rl.peek(key)                   → snapshot | null
 *   rl.reset(key)                  → boolean
 *   rl.snapshot()                  → registry counters
 */

const DEFAULT_CAPACITY = 60;
const DEFAULT_REFILL = 1;
const DEFAULT_MAX_KEYS = 10_000;

function createTokenBucketLimiter(opts = {}) {
  const capacity = Number.isFinite(opts.capacity) && opts.capacity > 0
    ? opts.capacity
    : DEFAULT_CAPACITY;
  const refillRate = Number.isFinite(opts.refillRatePerSec) && opts.refillRatePerSec > 0
    ? opts.refillRatePerSec
    : DEFAULT_REFILL;
  const maxKeys = Number.isFinite(opts.maxKeys) && opts.maxKeys > 0
    ? Math.floor(opts.maxKeys)
    : DEFAULT_MAX_KEYS;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  /** @type {Map<string, {tokens, updatedAt}>} */
  const buckets = new Map();
  let totalAllowed = 0;
  let totalDenied = 0;

  function refill(b, t) {
    const elapsedSec = (t - b.updatedAt) / 1000;
    if (elapsedSec <= 0) return;
    b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillRate);
    b.updatedAt = t;
  }

  function evictLruIfNeeded() {
    while (buckets.size > maxKeys) {
      const oldestKey = buckets.keys().next().value;
      if (oldestKey === undefined) break;
      buckets.delete(oldestKey);
    }
  }

  function tryConsume(key, n = 1) {
    if (typeof key !== 'string' || !key) throw new TypeError('token-bucket: key required');
    const cost = Number.isFinite(n) && n > 0 ? n : 1;
    if (cost > capacity) {
      // Can never satisfy; deny up front so caller doesn't poll forever.
      totalDenied += 1;
      return { allowed: false, remaining: 0, retryAfterMs: Infinity };
    }
    const t = now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, updatedAt: t };
      buckets.set(key, b);
      evictLruIfNeeded();
    } else {
      // LRU touch.
      buckets.delete(key);
      buckets.set(key, b);
      refill(b, t);
    }
    if (b.tokens >= cost) {
      b.tokens -= cost;
      totalAllowed += 1;
      return {
        allowed: true,
        remaining: Math.floor(b.tokens),
        retryAfterMs: 0,
      };
    }
    const deficit = cost - b.tokens;
    const waitMs = Math.ceil((deficit / refillRate) * 1000);
    totalDenied += 1;
    return {
      allowed: false,
      remaining: Math.floor(b.tokens),
      retryAfterMs: waitMs,
    };
  }

  function peek(key) {
    const b = buckets.get(key);
    if (!b) return null;
    const t = now();
    refill(b, t);
    return {
      key,
      tokens: b.tokens,
      capacity,
      refillRatePerSec: refillRate,
    };
  }

  function reset(key) {
    return buckets.delete(key);
  }

  function snapshot() {
    return {
      keys: buckets.size,
      capacity,
      refillRatePerSec: refillRate,
      maxKeys,
      totalAllowed,
      totalDenied,
    };
  }

  return { tryConsume, peek, reset, snapshot };
}

module.exports = {
  createTokenBucketLimiter,
  DEFAULT_CAPACITY,
  DEFAULT_REFILL,
  DEFAULT_MAX_KEYS,
};

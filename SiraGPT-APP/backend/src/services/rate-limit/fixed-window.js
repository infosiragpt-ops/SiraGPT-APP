'use strict';

/**
 * fixed-window — per-key fixed-window rate limiter.
 *
 * Complements token-bucket (already in this folder): token-bucket
 * smooths bursty traffic, fixed-window enforces a hard cap per
 * boundary (e.g. "100 calls per minute, period"). Better fit for
 * billing-style quotas where a clean reset moment matters more than
 * burst smoothing.
 *
 * Each key has a counter and a window-start timestamp. When the
 * current time crosses a window boundary, the counter resets. We
 * never schedule timers — windows roll lazily on the next hit. A
 * configurable lazy-GC sweep evicts cold keys to bound memory.
 *
 * Public API:
 *   const limiter = createFixedWindowLimiter({ limit, windowMs, now?, gcEveryHits? })
 *   limiter.check(key)         — { allowed, remaining, resetAt, count }
 *   limiter.reset(key) / reset() / size() / snapshot()
 */

const DEFAULT_GC_EVERY_HITS = 10000;

function createFixedWindowLimiter(opts = {}) {
  const limit = Number(opts.limit);
  const windowMs = Number(opts.windowMs);
  if (!(Number.isInteger(limit) && limit > 0)) {
    throw new TypeError('fixed-window: limit must be positive integer');
  }
  if (!(Number.isFinite(windowMs) && windowMs > 0)) {
    throw new TypeError('fixed-window: windowMs must be positive');
  }
  const gcEveryHits = Number.isInteger(opts.gcEveryHits) && opts.gcEveryHits > 0
    ? opts.gcEveryHits
    : DEFAULT_GC_EVERY_HITS;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  const buckets = new Map(); // key → { windowStart, count }
  let hitsSinceGc = 0;

  function windowStartFor(t) {
    return Math.floor(t / windowMs) * windowMs;
  }

  function gcSweep(t) {
    const cutoff = windowStartFor(t);
    for (const [k, b] of buckets) {
      if (b.windowStart < cutoff) buckets.delete(k);
    }
  }

  function check(key) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('fixed-window: key must be non-empty string');
    }
    const t = now();
    const start = windowStartFor(t);
    const resetAt = start + windowMs;
    let b = buckets.get(key);
    if (!b || b.windowStart !== start) {
      b = { windowStart: start, count: 0 };
      buckets.set(key, b);
    }
    let allowed;
    if (b.count >= limit) {
      allowed = false;
    } else {
      b.count += 1;
      allowed = true;
    }
    hitsSinceGc += 1;
    if (hitsSinceGc >= gcEveryHits) {
      hitsSinceGc = 0;
      gcSweep(t);
    }
    return {
      allowed,
      remaining: Math.max(0, limit - b.count),
      resetAt,
      count: b.count,
    };
  }

  function reset(key) {
    if (key === undefined) {
      buckets.clear();
      return;
    }
    buckets.delete(key);
  }

  function snapshot() {
    return {
      limit,
      windowMs,
      size: buckets.size,
    };
  }

  return {
    check,
    reset,
    size: () => buckets.size,
    snapshot,
  };
}

module.exports = {
  createFixedWindowLimiter,
};

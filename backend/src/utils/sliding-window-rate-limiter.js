/**
 * sliding-window-rate-limiter.js
 *
 * Sliding-window log rate limiter. Improves on the existing
 * services/rate-limiter.js fixed-window implementation by smoothing
 * the boundary spike: with a fixed window of 60s / 60 req, an
 * attacker can send 60 requests in the last second of one window and
 * another 60 in the first second of the next — 120 in 2s. A sliding
 * window log keeps per-key timestamps and rejects anything that
 * would push the trailing-window count over the limit, so the cap
 * truly means "N requests per windowMs" at every instant.
 *
 * Trade-off: we keep per-key arrays of timestamps. Memory is O(N)
 * per active key per window. For limits up to ~1k requests/window
 * this is negligible; for very-high-cardinality keys / very high
 * limits, fall back to a token-bucket or the fixed-window limiter.
 *
 * Store interface (so callers can plug Redis later):
 *   - get(key)              → Promise<number[] | null>
 *   - set(key, timestamps)  → Promise<void>
 *   - delete(key)           → Promise<void>
 *   - keys()                → Iterable<string>   (used for cleanup)
 *
 * The default in-memory MapStore is synchronous but the limiter
 * always awaits; that way swapping in an async (e.g. Redis) store
 * is a no-op for callers.
 *
 * Returned check() shape (compatible with the existing limiter):
 *   {
 *     allowed:      boolean,
 *     limit:        number,
 *     remaining:    number,    // 0 when not allowed
 *     resetIn:      number,    // ms until oldest timestamp falls out of the window
 *     retryAfterMs: number,    // present only when not allowed
 *     used:         number,    // current count after this check
 *   }
 */

'use strict';

class MapStore {
  constructor() { this._m = new Map(); }
  async get(key) { return this._m.get(key) || null; }
  async set(key, timestamps) { this._m.set(key, timestamps); }
  async delete(key) { this._m.delete(key); }
  keys() { return this._m.keys(); }
  get size() { return this._m.size; }
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 60;

class SlidingWindowRateLimiter {
  constructor(opts = {}) {
    this.windowMs = Number.isFinite(opts.windowMs) && opts.windowMs > 0
      ? opts.windowMs : DEFAULT_WINDOW_MS;
    this.limit = Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit)
      : (Number.isFinite(opts.maxRequests) && opts.maxRequests > 0
        ? Math.floor(opts.maxRequests)
        : DEFAULT_LIMIT);
    this.keyPrefix = opts.keyPrefix || 'srl';
    this.store = opts.store || new MapStore();
    this._now = opts.now || Date.now;
    // We expose `maxRequests` as an alias for symmetry with the
    // existing limiter's API surface.
    this.maxRequests = this.limit;
  }

  _k(identifier) { return `${this.keyPrefix}:${identifier}`; }

  /**
   * Atomic-ish "test and increment". When a request is allowed, the
   * current timestamp is appended to the log. When denied, the log
   * is left untouched (so over-limit traffic doesn't push the reset
   * out further than necessary).
   */
  async check(identifier) {
    const key = this._k(identifier);
    const now = this._now();
    const windowStart = now - this.windowMs;

    let log = (await this.store.get(key)) || [];
    // Drop expired timestamps in-place.
    if (log.length && log[0] <= windowStart) {
      let i = 0;
      while (i < log.length && log[i] <= windowStart) i += 1;
      log = i === log.length ? [] : log.slice(i);
    }

    if (log.length >= this.limit) {
      const oldest = log[0];
      const resetIn = Math.max(0, oldest + this.windowMs - now);
      await this.store.set(key, log);
      return {
        allowed: false,
        limit: this.limit,
        remaining: 0,
        used: log.length,
        resetIn,
        retryAfterMs: resetIn,
      };
    }

    log.push(now);
    await this.store.set(key, log);
    const oldest = log[0];
    return {
      allowed: true,
      limit: this.limit,
      remaining: this.limit - log.length,
      used: log.length,
      resetIn: Math.max(0, oldest + this.windowMs - now),
    };
  }

  /**
   * Read-only inspection — does not increment.
   */
  async peek(identifier) {
    const key = this._k(identifier);
    const now = this._now();
    const windowStart = now - this.windowMs;
    const stored = (await this.store.get(key)) || [];
    const alive = stored.filter((t) => t > windowStart);
    const oldest = alive[0];
    return {
      limit: this.limit,
      used: alive.length,
      remaining: Math.max(0, this.limit - alive.length),
      resetIn: oldest ? Math.max(0, oldest + this.windowMs - now) : 0,
    };
  }

  async reset(identifier) {
    await this.store.delete(this._k(identifier));
    return true;
  }

  /** Sweep expired keys. Returns the number of keys cleaned. */
  async cleanup() {
    if (typeof this.store.keys !== 'function') return 0;
    const now = this._now();
    const windowStart = now - this.windowMs;
    let cleaned = 0;
    for (const key of Array.from(this.store.keys())) {
      const log = (await this.store.get(key)) || [];
      const alive = log.filter((t) => t > windowStart);
      if (alive.length === 0) {
        await this.store.delete(key);
        cleaned += 1;
      } else if (alive.length !== log.length) {
        await this.store.set(key, alive);
      }
    }
    return cleaned;
  }
}

/**
 * Express middleware adapter. Matches the existing rate-limiter
 * middleware contract — sets X-RateLimit-* headers and replies 429
 * with retryAfterMs when over limit.
 *
 * @param {object} opts  Forwarded to SlidingWindowRateLimiter ctor plus:
 *   - identifier(req)   function returning the key. Default: req.user?.id || req.ip || 'anon'.
 *   - onLimit(req,res)  optional hook before responding 429.
 */
function slidingWindowRateLimitMiddleware(opts = {}) {
  const limiter = opts.limiter instanceof SlidingWindowRateLimiter
    ? opts.limiter
    : new SlidingWindowRateLimiter(opts);
  const getId = typeof opts.identifier === 'function'
    ? opts.identifier
    : (req) => (req && req.user && req.user.id) || (req && req.ip) || 'anon';

  return async function slidingWindowRateLimit(req, res, next) {
    try {
      const id = getId(req) || 'anon';
      const result = await limiter.check(String(id));
      res.setHeader('X-RateLimit-Limit', String(result.limit));
      res.setHeader('X-RateLimit-Remaining', String(result.remaining));
      res.setHeader(
        'X-RateLimit-Reset',
        String(Math.round((Date.now() + result.resetIn) / 1000)),
      );
      // IETF draft headers (RateLimit, RateLimit-Policy) for clients
      // that prefer the new spec. Harmless duplication.
      res.setHeader('RateLimit-Limit', String(result.limit));
      res.setHeader('RateLimit-Remaining', String(result.remaining));
      res.setHeader('RateLimit-Reset', String(Math.ceil(result.resetIn / 1000)));
      res.setHeader('RateLimit-Policy', `${result.limit};w=${Math.round(limiter.windowMs / 1000)}`);

      if (!result.allowed) {
        if (typeof opts.onLimit === 'function') {
          try { opts.onLimit(req, res, result); } catch (_) { /* swallow */ }
        }
        res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
        return res.status(429).json({
          error: 'rate_limit_exceeded',
          message: 'Too many requests. Please try again later.',
          retryAfterMs: result.retryAfterMs,
          limit: result.limit,
        });
      }
      return next();
    } catch (err) {
      // Fail open — same posture as middleware/rate-limit-store.js.
      // We log via next() so error middleware can decide; for safety
      // we don't block the request on a limiter outage.
      if (typeof next === 'function') return next();
      throw err;
    }
  };
}

module.exports = {
  SlidingWindowRateLimiter,
  MapStore,
  slidingWindowRateLimitMiddleware,
  DEFAULT_WINDOW_MS,
  DEFAULT_LIMIT,
};

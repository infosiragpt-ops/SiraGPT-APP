'use strict';

/**
 * token-bucket — in-process token bucket limiter scoped per route and
 * per principal (user-id when a JWT is present, IP otherwise).
 *
 * Why a token bucket on top of the existing express-rate-limit fixed
 * window:
 *   express-rate-limit gives us a coarse "N requests per 15 minutes"
 *   ceiling, which is great for stopping scrapers but punishes legit
 *   bursty traffic (a user opening five tabs at once trips the limit
 *   for the rest of the window). The token bucket lets us model the
 *   common case — sustained request rate is moderate, occasional
 *   bursts are fine — without lifting the absolute ceiling.
 *
 *   It composes with the fixed-window limiter rather than replacing
 *   it: the bucket smooths bursts inside the window, the fixed window
 *   still caps the long tail.
 *
 * Why per-route AND per-user:
 *   Different endpoints have different cost profiles. A `/api/agents/
 *   batch` request can spawn a fork-join of LLM calls; a `/api/health`
 *   request reads a flag in memory. Sharing one bucket across both
 *   routes either over-throttles cheap endpoints or under-throttles
 *   expensive ones. Keying buckets by `<route>:<principal>` lets the
 *   call site declare a bucket sized for its own cost.
 *
 * Memory:
 *   Buckets live in a Map. We reap idle buckets (capacity reached and
 *   no consumption for `idleTtlMs`) via a lightweight LRU-style sweep
 *   on every consume call — no setInterval, no leaks at shutdown.
 *   The reaper has an O(1) amortized cost: it does at most one map
 *   delete per call, walking from the oldest entry forward. This
 *   matters because rate-limit middleware is on the hot path.
 *
 * Out of scope for this module:
 *   Multi-replica counter sharing. The Redis-backed
 *   `rate-limit-store.js` already exists for the fixed-window limiter
 *   and is the right tool when shared state is required. The token
 *   bucket here is intentionally local: it absorbs bursts at the edge
 *   of one replica before the request hits the shared limiter.
 */

const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_BUCKETS = 50_000;

function nowMs() {
  return Date.now();
}

/**
 * TokenBucket — single-key bucket. `capacity` tokens, refilled at
 * `refillRate` tokens per second, computed lazily on each call (no
 * timers).
 *
 * Refill is fractional: a 0.5 tokens/sec rate gives one token every
 * two seconds. We track tokens as a float internally and only round
 * down when reporting `remaining()` so the user-visible counter
 * matches what `tryConsume(1)` would actually permit.
 */
class TokenBucket {
  constructor({ capacity, refillRate, clock = nowMs }) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new TypeError('TokenBucket: capacity must be a positive finite number');
    }
    if (!Number.isFinite(refillRate) || refillRate <= 0) {
      throw new TypeError('TokenBucket: refillRate must be a positive finite number');
    }
    this.capacity = capacity;
    this.refillRate = refillRate;
    this._tokens = capacity;
    this._clock = clock;
    this._lastRefill = clock();
    this.lastTouched = this._lastRefill;
  }

  _refill() {
    const now = this._clock();
    const elapsedMs = now - this._lastRefill;
    if (elapsedMs > 0) {
      const refilled = (elapsedMs / 1000) * this.refillRate;
      if (refilled > 0) {
        this._tokens = Math.min(this.capacity, this._tokens + refilled);
        this._lastRefill = now;
      }
    }
  }

  /**
   * tryConsume — deduct `cost` tokens if available. Returns a
   * disposition object the middleware can translate into headers /
   * 429 directly.
   */
  tryConsume(cost = 1) {
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new TypeError('TokenBucket.tryConsume: cost must be a positive finite number');
    }
    this._refill();
    this.lastTouched = this._clock();
    if (this._tokens >= cost) {
      this._tokens -= cost;
      return {
        allowed: true,
        remaining: Math.floor(this._tokens),
        retryAfterMs: 0,
        capacity: this.capacity,
      };
    }
    const deficit = cost - this._tokens;
    const retryAfterMs = Math.ceil((deficit / this.refillRate) * 1000);
    return {
      allowed: false,
      remaining: Math.floor(this._tokens),
      retryAfterMs,
      capacity: this.capacity,
    };
  }

  /**
   * adjust — apply an arbitrary delta to the bucket without the
   * "reject if insufficient" semantics of `tryConsume`. Positive
   * deltas debit, negative deltas refund. The result is clamped to
   * `[0, capacity]` so retrospective billing can never push the
   * bucket negative (which would create a debt the next caller pays
   * for) nor inflate it beyond burst capacity.
   *
   * Used by dynamic cost-based limits: the upfront cost is charged
   * by `tryConsume`, and once the handler reports its actual cost
   * (tokens, CPU ms, etc.) the difference is reconciled here.
   */
  adjust(delta) {
    if (!Number.isFinite(delta)) {
      throw new TypeError('TokenBucket.adjust: delta must be a finite number');
    }
    this._refill();
    this.lastTouched = this._clock();
    this._tokens = Math.max(0, Math.min(this.capacity, this._tokens - delta));
    return {
      remaining: Math.floor(this._tokens),
      capacity: this.capacity,
    };
  }

  /**
   * isFull — used by the reaper to decide if a bucket can be evicted
   * without affecting fairness. A full, idle bucket carries no state
   * worth preserving (a fresh bucket starts at capacity anyway).
   */
  isFull() {
    this._refill();
    return this._tokens >= this.capacity;
  }
}

/**
 * TokenBucketRegistry — keyed pool of buckets. Same `capacity` /
 * `refillRate` for every key; if you need heterogeneous caps, use
 * one registry per route.
 */
class TokenBucketRegistry {
  constructor({
    capacity,
    refillRate,
    idleTtlMs = DEFAULT_IDLE_TTL_MS,
    maxBuckets = DEFAULT_MAX_BUCKETS,
    clock = nowMs,
  } = {}) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new TypeError('TokenBucketRegistry: capacity must be a positive finite number');
    }
    if (!Number.isFinite(refillRate) || refillRate <= 0) {
      throw new TypeError('TokenBucketRegistry: refillRate must be a positive finite number');
    }
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.idleTtlMs = idleTtlMs;
    this.maxBuckets = maxBuckets;
    this._clock = clock;
    // Map preserves insertion order — the oldest entry is always at
    // the iterator head, which gives us the cheap LRU sweep.
    this._buckets = new Map();
  }

  size() {
    return this._buckets.size;
  }

  _touch(key, bucket) {
    // Re-insert to move the entry to the tail of the iteration order.
    this._buckets.delete(key);
    this._buckets.set(key, bucket);
  }

  _reap() {
    if (this._buckets.size === 0) return;
    const now = this._clock();
    const cutoff = now - this.idleTtlMs;
    const it = this._buckets.entries();
    // Sweep up to a small constant per call so steady-state cost
    // stays O(1). Pressure-driven eviction (maxBuckets) handles the
    // pathological case where every key is hot.
    for (let i = 0; i < 4; i += 1) {
      const next = it.next();
      if (next.done) break;
      const [key, bucket] = next.value;
      if (bucket.lastTouched <= cutoff && bucket.isFull()) {
        this._buckets.delete(key);
      } else {
        // First non-evictable entry in iteration order means nothing
        // older qualifies either; bail out.
        break;
      }
    }
    // Hard cap: if a flood of unique keys still pushes us past the
    // ceiling (e.g. botnet rotating IPs), evict the oldest entries
    // unconditionally. Counting is more important than fairness here.
    while (this._buckets.size > this.maxBuckets) {
      const oldest = this._buckets.keys().next();
      if (oldest.done) break;
      this._buckets.delete(oldest.value);
    }
  }

  get(key) {
    let bucket = this._buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket({
        capacity: this.capacity,
        refillRate: this.refillRate,
        clock: this._clock,
      });
      this._buckets.set(key, bucket);
      // Enforce hard cap after insertion so a flood of unique keys
      // can never push us above maxBuckets, even by one.
      while (this._buckets.size > this.maxBuckets) {
        const oldest = this._buckets.keys().next();
        if (oldest.done) break;
        if (oldest.value === key) break;
        this._buckets.delete(oldest.value);
      }
    } else {
      this._touch(key, bucket);
    }
    return bucket;
  }

  consume(key, cost = 1) {
    this._reap();
    const bucket = this.get(key);
    return bucket.tryConsume(cost);
  }

  /**
   * adjust — retrospective billing for a key. Positive delta debits
   * (after tryConsume already charged the upfront cost), negative
   * refunds. Touches the bucket so a refund won't immediately be
   * reaped on the next sweep.
   */
  adjust(key, delta) {
    const bucket = this.get(key);
    return bucket.adjust(delta);
  }

  reset(key) {
    if (key === undefined) {
      this._buckets.clear();
      return;
    }
    this._buckets.delete(key);
  }
}

/**
 * makeRouteUserKey — composes a registry key from a route label plus
 * the principal returned by an existing `keyGenerator` (typically
 * `makeJwtAwareKeyGenerator` from rate-limit-policy.js, which
 * produces `user:<id>` or `ip:<addr>`).
 *
 * The route label is supplied by the caller, not derived from
 * `req.path`, so dynamic segments (`/api/files/:id`) collapse into
 * one bucket. Letting `req.path` drive the key would let an attacker
 * spread their burst across an unbounded set of buckets by varying
 * path params.
 */
function makeRouteUserKey(routeLabel, principalKey) {
  return `${routeLabel}|${principalKey}`;
}

/**
 * createTokenBucketMiddleware — Express middleware factory.
 *
 * Required options:
 *   capacity      — bucket size (max burst).
 *   refillRate    — tokens per second (sustained rate).
 *   route         — short label for the route group, used as the
 *                   bucket-key prefix.
 *
 * Optional:
 *   keyGenerator  — function(req) returning the principal key.
 *                   Defaults to `ip:<req.ip>` to avoid hard-coupling
 *                   this module to JWT secrets; in the integrated
 *                   path the caller passes `makeJwtAwareKeyGenerator`.
 *   cost          — function(req) → number of tokens to consume.
 *                   Lets expensive routes bill more than 1 per call.
 *   onLimit       — function(req, res, info) for custom 429 bodies.
 *   registry      — pre-built TokenBucketRegistry (mostly for tests
 *                   sharing a clock between buckets).
 *   skip          — function(req) → boolean; if true, bypass the
 *                   limiter (e.g. for health checks).
 *
 * The middleware sets the same `RateLimit-*` headers the upstream
 * limiter uses, so observability dashboards keep working.
 */
function createTokenBucketMiddleware(options = {}) {
  const {
    capacity,
    refillRate,
    route,
    keyGenerator = (req) => `ip:${(req && req.ip) || 'unknown'}`,
    cost = () => 1,
    onLimit,
    registry,
    skip,
    clock = nowMs,
  } = options;

  if (!route || typeof route !== 'string') {
    throw new TypeError('createTokenBucketMiddleware: route label is required');
  }

  const reg = registry || new TokenBucketRegistry({
    capacity,
    refillRate,
    clock,
  });

  return function tokenBucketMiddleware(req, res, next) {
    if (typeof skip === 'function' && skip(req)) {
      return next();
    }
    let principal;
    try {
      principal = keyGenerator(req);
    } catch (_err) {
      principal = `ip:${(req && req.ip) || 'unknown'}`;
    }
    const key = makeRouteUserKey(route, principal);
    let tokens;
    try {
      tokens = typeof cost === 'function' ? cost(req) : cost;
    } catch (_err) {
      tokens = 1;
    }
    if (!Number.isFinite(tokens) || tokens <= 0) tokens = 1;

    const result = reg.consume(key, tokens);

    if (typeof res.setHeader === 'function') {
      res.setHeader('RateLimit-Policy', `${reg.capacity};burst=${reg.capacity};rate=${reg.refillRate}/s`);
      res.setHeader('RateLimit-Limit', String(reg.capacity));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, result.remaining)));
      if (!result.allowed) {
        const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
        res.setHeader('Retry-After', String(retryAfterSec));
        res.setHeader('RateLimit-Reset', String(retryAfterSec));
      }
    }

    if (result.allowed) {
      return next();
    }

    if (typeof onLimit === 'function') {
      return onLimit(req, res, { ...result, key, route });
    }
    if (typeof res.status === 'function' && typeof res.json === 'function') {
      return res
        .status(429)
        .json({
          error: 'rate_limited',
          route,
          retryAfterMs: result.retryAfterMs,
        });
    }
    // Bare-bones response for non-Express harnesses (tests).
    if (typeof res.statusCode !== 'undefined') res.statusCode = 429;
    if (typeof res.end === 'function') res.end();
    return undefined;
  };
}

module.exports = {
  TokenBucket,
  TokenBucketRegistry,
  createTokenBucketMiddleware,
  makeRouteUserKey,
  DEFAULT_IDLE_TTL_MS,
  DEFAULT_MAX_BUCKETS,
};

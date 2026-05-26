'use strict';

/**
 * memoize — generic per-argument memoization with TTL + LRU. Pairs
 * with the LRU cache (#46), credential resolver (#11), and skills
 * snapshot cache (#5) — those wrap a single resource; this one
 * wraps an arbitrary fn.
 *
 * Async-safe: concurrent identical calls collapse to a single
 * inflight promise (single-flight). Throwing rejections are NOT
 * cached by default (different from idempotency #13 which DOES
 * cache rejections — pick the right tool for the use case).
 *
 * Public API:
 *   memoize(fn, { ttlMs=0, max=1024, key=defaultKey, cacheRejections=false })
 *     → wrapped fn with extra props .cache (Map), .invalidate(...args),
 *       .clear()
 */

function defaultKey(args) {
  // Cheap canonical key. For complex args use a custom `key` fn.
  if (args.length === 0) return '';
  if (args.length === 1) {
    const a = args[0];
    if (a == null) return String(a);
    if (typeof a !== 'object') return `${typeof a}:${a}`;
  }
  try { return JSON.stringify(args); } catch { return String(args); }
}

function memoize(fn, opts = {}) {
  if (typeof fn !== 'function') throw new TypeError('memoize: fn required');
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? Math.floor(opts.ttlMs) : 0;
  const max = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : 1024;
  const keyFn = typeof opts.key === 'function' ? opts.key : defaultKey;
  const cacheRejections = Boolean(opts.cacheRejections);
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  /** Map<key, { value, expiresAt, promise? }> */
  const cache = new Map();

  function evictLruIfNeeded() {
    while (cache.size > max) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }

  function isFresh(entry, t) {
    return entry && (entry.expiresAt === 0 || entry.expiresAt > t);
  }

  function touch(key, entry) {
    cache.delete(key);
    cache.set(key, entry);
  }

  function wrapped(...args) {
    const key = keyFn(args);
    const t = now();
    const cached = cache.get(key);
    if (cached) {
      if (cached.promise) { touch(key, cached); return cached.promise; }
      if (isFresh(cached, t)) {
        touch(key, cached);
        if ('error' in cached) throw cached.error;
        return cached.value;
      }
      cache.delete(key);
    }
    let result;
    try { result = fn.apply(this, args); }
    catch (err) {
      if (cacheRejections) {
        cache.set(key, { value: undefined, error: err, expiresAt: ttlMs > 0 ? t + ttlMs : 0 });
      }
      throw err;
    }
    if (result && typeof result.then === 'function') {
      const placeholder = { promise: result, expiresAt: 0 };
      cache.set(key, placeholder);
      const settled = result.then(
        (v) => {
          cache.set(key, { value: v, expiresAt: ttlMs > 0 ? now() + ttlMs : 0 });
          evictLruIfNeeded();
          return v;
        },
        (err) => {
          if (cacheRejections) {
            cache.set(key, { value: undefined, error: err, expiresAt: ttlMs > 0 ? now() + ttlMs : 0 });
          } else {
            cache.delete(key);
          }
          throw err;
        },
      );
      placeholder.promise = settled;
      return settled;
    }
    cache.set(key, { value: result, expiresAt: ttlMs > 0 ? t + ttlMs : 0 });
    evictLruIfNeeded();
    return result;
  }

  wrapped.cache = cache;
  wrapped.invalidate = (...args) => cache.delete(keyFn(args));
  wrapped.clear = () => cache.clear();

  return wrapped;
}

module.exports = {
  memoize,
  defaultKey,
};

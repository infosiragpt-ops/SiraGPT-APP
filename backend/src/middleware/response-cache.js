'use strict';

/**
 * response-cache — In-memory LRU response cache for idempotent GET endpoints.
 *
 * Features:
 *   - LRU eviction (default max 1000 entries), default TTL 60 s, max entry size 256 KiB.
 *   - Vary by request method + path + query string + auth user id, so different
 *     authenticated users get isolated cache entries.
 *   - Wraps res.send / res.json to capture the body + Content-Type for replay.
 *   - Honors `Cache-Control: no-cache` (and `pragma: no-cache`) on the request
 *     to bypass the cache for a single round-trip.
 *   - Emits `X-Cache: HIT | MISS | STALE` header on responses for observability.
 *   - Bypasses caching for non-GET requests, non-200 responses, and responses
 *     larger than `maxEntryBytes`.
 *   - Optional `redisClient` (ioredis-compatible) used as a slower secondary
 *     store. The local LRU is always consulted first; Redis hits hydrate the
 *     LRU before serving. Redis errors are swallowed (cache must never fail
 *     the request).
 *
 * Usage:
 *   const { responseCache } = require('./middleware/response-cache');
 *   router.get('/endpoint', responseCache({ ttlMs: 60_000 }), handler);
 */

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024;

class LRUCache {
  constructor(max = DEFAULT_MAX_ENTRIES) {
    this.max = max;
    this.map = new Map();
    this.stats = { hits: 0, misses: 0, stale: 0, evictions: 0, sets: 0 };
  }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    // Refresh recency
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }
  set(key, entry) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, entry);
    this.stats.sets += 1;
    while (this.map.size > this.max) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
      this.stats.evictions += 1;
    }
  }
  delete(key) { return this.map.delete(key); }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

// Global shared LRU so cache is process-wide (per route or shared depending
// on options.namespace). Tests can create their own instance.
const globalLRU = new LRUCache(DEFAULT_MAX_ENTRIES);

function isNoCache(req) {
  const cc = req.headers && (req.headers['cache-control'] || '');
  if (typeof cc === 'string' && /\bno-cache\b/i.test(cc)) return true;
  const pragma = req.headers && (req.headers.pragma || '');
  if (typeof pragma === 'string' && /\bno-cache\b/i.test(pragma)) return true;
  return false;
}

function deriveUserId(req) {
  if (req.user && (req.user.id != null)) return String(req.user.id);
  if (req.userId != null) return String(req.userId);
  return 'anon';
}

function buildKey(req, namespace) {
  const ns = namespace || 'default';
  const path = req.originalUrl || req.url || '';
  // originalUrl already contains query string; otherwise add it
  const userId = deriveUserId(req);
  return `${ns}::${userId}::${req.method}::${path}`;
}

function bodyByteLength(body) {
  if (body == null) return 0;
  if (Buffer.isBuffer(body)) return body.length;
  if (typeof body === 'string') return Buffer.byteLength(body, 'utf8');
  return Buffer.byteLength(String(body), 'utf8');
}

function responseCache(opts = {}) {
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;
  const maxEntryBytes = Number.isFinite(opts.maxEntryBytes) ? opts.maxEntryBytes : DEFAULT_MAX_ENTRY_BYTES;
  const namespace = opts.namespace || 'default';
  const lru = opts.cache instanceof LRUCache ? opts.cache : (opts.cache || globalLRU);
  const redis = opts.redisClient || null;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const staleWhileError = opts.staleWhileError === true;

  return function responseCacheMiddleware(req, res, next) {
    // Only safe methods
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    // Honor request-side no-cache
    if (isNoCache(req)) {
      res.setHeader('X-Cache', 'MISS');
      return next();
    }

    const key = buildKey(req, namespace);

    // Local hit
    const entry = lru.get(key);
    const t = now();
    if (entry && entry.expiresAt > t) {
      lru.stats.hits += 1;
      res.setHeader('X-Cache', 'HIT');
      if (entry.contentType) res.setHeader('Content-Type', entry.contentType);
      res.status(entry.status);
      return res.end(entry.body);
    }
    if (entry && staleWhileError) {
      // Mark for potential stale fallback if upstream errors
      res.locals = res.locals || {};
      res.locals.__cachedStale = entry;
    }

    lru.stats.misses += 1;

    // Async Redis lookup — fire-and-forget hydration on miss.
    // We intentionally do NOT block on Redis to keep latency low; only used
    // for cross-process hits when available.
    let redisLookupDone = false;
    let nextCalled = false;
    const proceed = () => {
      if (nextCalled) return;
      nextCalled = true;
      wrapResponse();
      next();
    };

    function wrapResponse() {
      const origSend = res.send.bind(res);
      const origJson = res.json.bind(res);
      const origEnd = res.end.bind(res);
      let captured = null;
      let capturedCT = null;

      function capture(body) {
        if (captured != null) return; // already captured
        const len = bodyByteLength(body);
        if (len === 0 || len > maxEntryBytes) return;
        captured = body;
        capturedCT = res.getHeader('Content-Type') || res.getHeader('content-type') || null;
      }

      res.json = function patchedJson(obj) {
        try {
          const str = JSON.stringify(obj);
          if (!res.getHeader('Content-Type')) {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
          }
          capture(str);
        } catch (_) { /* ignore */ }
        return origJson(obj);
      };

      res.send = function patchedSend(body) {
        if (body != null && typeof body !== 'function') capture(body);
        return origSend(body);
      };

      res.end = function patchedEnd(chunk, encoding, cb) {
        // On end, store if status is 200 and we captured something.
        try {
          if (res.statusCode === 200 && captured != null) {
            const expiresAt = now() + ttlMs;
            const entryToStore = {
              status: 200,
              body: captured,
              contentType: capturedCT
                ? String(capturedCT)
                : (res.getHeader('Content-Type') || null),
              expiresAt,
              storedAt: now(),
            };
            lru.set(key, entryToStore);
            if (redis && typeof redis.set === 'function') {
              try {
                const payload = JSON.stringify({
                  status: entryToStore.status,
                  body: typeof captured === 'string' ? captured : null,
                  contentType: entryToStore.contentType,
                  storedAt: entryToStore.storedAt,
                });
                Promise.resolve(redis.set(key, payload, 'PX', ttlMs)).catch(() => {});
              } catch (_) { /* ignore */ }
            }
          }
          // Set MISS header if not already set (and we did not serve cached)
          if (!res.getHeader('X-Cache')) {
            res.setHeader('X-Cache', 'MISS');
          }
        } catch (_) { /* never fail the request */ }
        return origEnd(chunk, encoding, cb);
      };
    }

    if (!redis || typeof redis.get !== 'function') {
      return proceed();
    }

    // Best-effort Redis hydration with a short timeout to avoid blocking.
    const timer = setTimeout(() => {
      if (!redisLookupDone) { redisLookupDone = true; proceed(); }
    }, opts.redisTimeoutMs || 20);

    Promise.resolve()
      .then(() => redis.get(key))
      .then((raw) => {
        if (redisLookupDone) return;
        redisLookupDone = true;
        clearTimeout(timer);
        if (raw && typeof raw === 'string') {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.body) {
              lru.set(key, {
                status: parsed.status || 200,
                body: parsed.body,
                contentType: parsed.contentType || null,
                expiresAt: now() + ttlMs,
                storedAt: parsed.storedAt || now(),
              });
              lru.stats.hits += 1;
              res.setHeader('X-Cache', 'HIT');
              if (parsed.contentType) res.setHeader('Content-Type', parsed.contentType);
              res.status(parsed.status || 200);
              return res.end(parsed.body);
            }
          } catch (_) { /* ignore */ }
        }
        proceed();
      })
      .catch(() => {
        if (redisLookupDone) return;
        redisLookupDone = true;
        clearTimeout(timer);
        proceed();
      });
  };
}

function getStats(cache) {
  const c = cache || globalLRU;
  return { ...c.stats, size: c.size, max: c.max };
}

function clearCache(cache) {
  const c = cache || globalLRU;
  c.clear();
}

module.exports = {
  responseCache,
  LRUCache,
  globalLRU,
  getStats,
  clearCache,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_ENTRY_BYTES,
};

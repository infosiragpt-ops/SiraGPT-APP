'use strict';

/**
 * idempotency — Express middleware that gives POST endpoints the
 * Stripe-style `Idempotency-Key` semantic: a client retry after a
 * network blip does not re-execute the operation, it returns the
 * cached response from the first successful run.
 *
 * Three Stripe-equivalent properties are load-bearing here:
 *
 *   1. Replay — second call with the same key returns the captured
 *      2xx body from the first call within the TTL window (24h
 *      default).
 *
 *   2. Body fingerprint — second call with the SAME key but a
 *      DIFFERENT body returns 409. A client that mutates the request
 *      payload while reusing an idempotency key is almost always a
 *      bug; replaying the wrong response would silently corrupt
 *      state, so we surface the conflict instead.
 *
 *   3. In-flight lock — concurrent calls with the same key wait for
 *      the first one to finish, OR fast-fail with 409 if the lock
 *      cannot be acquired within `lockTimeoutMs`. This stops the
 *      classic "double-click on a flaky network" race where two
 *      copies of the same expensive operation run in parallel.
 *
 * Storage: Redis when REDIS_URL is set, in-memory Map fallback.
 * Lazy GC on read/write — no setInterval that would prevent process
 * shutdown. The fallback store is good enough for single-instance
 * dev and CI; production benefits from the Redis lock being globally
 * coherent across workers.
 *
 * What is NOT cached:
 *   - GET / HEAD / OPTIONS / DELETE: idempotent (or unsafe-to-cache)
 *     by HTTP semantics, no key needed.
 *   - 4xx / 5xx responses by default. A 500 from a transient bug
 *     should NOT lock subsequent retries into the same failure for
 *     24h. The cache only retains responses with `2xx` status; a
 *     failure leaves the slot unused so the next retry runs fresh.
 *   - SSE streams (text/event-stream). The proxy never fires for
 *     streaming responses; the handler still runs.
 *
 * Disabled by default. Activates when IDEMPOTENCY_ENABLED=true.
 * Even when disabled, malformed `Idempotency-Key` headers (too long,
 * non-string) still get rejected with a 400 — that protects against
 * dictionary attacks on the cache key namespace.
 */

const crypto = require('crypto');

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 50;
const DEFAULT_MAX_KEY_LEN = 256;
const DEFAULT_MIN_KEY_LEN = 1;
const REPLAY_HEADER = 'X-Idempotency-Replay';
const REPLAY_KEY_HEADER = 'X-Idempotency-Key-Echo';

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function resolveIdempotencyConfig(env = process.env) {
  return {
    enabled: parseBoolean(env.IDEMPOTENCY_ENABLED, false),
    ttlSeconds: clampInt(env.IDEMPOTENCY_TTL_SECONDS, DEFAULT_TTL_SECONDS, 60, 7 * 24 * 3600),
    maxKeyLen: clampInt(env.IDEMPOTENCY_MAX_KEY_LEN, DEFAULT_MAX_KEY_LEN, 8, 1024),
    lockTimeoutMs: clampInt(env.IDEMPOTENCY_LOCK_TIMEOUT_MS, DEFAULT_LOCK_TIMEOUT_MS, 100, 5 * 60_000),
    lockPollMs: clampInt(env.IDEMPOTENCY_LOCK_POLL_MS, DEFAULT_LOCK_POLL_MS, 5, 5_000),
    redisPrefix: String(env.IDEMPOTENCY_REDIS_PREFIX || 'idem:'),
  };
}

/**
 * stableStringify — canonical JSON for body hashing. Object key order
 * cannot affect the hash, otherwise a client serializing the same
 * logical payload with different key ordering would trip a 409
 * mismatch.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function computeBodyHash(body) {
  if (body === undefined) return null;
  try {
    const serialized = stableStringify(body);
    if (serialized === undefined) return null;
    return crypto.createHash('sha256').update(serialized).digest('hex');
  } catch (_err) {
    return null;
  }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/**
 * createInMemoryIdempotencyStore — Map-based, lazy-GC'd. Used when
 * REDIS_URL is unset or for tests. The map is bounded by TTL alone;
 * a future-pressure-cap is unnecessary because the per-user key
 * space is bounded by the rate limiter (a user can mint at most
 * RATE_LIMIT_API_MAX × TTL keys before the limiter cuts them off).
 *
 * Two record states share the same map:
 *   { state: 'pending', bodyHash, expiresAt }   — in-flight lock
 *   { state: 'final',   status, body, headers, bodyHash, expiresAt }
 *
 * tryAcquire(key, bodyHash, lockTtlMs) atomically inserts a pending
 * record only if no record exists. Returns:
 *   { acquired: true }                         — caller owns the slot
 *   { acquired: false, existing }              — somebody else has it
 */
function createInMemoryIdempotencyStore({ ttlSeconds = DEFAULT_TTL_SECONDS, now = () => Date.now() } = {}) {
  const map = new Map();
  function gc() {
    const cutoff = now();
    for (const [key, entry] of map) {
      if (entry.expiresAt <= cutoff) map.delete(key);
    }
  }
  return {
    mode: 'memory',
    async get(key) {
      gc();
      const entry = map.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        map.delete(key);
        return null;
      }
      return entry;
    },
    async put(key, value, customTtlSeconds) {
      gc();
      const ttl = (typeof customTtlSeconds === 'number' && customTtlSeconds > 0)
        ? customTtlSeconds
        : ttlSeconds;
      map.set(key, { ...value, expiresAt: now() + ttl * 1000 });
    },
    async tryAcquire(key, bodyHash, lockTtlMs) {
      gc();
      const existing = map.get(key);
      if (existing && existing.expiresAt > now()) {
        return { acquired: false, existing };
      }
      map.set(key, {
        state: 'pending',
        bodyHash: bodyHash || null,
        expiresAt: now() + lockTtlMs,
      });
      return { acquired: true };
    },
    async release(key) {
      const existing = map.get(key);
      if (existing && existing.state === 'pending') {
        map.delete(key);
      }
    },
    _size() { return map.size; },
  };
}

function createRedisIdempotencyStore({ redis, prefix, ttlSeconds }) {
  return {
    mode: 'redis',
    async get(key) {
      try {
        const raw = await redis.get(`${prefix}${key}`);
        if (!raw) return null;
        return JSON.parse(raw);
      } catch (_err) {
        return null;
      }
    },
    async put(key, value, customTtlSeconds) {
      const ttl = (typeof customTtlSeconds === 'number' && customTtlSeconds > 0)
        ? customTtlSeconds
        : ttlSeconds;
      try {
        await redis.set(`${prefix}${key}`, JSON.stringify(value), 'EX', ttl);
      } catch (_err) {
        // best-effort; a failed put just means the next retry runs the handler.
      }
    },
    async tryAcquire(key, bodyHash, lockTtlMs) {
      try {
        const payload = JSON.stringify({ state: 'pending', bodyHash: bodyHash || null });
        const setRes = await redis.set(`${prefix}${key}`, payload, 'PX', lockTtlMs, 'NX');
        if (setRes) return { acquired: true };
        const raw = await redis.get(`${prefix}${key}`);
        return { acquired: false, existing: raw ? JSON.parse(raw) : null };
      } catch (_err) {
        // If Redis flakes we degrade to "acquired" so the request
        // proceeds rather than hanging. The trade-off is one
        // duplicate execution under split-brain — preferable to a
        // wedged client retry loop.
        return { acquired: true };
      }
    },
    async release(key) {
      try {
        const raw = await redis.get(`${prefix}${key}`);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.state === 'pending') {
          await redis.del(`${prefix}${key}`);
        }
      } catch (_err) {
        // best-effort
      }
    },
  };
}

let cachedRedisClient = null;
function loadRedisClient(env) {
  if (cachedRedisClient) return cachedRedisClient;
  if (!env.REDIS_URL) return null;
  let IORedis;
  try {
    IORedis = require('ioredis');
  } catch (_err) {
    return null;
  }
  cachedRedisClient = new IORedis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    connectTimeout: 2000,
  });
  cachedRedisClient.on('error', () => {});
  return cachedRedisClient;
}

function createIdempotencyStore(env = process.env, options = {}) {
  const config = resolveIdempotencyConfig(env);
  if (options.forceMemory) {
    return createInMemoryIdempotencyStore({ ttlSeconds: config.ttlSeconds });
  }
  const redis = options.redis || loadRedisClient(env);
  if (!redis) {
    return createInMemoryIdempotencyStore({ ttlSeconds: config.ttlSeconds });
  }
  return createRedisIdempotencyStore({
    redis,
    prefix: config.redisPrefix,
    ttlSeconds: config.ttlSeconds,
  });
}

/**
 * buildCacheKey — `idem:user:<id>:<key>` for authenticated, or
 * `idem:ip:<ip>:<key>` for anonymous. Tenant scoping (separate
 * cache namespace per user) is the load-bearing property: User A's
 * idempotency key MUST NOT replay a response captured by User B
 * even if they pick the same string.
 */
function buildCacheKey(req, idempotencyKey) {
  const userId = req && req.user && req.user.id;
  if (userId) return `user:${userId}:${idempotencyKey}`;
  const ip = (req && req.ip) || 'unknown';
  return `ip:${ip}:${idempotencyKey}`;
}

function isStreamingResponse(res) {
  const ct = String(res.getHeader && res.getHeader('content-type') || '').toLowerCase();
  return ct.includes('text/event-stream');
}

function replayCached(res, cached, rawKey) {
  res.setHeader(REPLAY_HEADER, 'true');
  res.setHeader(REPLAY_KEY_HEADER, rawKey);
  if (cached.headers && typeof cached.headers === 'object') {
    for (const [name, value] of Object.entries(cached.headers)) {
      // Don't echo Set-Cookie from a cached response — cookies
      // bind to a session that may have rotated since.
      if (name.toLowerCase() === 'set-cookie') continue;
      res.setHeader(name, value);
    }
  }
  return res.status(cached.status).json(cached.body);
}

function respondMismatch(res, rawKey) {
  res.setHeader(REPLAY_HEADER, 'mismatch');
  res.setHeader(REPLAY_KEY_HEADER, rawKey);
  return res.status(409).json({
    error: 'idempotency-key-mismatch',
    hint: 'this Idempotency-Key was already used with a different request body within the TTL window',
  });
}

function respondInProgress(res, rawKey) {
  res.setHeader(REPLAY_HEADER, 'in-progress');
  res.setHeader(REPLAY_KEY_HEADER, rawKey);
  return res.status(409).json({
    error: 'idempotency-key-in-progress',
    hint: 'a request with this Idempotency-Key is still being processed; retry after it completes',
  });
}

/**
 * idempotencyMiddleware — factory. Pass `{ store }` for tests; in
 * production the factory builds a Redis-or-memory store from env.
 */
function idempotencyMiddleware(options = {}) {
  const env = options.env || process.env;
  const config = resolveIdempotencyConfig(env);
  const store = options.store || createIdempotencyStore(env);
  const lockTimeoutMs = typeof options.lockTimeoutMs === 'number' ? options.lockTimeoutMs : config.lockTimeoutMs;
  // lockHoldMs is how long a pending lock survives in the store
  // (defaults to lockTimeoutMs). Tests decouple it so a short wait
  // timeout can be observed without racing the lock's own expiry.
  const lockHoldMs = typeof options.lockHoldMs === 'number' ? options.lockHoldMs : lockTimeoutMs;
  const lockPollMs = typeof options.lockPollMs === 'number' ? options.lockPollMs : config.lockPollMs;
  const now = options.now || (() => Date.now());

  return async function idempotency(req, res, next) {
    // Only POST/PUT/PATCH benefit. GET/HEAD/OPTIONS are idempotent
    // by HTTP semantics; DELETE is also idempotent in spec but
    // operationally side-effectful — clients typically don't retry
    // DELETE, so we don't cache it either to avoid an unintuitive
    // 24h "the resource appears deleted" replay.
    if (!req || !['POST', 'PUT', 'PATCH'].includes(req.method)) {
      return next();
    }

    const rawKey = req.headers['idempotency-key']
      || req.headers['Idempotency-Key']
      || null;
    if (!rawKey) {
      // No key → no idempotency. The endpoint runs as before.
      return next();
    }
    if (typeof rawKey !== 'string'
      || rawKey.length < DEFAULT_MIN_KEY_LEN
      || rawKey.length > config.maxKeyLen) {
      return res.status(400).json({
        error: 'invalid Idempotency-Key',
        hint: `must be a string of ${DEFAULT_MIN_KEY_LEN}-${config.maxKeyLen} characters`,
      });
    }

    if (!config.enabled) {
      // The header was well-formed; we'd cache if the feature were
      // on. Surface a sentinel header so the client can detect that
      // their key was accepted but not cached.
      res.setHeader(REPLAY_HEADER, 'disabled');
      res.setHeader(REPLAY_KEY_HEADER, rawKey);
      return next();
    }

    const cacheKey = buildCacheKey(req, rawKey);
    const bodyHash = computeBodyHash(req.body);

    // First check for an already-final cached response. Common case
    // (genuine retry) hits here and short-circuits before any locking.
    const cachedExisting = await store.get(cacheKey);
    if (cachedExisting && cachedExisting.state === 'final') {
      if (cachedExisting.bodyHash && bodyHash && cachedExisting.bodyHash !== bodyHash) {
        return respondMismatch(res, rawKey);
      }
      return replayCached(res, cachedExisting, rawKey);
    }

    // Try to claim the lock. If somebody else owns it, we either
    // wait for them to finish (same body) or fast-fail (different
    // body, or wait timed out).
    let acquired = false;
    let lastSeen = cachedExisting || null;
    const deadline = now() + lockTimeoutMs;
    while (true) {
      const attempt = await store.tryAcquire(cacheKey, bodyHash, lockHoldMs);
      if (attempt.acquired) {
        acquired = true;
        break;
      }
      const existing = attempt.existing;
      if (existing && existing.state === 'final') {
        if (existing.bodyHash && bodyHash && existing.bodyHash !== bodyHash) {
          return respondMismatch(res, rawKey);
        }
        return replayCached(res, existing, rawKey);
      }
      if (existing && existing.state === 'pending') {
        if (existing.bodyHash && bodyHash && existing.bodyHash !== bodyHash) {
          return respondMismatch(res, rawKey);
        }
      }
      if (now() >= deadline) {
        return respondInProgress(res, rawKey);
      }
      lastSeen = existing;
      await delay(lockPollMs);
    }
    void lastSeen;

    res.setHeader(REPLAY_HEADER, 'fresh');
    res.setHeader(REPLAY_KEY_HEADER, rawKey);

    // Capture the response body. We monkey-patch res.json (the path
    // every JSON-returning route uses) but NOT res.write / res.end
    // — streaming responses are intentionally not cached and the
    // SSE check below catches them.
    let settled = false;
    const originalJson = res.json.bind(res);
    res.json = function patchedJson(body) {
      const status = res.statusCode || 200;
      settled = true;
      // Only cache 2xx. A 500 should not lock retries into a stale
      // failure for 24h.
      if (status >= 200 && status < 300 && !isStreamingResponse(res)) {
        // Capture a small set of headers that affect rendering. We
        // explicitly do NOT capture auth-related headers.
        const headersToCache = {};
        for (const name of ['content-type', 'cache-control']) {
          const v = res.getHeader(name);
          if (v !== undefined) headersToCache[name] = v;
        }
        // Fire-and-forget: a slow Redis put should never block the
        // response. Errors are swallowed by the store.
        void store.put(cacheKey, {
          state: 'final',
          status,
          body,
          headers: headersToCache,
          bodyHash,
        });
      } else {
        // Non-2xx or streaming: drop the pending lock so subsequent
        // retries can run fresh instead of waiting on a phantom slot.
        if (acquired) void store.release(cacheKey);
      }
      return originalJson(body);
    };

    // If the handler ends without calling res.json (e.g. throws or
    // streams), release the lock when the response closes so the
    // next retry isn't blocked for the full lock TTL.
    if (typeof res.on === 'function') {
      res.on('close', () => {
        if (!settled && acquired) void store.release(cacheKey);
      });
      res.on('finish', () => {
        if (!settled && acquired) void store.release(cacheKey);
      });
    }

    return next();
  };
}

module.exports = {
  idempotencyMiddleware,
  resolveIdempotencyConfig,
  createIdempotencyStore,
  createInMemoryIdempotencyStore,
  createRedisIdempotencyStore,
  buildCacheKey,
  computeBodyHash,
  stableStringify,
  REPLAY_HEADER,
  REPLAY_KEY_HEADER,
  DEFAULT_TTL_SECONDS,
  DEFAULT_LOCK_TIMEOUT_MS,
};

'use strict';

/**
 * idempotency — Express middleware that gives POST endpoints the
 * Stripe-style `Idempotency-Key` semantic: a client retry after a
 * network blip does not re-execute the operation, it returns the
 * cached response from the first successful run.
 *
 * Why this exists:
 *   The platform has expensive POST endpoints (agent task creation,
 *   document generation, payment webhooks) where a duplicate
 *   submission costs real money — LLM tokens, sandbox compute,
 *   sometimes literal Stripe charges. Mobile clients on flaky
 *   networks retry aggressively. Without idempotency keys, the
 *   server has no way to distinguish "the user clicked twice" from
 *   "the user clicked once but the response was lost in flight".
 *
 * How it works:
 *   1. Client picks a UUID per logical operation, sends it as
 *      `Idempotency-Key: <uuid>` on the POST.
 *   2. Middleware computes a cache key as `idem:<userId>:<key>`
 *      (anonymous traffic uses `idem:ip:<ip>:<key>`).
 *   3. If the cache hit, the cached `{ status, body, headers }` is
 *      replayed. The response includes `X-Idempotency-Replay: true`
 *      so the client / dashboards can spot replays.
 *   4. On a miss, the original handler runs. The response is captured
 *      via a `res.json` proxy and stored with a 24h TTL. Subsequent
 *      retries within the TTL get the same response.
 *
 * Storage:
 *   Same posture as rate-limit-store + webauthn-challenge-store:
 *   Redis when REDIS_URL is set, in-memory Map fallback. Lazy GC
 *   on read/write for the in-memory mode — no setInterval that
 *   would prevent process shutdown.
 *
 * What is NOT cached:
 *   - GET / HEAD / OPTIONS: idempotent by HTTP semantics, no key needed.
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

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
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
    redisPrefix: String(env.IDEMPOTENCY_REDIS_PREFIX || 'idem:'),
  };
}

/**
 * createInMemoryIdempotencyStore — Map-based, lazy-GC'd. Used when
 * REDIS_URL is unset or for tests. The map is bounded by TTL alone;
 * a future-pressure-cap is unnecessary because the per-user key
 * space is bounded by the rate limiter (a user can mint at most
 * RATE_LIMIT_API_MAX × TTL keys before the limiter cuts them off).
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
      return entry.value;
    },
    async put(key, value, customTtlSeconds) {
      gc();
      const ttl = (typeof customTtlSeconds === 'number' && customTtlSeconds > 0)
        ? customTtlSeconds
        : ttlSeconds;
      map.set(key, { value, expiresAt: now() + ttl * 1000 });
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

/**
 * idempotencyMiddleware — factory. Pass `{ store }` for tests; in
 * production the factory builds a Redis-or-memory store from env.
 */
function idempotencyMiddleware(options = {}) {
  const env = options.env || process.env;
  const config = resolveIdempotencyConfig(env);
  const store = options.store || createIdempotencyStore(env);

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
    const cached = await store.get(cacheKey);
    if (cached && cached.status && cached.body !== undefined) {
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

    res.setHeader(REPLAY_HEADER, 'fresh');
    res.setHeader(REPLAY_KEY_HEADER, rawKey);

    // Capture the response body. We monkey-patch res.json (the path
    // every JSON-returning route uses) but NOT res.write / res.end
    // — streaming responses are intentionally not cached and the
    // SSE check below catches them.
    const originalJson = res.json.bind(res);
    res.json = function patchedJson(body) {
      const status = res.statusCode || 200;
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
          status,
          body,
          headers: headersToCache,
        });
      }
      return originalJson(body);
    };

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
  REPLAY_HEADER,
  REPLAY_KEY_HEADER,
  DEFAULT_TTL_SECONDS,
};

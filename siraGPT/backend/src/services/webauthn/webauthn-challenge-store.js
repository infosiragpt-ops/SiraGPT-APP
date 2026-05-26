'use strict';

/**
 * webauthn-challenge-store — short-lived storage for the random
 * challenge bytes that WebAuthn registration / authentication flows
 * need to round-trip between the browser and the server.
 *
 * Why this exists as its own module:
 *   The challenge MUST be generated server-side, sent to the client,
 *   echoed back inside the signed authenticator response, and then
 *   verified server-side. That means we need a tiny key/value store
 *   keyed by `userId + flow` ("registration" / "authentication") with
 *   a TTL of ~5 minutes.
 *
 *   Two real backends:
 *     - Redis when REDIS_URL is set (multi-instance deploys; the
 *       challenge survives a load-balancer hop).
 *     - In-memory Map fallback for local dev / single-instance.
 *
 *   The fallback is keyed AND time-bucketed so a stale process
 *   doesn't accumulate dead challenges forever. Pruning happens on
 *   every read AND on every write (lazy GC; no setInterval that
 *   would prevent process shutdown).
 *
 *   ioredis is required when REDIS_URL is set; it's already a
 *   project dependency (rate-limit-redis + bull-board) so no new
 *   install. The Redis helper degrades gracefully — a network blip
 *   surfaces as `null` from get(), which the verification handler
 *   treats as an expired challenge.
 *
 * Public API:
 *   - put(userId, flow, challenge) → Promise<void>
 *   - get(userId, flow)           → Promise<string | null>
 *   - del(userId, flow)           → Promise<void>
 *   - createInMemoryStore()       test-friendly factory
 *   - createWebAuthnChallengeStore(env) main factory; picks Redis or memory.
 */

const DEFAULT_TTL_SECONDS = 5 * 60;

function buildKey(userId, flow, prefix) {
  return `${prefix}${flow}:${userId}`;
}

function createInMemoryStore({ ttlSeconds = DEFAULT_TTL_SECONDS, now = () => Date.now() } = {}) {
  const map = new Map();
  function gc() {
    const cutoff = now();
    for (const [key, entry] of map) {
      if (entry.expiresAt <= cutoff) map.delete(key);
    }
  }
  return {
    mode: 'memory',
    async put(userId, flow, challenge) {
      gc();
      const key = `${flow}:${userId}`;
      map.set(key, { challenge, expiresAt: now() + ttlSeconds * 1000 });
    },
    async get(userId, flow) {
      gc();
      const key = `${flow}:${userId}`;
      const entry = map.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        map.delete(key);
        return null;
      }
      return entry.challenge;
    },
    async del(userId, flow) {
      map.delete(`${flow}:${userId}`);
    },
    _size() { return map.size; },
  };
}

function createRedisStore({ redis, prefix = 'wac:', ttlSeconds = DEFAULT_TTL_SECONDS }) {
  return {
    mode: 'redis',
    async put(userId, flow, challenge) {
      const key = buildKey(userId, flow, prefix);
      try {
        await redis.set(key, challenge, 'EX', ttlSeconds);
      } catch (_err) {
        // best-effort — challenges are short-lived and a Redis hiccup
        // just makes the user retry the flow.
      }
    },
    async get(userId, flow) {
      const key = buildKey(userId, flow, prefix);
      try {
        return await redis.get(key);
      } catch (_err) {
        return null;
      }
    },
    async del(userId, flow) {
      const key = buildKey(userId, flow, prefix);
      try {
        await redis.del(key);
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

function createWebAuthnChallengeStore(env = process.env, options = {}) {
  // Tests can inject a redis client / disable the real path.
  if (options.forceMemory) return createInMemoryStore({ ttlSeconds: options.ttlSeconds });
  const redis = options.redis || loadRedisClient(env);
  if (!redis) return createInMemoryStore({ ttlSeconds: options.ttlSeconds });
  return createRedisStore({
    redis,
    prefix: options.prefix || env.WEBAUTHN_CHALLENGE_REDIS_PREFIX || 'wac:',
    ttlSeconds: options.ttlSeconds || DEFAULT_TTL_SECONDS,
  });
}

module.exports = {
  createInMemoryStore,
  createRedisStore,
  createWebAuthnChallengeStore,
  DEFAULT_TTL_SECONDS,
};

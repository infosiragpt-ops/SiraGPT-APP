'use strict';

/**
 * rate-limit-store — factory that returns a Redis-backed store for
 * `express-rate-limit` when REDIS_URL is configured, or `null` to let
 * the caller fall back to express-rate-limit's default in-memory
 * store.
 *
 * Why we want Redis here:
 *   The previous setup (in-memory map per process) broke as soon as
 *   the backend horizontally scaled — three replicas each held
 *   independent counters, so the effective per-IP cap was 3x what
 *   was configured. Redis-backed counters share state across
 *   replicas so caps mean what they say.
 *
 * Why we still tolerate Redis being unhealthy:
 *   The readiness probe in index.js gates traffic when Redis is
 *   down, so a Redis-backed limiter has a chicken-and-egg problem on
 *   cold start — the limiter needs Redis, but Redis needs the probe
 *   to declare readiness, but the probe runs through middleware that
 *   needs the limiter… To break this loop:
 *
 *     - The IORedis client is configured `lazyConnect: true` and
 *       `enableOfflineQueue: true`, so creating the client does not
 *       block boot.
 *
 *     - The limiter is created with `passOnStoreError: true`, so a
 *       transient Redis hiccup lets requests through (rate-limit
 *       fails open, the rest of the stack stays up). The same
 *       request still hits Sentry / pino-error / health-check, so
 *       the operator gets paged through normal channels.
 *
 *   Net: when Redis is healthy we have shared counters; when Redis
 *   is sick we have an outage of rate-limiting only, not of the API.
 *
 * If you want to force the in-memory store (e.g. local dev without
 * Redis), set `RATE_LIMIT_STORE=memory`. Setting `RATE_LIMIT_STORE=
 * redis` without REDIS_URL is treated as misconfiguration — the
 * factory returns null and the caller logs a warning at boot.
 */

let cachedRedisClient = null;

function shouldUseRedis(env) {
  const explicit = String(env.RATE_LIMIT_STORE || '').trim().toLowerCase();
  if (explicit === 'memory') return false;
  if (explicit === 'redis') return Boolean(env.REDIS_URL);
  // Auto: prefer Redis when the URL is set, fall back to memory.
  return Boolean(env.REDIS_URL);
}

function createRedisClient(redisUrl) {
  if (!redisUrl) return null;
  if (cachedRedisClient) return cachedRedisClient;
  let IORedis;
  try {
    IORedis = require('ioredis');
  } catch (_err) {
    return null;
  }
  cachedRedisClient = new IORedis(redisUrl, {
    // Don't block boot with a synchronous connect; first command
    // wakes the connection up. If Redis is reachable, this happens
    // on the first /api/ request.
    lazyConnect: true,
    // One retry per command keeps p99 sane while still tolerating a
    // single-packet drop. The store will surface the error to
    // express-rate-limit, which fails open via passOnStoreError.
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    connectTimeout: 2000,
    // Distinct key prefix so a Redis instance shared with BullMQ
    // and other services doesn't see name collisions.
    keyPrefix: '',
  });
  // Swallow background "ECONNREFUSED" / "ETIMEDOUT" so they don't
  // crash the process. The store path observes errors when it
  // actually tries to issue a command.
  cachedRedisClient.on('error', () => {});
  return cachedRedisClient;
}

/**
 * createRateLimitStore — build a RedisStore + ioredis client pair
 * suitable for passing as `store:` to express-rate-limit.
 *
 * Returns:
 *   { store, redis, mode: 'redis' }   when Redis is configured + reachable wiring succeeded
 *   { store: null, redis: null, mode: 'memory', reason }  to indicate a fallback
 *
 * The caller decides what to do on `mode: 'memory'` — typically log
 * a one-line warn at boot and proceed without setting `store:` on the
 * limiter (express-rate-limit then uses its default memory store).
 */
function createRateLimitStore(env = process.env, options = {}) {
  if (!shouldUseRedis(env)) {
    return {
      store: null,
      redis: null,
      mode: 'memory',
      reason: env.RATE_LIMIT_STORE === 'memory'
        ? 'forced_memory_store'
        : 'no_redis_url',
    };
  }

  let RedisStoreCtor;
  try {
    ({ RedisStore: RedisStoreCtor } = require('rate-limit-redis'));
  } catch (err) {
    return {
      store: null,
      redis: null,
      mode: 'memory',
      reason: `rate-limit-redis_not_installed: ${err.message}`,
    };
  }

  const redis = createRedisClient(env.REDIS_URL);
  if (!redis) {
    return {
      store: null,
      redis: null,
      mode: 'memory',
      reason: 'redis_client_init_failed',
    };
  }

  const prefix = options.prefix || env.RATE_LIMIT_REDIS_PREFIX || 'rl:';
  const store = new RedisStoreCtor({
    // ioredis exposes `call(cmd, ...args)` for low-level commands;
    // rate-limit-redis v4's contract is `sendCommand(...args)` returning
    // the raw reply. `redis.call.bind(redis)` honors that contract and
    // preserves the connection's pipeline / retry settings.
    sendCommand: (...args) => redis.call(...args),
    prefix,
  });

  return { store, redis, mode: 'redis', reason: 'ready' };
}

module.exports = {
  createRateLimitStore,
  shouldUseRedis,
};

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

// ─────────────────────────────────────────────────────────────────────
// Sliding-window consume() API
// ─────────────────────────────────────────────────────────────────────
//
// Some callers (e.g. cowork SSE endpoints, agent task spawns, scientific
// search bursts) need a programmatic rate-limit check that doesn't live
// inside an express middleware. They want:
//
//   const { allowed, remaining, resetAt } =
//     await rateLimitStore.consume(key, limit, windowMs);
//
// When `REDIS_URL` is set the counter is a Redis ZSET (sliding-window
// log) shared across replicas via an atomic MULTI/EXEC pipeline:
//
//   1. ZREMRANGEBYSCORE key -inf (now - window)
//   2. ZADD key now random-member
//   3. ZCARD key
//   4. PEXPIRE key window
//
// When Redis is unreachable (first attempt fails) we fall back to an
// in-memory map for that process and log one WARN. Subsequent attempts
// re-try Redis lazily once the breaker reopens (every 30s).

const FALLBACK_RETRY_MS = 30_000;
const FALLBACK_MEMORY = new Map();
let _fallbackWarned = false;
let _redisDeadUntil = 0;
let _logger = null;

function _warn(msg, err) {
  if (_fallbackWarned) return;
  _fallbackWarned = true;
  const detail = err && err.message ? ` (${err.message})` : '';
  const line = `[rate-limit-store] Redis unavailable, using in-memory fallback${detail}`;
  if (_logger && typeof _logger.warn === 'function') _logger.warn(line);
  // eslint-disable-next-line no-console
  else console.warn(line);
}

function _consumeMemory(key, limit, windowMs, now) {
  const windowStart = now - windowMs;
  let log = FALLBACK_MEMORY.get(key) || [];
  // Drop expired entries
  if (log.length && log[0] <= windowStart) {
    let i = 0;
    while (i < log.length && log[i] <= windowStart) i += 1;
    log = i === log.length ? [] : log.slice(i);
  }
  if (log.length >= limit) {
    FALLBACK_MEMORY.set(key, log);
    const oldest = log[0];
    return {
      allowed: false,
      remaining: 0,
      resetAt: new Date(oldest + windowMs),
    };
  }
  log.push(now);
  FALLBACK_MEMORY.set(key, log);
  return {
    allowed: true,
    remaining: Math.max(0, limit - log.length),
    resetAt: new Date(log[0] + windowMs),
  };
}

async function _consumeRedis(redis, key, limit, windowMs, now) {
  const windowStart = now - windowMs;
  // Unique member so concurrent calls don't collide on the same score.
  const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;
  const pipeline = redis.multi();
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zadd(key, now, member);
  pipeline.zcard(key);
  pipeline.pexpire(key, windowMs);
  const replies = await pipeline.exec();
  if (!Array.isArray(replies)) {
    throw new Error('redis_pipeline_no_replies');
  }
  // Surface any per-command error explicitly so we fall back gracefully
  for (const reply of replies) {
    if (Array.isArray(reply) && reply[0]) throw reply[0];
  }
  const card = Number(
    Array.isArray(replies[2]) ? replies[2][1] : replies[2],
  );
  if (card > limit) {
    // We exceeded — remove the entry we just inserted so the next call
    // still has a chance under the cap once older entries expire.
    try { await redis.zrem(key, member); } catch (_) { /* swallow */ }
    // resetAt = oldest score + windowMs
    let resetAt;
    try {
      const oldest = await redis.zrange(key, 0, 0, 'WITHSCORES');
      const oldestScore = Array.isArray(oldest) && oldest.length >= 2
        ? Number(oldest[1])
        : now;
      resetAt = new Date(oldestScore + windowMs);
    } catch (_) {
      resetAt = new Date(now + windowMs);
    }
    return { allowed: false, remaining: 0, resetAt };
  }
  return {
    allowed: true,
    remaining: Math.max(0, limit - card),
    resetAt: new Date(now + windowMs),
  };
}

/**
 * consume — atomic sliding-window check.
 *
 * @param {string} key       caller-namespaced key, e.g. "api:user:42"
 * @param {number} limit     max requests per window
 * @param {number} windowMs  window length in ms (default 60_000)
 * @returns {Promise<{ allowed: boolean, remaining: number, resetAt: Date }>}
 */
async function consume(key, limit, windowMs = 60_000, opts = {}) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('consume: key must be a non-empty string');
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new TypeError('consume: limit must be a positive number');
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError('consume: windowMs must be a positive number');
  }
  const env = opts.env || process.env;
  const now = typeof opts.now === 'function' ? opts.now() : Date.now();

  // Memory fallback explicitly forced or no Redis URL
  if (!shouldUseRedis(env)) {
    return _consumeMemory(key, limit, windowMs, now);
  }
  if (now < _redisDeadUntil) {
    return _consumeMemory(key, limit, windowMs, now);
  }
  const redis = opts.redis || createRedisClient(env.REDIS_URL);
  if (!redis) {
    _warn('redis client init failed');
    _redisDeadUntil = now + FALLBACK_RETRY_MS;
    return _consumeMemory(key, limit, windowMs, now);
  }
  try {
    return await _consumeRedis(redis, key, limit, windowMs, now);
  } catch (err) {
    _warn('redis pipeline failed', err);
    _redisDeadUntil = now + FALLBACK_RETRY_MS;
    return _consumeMemory(key, limit, windowMs, now);
  }
}

/** Test/maintenance helper — clears in-memory + fallback breaker state. */
function _resetForTests() {
  FALLBACK_MEMORY.clear();
  _fallbackWarned = false;
  _redisDeadUntil = 0;
  cachedRedisClient = null;
}

function setLogger(logger) {
  _logger = logger;
}

module.exports = {
  createRateLimitStore,
  shouldUseRedis,
  consume,
  setLogger,
  _resetForTests,
};

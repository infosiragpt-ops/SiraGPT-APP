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
const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 1000;
const DEFAULT_STORE_RETRY_AFTER_SECONDS = 5;

function _resolveRedisCommandTimeoutMs(env = process.env, override) {
  const raw = override ?? env.RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 10 && parsed <= 30_000) {
    return Math.floor(parsed);
  }
  return DEFAULT_REDIS_COMMAND_TIMEOUT_MS;
}

function _redisClientOptions(env = process.env, override = {}) {
  const commandTimeout = _resolveRedisCommandTimeoutMs(
    env,
    override.commandTimeoutMs,
  );
  return {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    connectTimeout: 2000,
    commandTimeout,
    keyPrefix: '',
  };
}

function _withRedisTimeout(promise, timeoutMs) {
  const boundedMs = _resolveRedisCommandTimeoutMs(
    {},
    timeoutMs,
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error('RATE_LIMIT_REDIS_COMMAND_TIMEOUT');
      error.code = 'RATE_LIMIT_REDIS_COMMAND_TIMEOUT';
      reject(error);
    }, boundedMs);

    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function shouldUseRedis(env) {
  const explicit = String(env.RATE_LIMIT_STORE || '').trim().toLowerCase();
  if (explicit === 'memory') return false;
  if (explicit === 'redis') return Boolean(env.REDIS_URL);
  // Auto: prefer Redis when the URL is set, fall back to memory.
  return Boolean(env.REDIS_URL);
}

function createRedisClient(redisUrl, env = process.env) {
  if (!redisUrl) return null;
  if (cachedRedisClient) return cachedRedisClient;
  let IORedis;
  try {
    IORedis = require('ioredis');
  } catch (_err) {
    return null;
  }
  cachedRedisClient = new IORedis(redisUrl, _redisClientOptions(env));
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

  const redis = options.redis || createRedisClient(env.REDIS_URL, env);
  if (!redis) {
    return {
      store: null,
      redis: null,
      mode: 'memory',
      reason: 'redis_client_init_failed',
    };
  }

  const prefix = options.prefix || env.RATE_LIMIT_REDIS_PREFIX || 'rl:';
  const commandTimeoutMs = _resolveRedisCommandTimeoutMs(
    env,
    options.commandTimeoutMs,
  );
  const store = new RedisStoreCtor({
    // ioredis exposes `call(cmd, ...args)` for low-level commands;
    // rate-limit-redis v4's contract is `sendCommand(...args)` returning
    // the raw reply. `redis.call.bind(redis)` honors that contract and
    // preserves the connection's pipeline / retry settings.
    sendCommand: (...args) => _withRedisTimeout(
      redis.call(...args),
      commandTimeoutMs,
    ),
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

const DEFAULT_FALLBACK_MAX_KEYS = 10_000;
const MAX_CONSUME_KEY_LENGTH = 512;
const RATE_LIMIT_STORE_UNAVAILABLE = 'RATE_LIMIT_STORE_UNAVAILABLE';
const MAX_ATOMIC_KEYS = 20;
const FALLBACK_MEMORY = new Map();
let _fallbackWarned = false;
let _redisDeadUntil = 0;
let _logger = null;

function _warn(msg, err, opts = {}) {
  if (_fallbackWarned) return;
  _fallbackWarned = true;
  const detail = err && err.message ? ` (${err.message})` : '';
  const line = opts.fallback === false
    ? '[rate-limit-store] distributed rate-limit store unavailable; rejecting sensitive request'
    : `[rate-limit-store] Redis unavailable, using in-memory fallback${detail}`;
  if (_logger && typeof _logger.warn === 'function') _logger.warn(line);
  // eslint-disable-next-line no-console
  else console.warn(line);
}

function _retryAfterSeconds(env = process.env) {
  const parsed = Number.parseInt(
    String(env.RATE_LIMIT_STORE_RETRY_AFTER_SECONDS || ''),
    10,
  );
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 300) return parsed;
  return DEFAULT_STORE_RETRY_AFTER_SECONDS;
}

function _openRedisBreaker(now, env) {
  _redisDeadUntil = now + (_retryAfterSeconds(env) * 1000);
}

function _breakerRetryAfterSeconds(now, env) {
  if (_redisDeadUntil > now) {
    return Math.max(1, Math.ceil((_redisDeadUntil - now) / 1000));
  }
  return _retryAfterSeconds(env);
}

function _storeUnavailableError(now = Date.now(), env = process.env) {
  const error = new Error(RATE_LIMIT_STORE_UNAVAILABLE);
  error.code = RATE_LIMIT_STORE_UNAVAILABLE;
  error.retryAfterSeconds = _breakerRetryAfterSeconds(now, env);
  return error;
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

function _activeMemoryLog(key, windowStart) {
  const current = FALLBACK_MEMORY.get(key) || [];
  if (!current.length || current[0] > windowStart) return current;
  let index = 0;
  while (index < current.length && current[index] <= windowStart) index += 1;
  const active = index === current.length ? [] : current.slice(index);
  FALLBACK_MEMORY.set(key, active);
  return active;
}

function _consumeMemoryMany(keys, limits, windowMs, now) {
  const windowStart = now - windowMs;
  const logs = keys.map((key) => _activeMemoryLog(key, windowStart));
  const blocked = logs.filter((log, index) => log.length >= limits[index]);
  if (blocked.length > 0) {
    const resetMs = Math.max(...blocked.map((log) => log[0] + windowMs));
    return {
      allowed: false,
      remaining: 0,
      resetAt: new Date(resetMs),
    };
  }

  let remaining = Infinity;
  let resetMs = 0;
  keys.forEach((key, index) => {
    const next = [...logs[index], now];
    FALLBACK_MEMORY.set(key, next);
    remaining = Math.min(remaining, limits[index] - next.length);
    resetMs = Math.max(resetMs, next[0] + windowMs);
  });
  return {
    allowed: true,
    remaining: Math.max(0, remaining),
    resetAt: new Date(resetMs || now + windowMs),
  };
}

function _maxFallbackKeys(env = process.env, opts = {}) {
  const raw = opts.maxFallbackKeys ?? env.RATE_LIMIT_MEMORY_MAX_KEYS;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return DEFAULT_FALLBACK_MAX_KEYS;
}

function _enforceFallbackMax(maxKeys) {
  while (FALLBACK_MEMORY.size > maxKeys) {
    const firstKey = FALLBACK_MEMORY.keys().next().value;
    if (firstKey === undefined) return;
    FALLBACK_MEMORY.delete(firstKey);
  }
}

function _validateConsumeKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('consume: key must be a non-empty string');
  }
  if (key.length > MAX_CONSUME_KEY_LENGTH) {
    throw new TypeError(`consume: key must be at most ${MAX_CONSUME_KEY_LENGTH} characters`);
  }
  if (/[\r\n\0]/.test(key)) {
    throw new TypeError('consume: key contains unsafe control characters');
  }
}

async function _consumeRedis(redis, key, limit, windowMs, now, commandTimeoutMs) {
  const windowStart = now - windowMs;
  // Unique member so concurrent calls don't collide on the same score.
  const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;
  const pipeline = redis.multi();
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zadd(key, now, member);
  pipeline.zcard(key);
  pipeline.pexpire(key, windowMs);
  const replies = await _withRedisTimeout(pipeline.exec(), commandTimeoutMs);
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
    await _withRedisTimeout(redis.zrem(key, member), commandTimeoutMs);
    // resetAt = oldest score + windowMs
    const oldest = await _withRedisTimeout(
      redis.zrange(key, 0, 0, 'WITHSCORES'),
      commandTimeoutMs,
    );
    const oldestScore = Array.isArray(oldest) && oldest.length >= 2
      ? Number(oldest[1])
      : now;
    const resetAt = new Date(oldestScore + windowMs);
    return { allowed: false, remaining: 0, resetAt };
  }
  return {
    allowed: true,
    remaining: Math.max(0, limit - card),
    resetAt: new Date(now + windowMs),
  };
}

const CONSUME_MANY_LUA = `
local now = tonumber(ARGV[1])
local window_start = tonumber(ARGV[2])
local window_ms = tonumber(ARGV[3])
local member = ARGV[4]
local denied = 0
local remaining = nil
local reset_at = 0

for index, key in ipairs(KEYS) do
  local limit = tonumber(ARGV[4 + index])
  redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)
  local count = redis.call('ZCARD', key)
  if count >= limit then
    denied = 1
  end
  if remaining == nil or (limit - count) < remaining then
    remaining = limit - count
  end
  local candidate = now + window_ms
  if count > 0 then
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    if oldest[2] then
      candidate = tonumber(oldest[2]) + window_ms
    end
  end
  if candidate > reset_at then
    reset_at = candidate
  end
end

if denied == 1 then
  return {0, 0, reset_at}
end

for _, key in ipairs(KEYS) do
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window_ms)
end

remaining = remaining - 1
if remaining < 0 then remaining = 0 end
return {1, remaining, reset_at}
`;

async function _consumeRedisMany(
  redis,
  keys,
  windowMs,
  now,
  commandTimeoutMs,
  limits,
) {
  const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;
  const reply = await _withRedisTimeout(
    redis.eval(
      CONSUME_MANY_LUA,
      keys.length,
      ...keys,
      now,
      now - windowMs,
      windowMs,
      member,
      ...limits,
    ),
    commandTimeoutMs,
  );
  if (!Array.isArray(reply) || reply.length < 3) {
    throw new Error('redis_atomic_consume_no_reply');
  }
  const allowed = Number(reply[0]) === 1;
  const remaining = Math.max(0, Number(reply[1]) || 0);
  const resetMs = Number(reply[2]);
  return {
    allowed,
    remaining,
    resetAt: new Date(Number.isFinite(resetMs) ? resetMs : now + windowMs),
  };
}

function _validateConsumeArgs(keys, limit, windowMs) {
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_ATOMIC_KEYS) {
    throw new TypeError(`consumeMany: keys must contain 1-${MAX_ATOMIC_KEYS} entries`);
  }
  for (const key of keys) _validateConsumeKey(key);
  if (new Set(keys).size !== keys.length) {
    throw new TypeError('consumeMany: keys must be unique');
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new TypeError('consumeMany: limit must be a positive number');
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError('consumeMany: windowMs must be a positive number');
  }
}

function _resolveConsumeManyLimits(keys, limit, configuredLimits) {
  if (configuredLimits === undefined) return keys.map(() => limit);
  if (!Array.isArray(configuredLimits) || configuredLimits.length !== keys.length) {
    throw new TypeError('consumeMany: opts.limits must match keys length');
  }
  return configuredLimits.map((entry) => {
    const parsed = Number(entry);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new TypeError('consumeMany: opts.limits entries must be positive numbers');
    }
    return parsed;
  });
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
  _validateConsumeKey(key);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new TypeError('consume: limit must be a positive number');
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError('consume: windowMs must be a positive number');
  }
  const env = opts.env || process.env;
  const now = typeof opts.now === 'function' ? opts.now() : Date.now();
  const maxFallbackKeys = _maxFallbackKeys(env, opts);
  const requireDistributed = opts.requireDistributed === true;
  const commandTimeoutMs = _resolveRedisCommandTimeoutMs(
    env,
    opts.commandTimeoutMs,
  );

  // Memory fallback explicitly forced or no Redis URL
  if (!shouldUseRedis(env)) {
    if (requireDistributed) throw _storeUnavailableError(now, env);
    const result = _consumeMemory(key, limit, windowMs, now);
    _enforceFallbackMax(maxFallbackKeys);
    return result;
  }
  if (now < _redisDeadUntil) {
    if (requireDistributed) throw _storeUnavailableError(now, env);
    const result = _consumeMemory(key, limit, windowMs, now);
    _enforceFallbackMax(maxFallbackKeys);
    return result;
  }
  const redis = opts.redis || createRedisClient(env.REDIS_URL, env);
  if (!redis) {
    _openRedisBreaker(now, env);
    if (requireDistributed) {
      _warn('redis client init failed', null, { fallback: false });
      throw _storeUnavailableError(now, env);
    }
    _warn('redis client init failed');
    const result = _consumeMemory(key, limit, windowMs, now);
    _enforceFallbackMax(maxFallbackKeys);
    return result;
  }
  try {
    return await _consumeRedis(
      redis,
      key,
      limit,
      windowMs,
      now,
      commandTimeoutMs,
    );
  } catch (err) {
    _openRedisBreaker(now, env);
    if (requireDistributed) {
      _warn('redis pipeline failed', null, { fallback: false });
      throw _storeUnavailableError(now, env);
    }
    _warn('redis pipeline failed', err);
    const result = _consumeMemory(key, limit, windowMs, now);
    _enforceFallbackMax(maxFallbackKeys);
    return result;
  }
}

/**
 * Atomically consume the same quota from multiple independent keys.
 * Billing uses this for user + IP enforcement so a denied dimension never
 * burns quota from another. Redis executes one Lua script; memory checks all
 * keys before appending to any of them.
 */
async function consumeMany(keys, limit, windowMs = 60_000, opts = {}) {
  _validateConsumeArgs(keys, limit, windowMs);
  const limits = _resolveConsumeManyLimits(keys, limit, opts.limits);
  const env = opts.env || process.env;
  const now = typeof opts.now === 'function' ? opts.now() : Date.now();
  const maxFallbackKeys = _maxFallbackKeys(env, opts);
  const requireDistributed = opts.requireDistributed === true;
  const commandTimeoutMs = _resolveRedisCommandTimeoutMs(
    env,
    opts.commandTimeoutMs,
  );

  if (!shouldUseRedis(env)) {
    if (requireDistributed) throw _storeUnavailableError(now, env);
    const result = _consumeMemoryMany(keys, limits, windowMs, now);
    _enforceFallbackMax(maxFallbackKeys);
    return result;
  }
  if (now < _redisDeadUntil) {
    if (requireDistributed) throw _storeUnavailableError(now, env);
    const result = _consumeMemoryMany(keys, limits, windowMs, now);
    _enforceFallbackMax(maxFallbackKeys);
    return result;
  }

  const redis = opts.redis || createRedisClient(env.REDIS_URL, env);
  if (!redis) {
    _openRedisBreaker(now, env);
    if (requireDistributed) {
      _warn('redis client init failed', null, { fallback: false });
      throw _storeUnavailableError(now, env);
    }
    _warn('redis client init failed');
    const result = _consumeMemoryMany(keys, limits, windowMs, now);
    _enforceFallbackMax(maxFallbackKeys);
    return result;
  }

  try {
    return await _consumeRedisMany(
      redis,
      keys,
      windowMs,
      now,
      commandTimeoutMs,
      limits,
    );
  } catch (error) {
    _openRedisBreaker(now, env);
    if (requireDistributed) {
      _warn('redis atomic consume failed', null, { fallback: false });
      throw _storeUnavailableError(now, env);
    }
    _warn('redis atomic consume failed', error);
    const result = _consumeMemoryMany(keys, limits, windowMs, now);
    _enforceFallbackMax(maxFallbackKeys);
    return result;
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

function _fallbackSize() {
  return FALLBACK_MEMORY.size;
}

module.exports = {
  createRateLimitStore,
  shouldUseRedis,
  consume,
  consumeMany,
  setLogger,
  _resetForTests,
  _fallbackSize,
  _validateConsumeKey,
  DEFAULT_FALLBACK_MAX_KEYS,
  MAX_CONSUME_KEY_LENGTH,
  MAX_ATOMIC_KEYS,
  RATE_LIMIT_STORE_UNAVAILABLE,
  DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
  _redisClientOptions,
  _resolveRedisCommandTimeoutMs,
  _withRedisTimeout,
};

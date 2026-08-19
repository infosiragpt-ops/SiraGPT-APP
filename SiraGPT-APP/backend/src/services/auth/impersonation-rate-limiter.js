'use strict';

const crypto = require('node:crypto');
const { isProductionLike } = require('../../utils/environment');
const {
  clusterSafePrefix,
  probeAuthSecurityRedis,
  resolveMaxMemoryRatio,
} = require('./auth-security-redis');

const IMPERSONATION_LIMITER_UNAVAILABLE = 'IMPERSONATION_LIMITER_UNAVAILABLE';
const IMPERSONATION_LIMITER_CAPACITY = 'IMPERSONATION_LIMITER_CAPACITY';

const DEFAULT_TARGET_LIMIT = 3;
const DEFAULT_ADMIN_LIMIT = 10;
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MEMORY_MAX_KEYS = 10_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 500;
const DEFAULT_COMMAND_TIMEOUT_MS = 500;
const DEFAULT_RETRY_AFTER_SECONDS = 5;
const DEFAULT_PREFIX = 'sira:impersonation:';

const LIMIT_LUA = [
  '-- impersonation-limit-v1',
  'local now = tonumber(ARGV[1])',
  'local window_start = tonumber(ARGV[2])',
  'local window_ms = tonumber(ARGV[3])',
  'local member = ARGV[4]',
  'local target_limit = tonumber(ARGV[5])',
  'local admin_limit = tonumber(ARGV[6])',
  "redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', window_start)",
  "redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', window_start)",
  "local target_count = redis.call('ZCARD', KEYS[1])",
  "local admin_count = redis.call('ZCARD', KEYS[2])",
  'local target_blocked = target_count >= target_limit',
  'local admin_blocked = admin_count >= admin_limit',
  'if target_blocked or admin_blocked then',
  '  local reset_at = 0',
  '  local dimension = 0',
  '  if target_blocked then',
  "    local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')",
  '    if oldest[2] then reset_at = tonumber(oldest[2]) + window_ms else reset_at = now + window_ms end',
  '    dimension = 1',
  '  end',
  '  if admin_blocked then',
  "    local oldest = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')",
  '    local admin_reset = now + window_ms',
  '    if oldest[2] then admin_reset = tonumber(oldest[2]) + window_ms end',
  '    if admin_reset > reset_at then reset_at = admin_reset end',
  '    if dimension == 1 then dimension = 3 else dimension = 2 end',
  '  end',
  '  return {0, 0, reset_at, dimension}',
  'end',
  "redis.call('ZADD', KEYS[1], now, member)",
  "redis.call('ZADD', KEYS[2], now, member)",
  "redis.call('PEXPIRE', KEYS[1], window_ms)",
  "redis.call('PEXPIRE', KEYS[2], window_ms)",
  'local remaining = math.min(target_limit - target_count - 1, admin_limit - admin_count - 1)',
  'return {1, remaining, now + window_ms, 0}',
].join('\n');

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function limiterError(code, { cause, retryAfterSeconds } = {}) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  if (retryAfterSeconds != null) error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(limiterError(IMPERSONATION_LIMITER_UNAVAILABLE)),
        timeoutMs,
      );
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function impersonationRedisOptions(env = process.env) {
  return {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    connectTimeout: clampInteger(
      env.IMPERSONATION_REDIS_CONNECT_TIMEOUT_MS,
      DEFAULT_CONNECT_TIMEOUT_MS,
      10,
      2_000,
    ),
    commandTimeout: clampInteger(
      env.IMPERSONATION_REDIS_COMMAND_TIMEOUT_MS,
      DEFAULT_COMMAND_TIMEOUT_MS,
      10,
      2_000,
    ),
  };
}

function defaultCreateRedis(env) {
  // eslint-disable-next-line global-require
  const IORedis = require('ioredis');
  const redis = new IORedis(env.REDIS_URL, impersonationRedisOptions(env));
  redis.on('error', () => {});
  return redis;
}

function requiredId(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 256 || /[\r\n\0]/.test(normalized)) {
    throw new TypeError('adminId and targetId must be non-empty bounded strings');
  }
  return normalized;
}

function digest(parts) {
  const hash = crypto.createHash('sha256').update('siragpt:impersonation-limit:v1');
  for (const part of parts) hash.update('\0').update(part);
  return hash.digest('hex');
}

function dimensionName(code) {
  if (Number(code) === 1) return 'target';
  if (Number(code) === 2) return 'admin';
  if (Number(code) === 3) return 'target_and_admin';
  return null;
}

function createMemoryBackend({
  clock,
  targetLimit,
  adminLimit,
  windowMs,
  maxKeys,
}) {
  const logs = new Map();

  function active(key, windowStart) {
    const current = logs.get(key) || [];
    const next = current.filter((timestamp) => timestamp > windowStart);
    if (next.length) logs.set(key, next);
    else logs.delete(key);
    return next;
  }

  function ensureCapacity(keys) {
    const additions = keys.filter((key) => !logs.has(key)).length;
    if (logs.size + additions > maxKeys) {
      throw limiterError(IMPERSONATION_LIMITER_CAPACITY);
    }
  }

  return {
    mode: 'memory',
    async consume(keys) {
      const now = clock();
      const windowStart = now - windowMs;
      const targetLog = active(keys[0], windowStart);
      const adminLog = active(keys[1], windowStart);
      const targetBlocked = targetLog.length >= targetLimit;
      const adminBlocked = adminLog.length >= adminLimit;

      if (targetBlocked || adminBlocked) {
        const resets = [];
        if (targetBlocked) resets.push(targetLog[0] + windowMs);
        if (adminBlocked) resets.push(adminLog[0] + windowMs);
        return {
          allowed: false,
          remaining: 0,
          resetAt: new Date(Math.max(...resets)),
          dimension: targetBlocked && adminBlocked
            ? 'target_and_admin'
            : (targetBlocked ? 'target' : 'admin'),
        };
      }

      ensureCapacity(keys);
      logs.set(keys[0], [...targetLog, now]);
      logs.set(keys[1], [...adminLog, now]);
      return {
        allowed: true,
        remaining: Math.max(
          0,
          Math.min(targetLimit - targetLog.length - 1, adminLimit - adminLog.length - 1),
        ),
        resetAt: new Date(now + windowMs),
        dimension: null,
      };
    },
    size() {
      const windowStart = clock() - windowMs;
      for (const key of [...logs.keys()]) active(key, windowStart);
      return logs.size;
    },
    clear() {
      logs.clear();
    },
  };
}

function createRedisBackend({
  redis,
  commandTimeoutMs,
  targetLimit,
  adminLimit,
  windowMs,
  clock,
}) {
  return {
    mode: 'redis',
    async consume(keys) {
      const now = clock();
      let reply;
      try {
        reply = await withTimeout(redis.eval(
          LIMIT_LUA,
          2,
          ...keys,
          String(now),
          String(now - windowMs),
          String(windowMs),
          `${now}-${crypto.randomBytes(12).toString('hex')}`,
          String(targetLimit),
          String(adminLimit),
        ), commandTimeoutMs);
      } catch (error) {
        throw limiterError(IMPERSONATION_LIMITER_UNAVAILABLE, { cause: error });
      }
      if (!Array.isArray(reply) || reply.length < 4) {
        throw limiterError(IMPERSONATION_LIMITER_UNAVAILABLE);
      }
      return {
        allowed: Number(reply[0]) === 1,
        remaining: Math.max(0, Number(reply[1]) || 0),
        resetAt: new Date(Number(reply[2]) || now + windowMs),
        dimension: dimensionName(reply[3]),
      };
    },
    size() {
      return 0;
    },
  };
}

function createImpersonationRateLimiter({
  env = process.env,
  redis: injectedRedis = null,
  createRedis = () => defaultCreateRedis(env),
  clock = Date.now,
} = {}) {
  const production = isProductionLike(env);
  const targetLimit = clampInteger(
    env.IMPERSONATION_TARGET_LIMIT,
    DEFAULT_TARGET_LIMIT,
    1,
    100,
  );
  const adminLimit = clampInteger(
    env.IMPERSONATION_ADMIN_LIMIT,
    DEFAULT_ADMIN_LIMIT,
    1,
    1_000,
  );
  const windowMs = clampInteger(
    env.IMPERSONATION_WINDOW_MS,
    DEFAULT_WINDOW_MS,
    1_000,
    24 * 60 * 60 * 1000,
  );
  const maxKeys = clampInteger(
    env.IMPERSONATION_MEMORY_MAX_KEYS,
    DEFAULT_MEMORY_MAX_KEYS,
    2,
    100_000,
  );
  const retryAfterSeconds = clampInteger(
    env.IMPERSONATION_STORE_RETRY_AFTER_SECONDS,
    DEFAULT_RETRY_AFTER_SECONDS,
    1,
    300,
  );
  const prefix = String(env.IMPERSONATION_REDIS_PREFIX || DEFAULT_PREFIX);
  const redisOptions = impersonationRedisOptions(env);
  const memory = createMemoryBackend({
    clock,
    targetLimit,
    adminLimit,
    windowMs,
    maxKeys,
  });

  let redis = injectedRedis;
  let ownsRedis = false;
  let backend = null;
  let mode = 'pending';
  let initPromise = null;
  let lastErrorAt = null;
  let lastErrorCode = null;
  let redisHealth = {
    luaSupported: null,
    redisPolicy: null,
    capacityOk: null,
    memoryUtilization: null,
    usedMemoryBytes: null,
    maxMemoryBytes: null,
    maxMemoryRatio: resolveMaxMemoryRatio(env),
  };

  function unavailable(cause) {
    backend = null;
    mode = 'unavailable';
    lastErrorAt = clock();
    lastErrorCode = cause?.code || IMPERSONATION_LIMITER_UNAVAILABLE;
    if (cause?.redisHealth) redisHealth = { ...redisHealth, ...cause.redisHealth };
    throw limiterError(IMPERSONATION_LIMITER_UNAVAILABLE, {
      cause,
      retryAfterSeconds,
    });
  }

  async function closeOwnedRedis() {
    if (!redis || !ownsRedis) return;
    try {
      if (typeof redis.quit === 'function') {
        await withTimeout(redis.quit(), redisOptions.commandTimeout);
      } else {
        redis.disconnect?.();
      }
    } catch (error) {
      try { redis.disconnect?.(); } catch (_disconnectError) { /* best effort */ }
      throw limiterError('IMPERSONATION_LIMITER_CLOSE_FAILED', { cause: error });
    }
  }

  async function discardOwnedRedis() {
    if (!redis || !ownsRedis) return null;
    let closeError = null;
    try {
      await closeOwnedRedis();
    } catch (error) {
      closeError = error;
    } finally {
      redis = null;
      ownsRedis = false;
      backend = null;
      initPromise = null;
      mode = 'pending';
    }
    return closeError;
  }

  async function ready() {
    if (backend) return health();
    if (mode === 'closed') return unavailable();
    if (initPromise) return initPromise;
    initPromise = (async () => {
      if (!redis && !env.REDIS_URL) {
        if (production) return unavailable();
        backend = memory;
        mode = 'memory';
        return health();
      }
      try {
        if (!redis) {
          redis = createRedis();
          ownsRedis = true;
        }
        if (!redis || typeof redis.ping !== 'function' || typeof redis.eval !== 'function') {
          throw limiterError(IMPERSONATION_LIMITER_UNAVAILABLE);
        }
        if (redis.status === 'wait' && typeof redis.connect === 'function') {
          await withTimeout(redis.connect(), redisOptions.connectTimeout);
        }
        await withTimeout(redis.ping(), redisOptions.commandTimeout);
        redisHealth = await probeAuthSecurityRedis({
          redis,
          run: (command) => withTimeout(
            Promise.resolve().then(command),
            redisOptions.commandTimeout,
          ),
          env,
          production,
          probeKey: `${clusterSafePrefix(prefix, 'impersonation-readiness')}probe`,
        });
        backend = createRedisBackend({
          redis,
          commandTimeoutMs: redisOptions.commandTimeout,
          targetLimit,
          adminLimit,
          windowMs,
          clock,
        });
        mode = 'redis';
        lastErrorAt = null;
        lastErrorCode = null;
        return health();
      } catch (error) {
        if (ownsRedis) {
          await discardOwnedRedis();
        }
        if (production) return unavailable(error);
        backend = memory;
        mode = 'memory';
        lastErrorAt = clock();
        return health();
      }
    })();
    try {
      return await initPromise;
    } finally {
      initPromise = null;
    }
  }

  function keysFor(adminId, targetId) {
    const admin = requiredId(adminId);
    const target = requiredId(targetId);
    const adminDigest = digest([admin]);
    const keyPrefix = clusterSafePrefix(prefix, `impersonation:${adminDigest}`);
    return [
      `${keyPrefix}target:${digest([admin, target])}`,
      `${keyPrefix}admin`,
    ];
  }

  async function consume({ adminId, targetId }) {
    const keys = keysFor(adminId, targetId);
    await ready();
    let result;
    try {
      result = await backend.consume(keys);
    } catch (error) {
      lastErrorAt = clock();
      if (error?.code === IMPERSONATION_LIMITER_CAPACITY) throw error;
      if (ownsRedis) await discardOwnedRedis();
      if (production) return unavailable(error);
      backend = memory;
      mode = 'memory';
      result = await backend.consume(keys);
    }
    const rawRetryMs = result.resetAt.getTime() - clock();
    return {
      ...result,
      retryAfterMs: result.allowed
        ? 0
        : Math.max(1, Math.min(windowMs, Math.ceil(rawRetryMs))),
    };
  }

  function health() {
    return Object.freeze({
      ok: mode === 'redis' || (!production && mode === 'memory'),
      mode,
      distributed: mode === 'redis',
      failClosed: production,
      redisConfigured: Boolean(env.REDIS_URL || injectedRedis),
      localKeys: memory.size(),
      lastErrorAt,
      lastErrorCode,
      ...redisHealth,
    });
  }

  function config() {
    return Object.freeze({
      failClosed: production,
      redisConfigured: Boolean(env.REDIS_URL || injectedRedis),
      redisPrefix: prefix,
      targetLimit,
      adminLimit,
      windowMs,
      maxMemoryKeys: maxKeys,
      connectTimeoutMs: redisOptions.connectTimeout,
      commandTimeoutMs: redisOptions.commandTimeout,
      storeRetryAfterSeconds: retryAfterSeconds,
      offlineQueue: false,
      clusterHashTag: 'admin-scoped',
      maxMemoryRatio: redisHealth.maxMemoryRatio,
    });
  }

  return {
    consume,
    ready,
    health,
    config,
    async close() {
      if (mode === 'closed') return;
      backend = null;
      memory.clear();
      let closeError = null;
      try {
        await closeOwnedRedis();
      } catch (error) {
        closeError = error;
        lastErrorAt = clock();
        lastErrorCode = error?.code || 'IMPERSONATION_LIMITER_CLOSE_FAILED';
      } finally {
        redis = null;
        ownsRedis = false;
        initPromise = null;
        mode = 'closed';
      }
      if (closeError) throw closeError;
    },
  };
}

module.exports = {
  IMPERSONATION_LIMITER_CAPACITY,
  IMPERSONATION_LIMITER_UNAVAILABLE,
  createImpersonationRateLimiter,
  impersonationRedisOptions,
};

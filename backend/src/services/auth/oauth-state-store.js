'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { isProductionLike } = require('../../utils/environment');
const {
  clusterSafePrefix,
  probeAuthSecurityRedis,
  resolveMaxMemoryRatio,
} = require('./auth-security-redis');

const OAUTH_STATE_STORE_UNAVAILABLE = 'OAUTH_STATE_STORE_UNAVAILABLE';
const OAUTH_STATE_STORE_CAPACITY = 'OAUTH_STATE_STORE_CAPACITY';
const OAUTH_STATE_REPLAYED_OR_EXPIRED = 'OAUTH_STATE_REPLAYED_OR_EXPIRED';
const OAUTH_STATE_BINDING_INVALID = 'OAUTH_STATE_BINDING_INVALID';
const OAUTH_STATE_TYPE = 'oauth_state';

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 500;
const DEFAULT_COMMAND_TIMEOUT_MS = 500;
const DEFAULT_REDIS_PREFIX = 'sira:oauth-state:';
const DEFAULT_TTL = '10m';
const DEFAULT_TTL_SECONDS = 10 * 60;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 15 * 60;

const ISSUE_LUA = [
  '-- oauth-state-issue-v1',
  "redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', tonumber(ARGV[1]))",
  "if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end",
  "if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[3]) then return -1 end",
  "redis.call('PSETEX', KEYS[1], tonumber(ARGV[2]), ARGV[4])",
  "redis.call('ZADD', KEYS[2], tonumber(ARGV[1]) + tonumber(ARGV[2]), KEYS[1])",
  "local indexTtl = redis.call('PTTL', KEYS[2])",
  "if indexTtl < tonumber(ARGV[2]) then redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[2])) end",
  'return 1',
].join('\n');

const CONSUME_LUA = [
  '-- oauth-state-consume-v1',
  "redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', tonumber(ARGV[1]))",
  "local value = redis.call('GET', KEYS[1])",
  'if not value then return nil end',
  "redis.call('DEL', KEYS[1])",
  "redis.call('ZREM', KEYS[2], KEYS[1])",
  'return value',
].join('\n');

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function resolveOAuthStateTtlSeconds(env = process.env) {
  const raw = String(env.OAUTH_STATE_TTL || DEFAULT_TTL).trim().toLowerCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
  if (!match) return DEFAULT_TTL_SECONDS;
  const value = Number(match[1]);
  const multiplier = {
    ms: 1 / 1000,
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
  }[match[2] || 's'];
  if (!Number.isFinite(value) || !multiplier) return DEFAULT_TTL_SECONDS;
  return Math.max(
    MIN_TTL_SECONDS,
    Math.min(MAX_TTL_SECONDS, Math.floor(value * multiplier)),
  );
}

function stateError(code, cause) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(stateError(OAUTH_STATE_STORE_UNAVAILABLE)),
        timeoutMs,
      );
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function oauthStateRedisOptions(env = process.env) {
  return {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    connectTimeout: clampInteger(
      env.OAUTH_STATE_REDIS_CONNECT_TIMEOUT_MS,
      DEFAULT_CONNECT_TIMEOUT_MS,
      10,
      2_000,
    ),
    commandTimeout: clampInteger(
      env.OAUTH_STATE_REDIS_COMMAND_TIMEOUT_MS,
      DEFAULT_COMMAND_TIMEOUT_MS,
      10,
      2_000,
    ),
  };
}

function defaultCreateRedis(env) {
  // Lazy import and lazy connection keep route imports side-effect free.
  // eslint-disable-next-line global-require
  const IORedis = require('ioredis');
  const redis = new IORedis(env.REDIS_URL, oauthStateRedisOptions(env));
  redis.on('error', () => {});
  return redis;
}

function digestStateKey(jti) {
  return crypto
    .createHash('sha256')
    .update('siragpt:oauth-state-jti:v1')
    .update('\0')
    .update(String(jti))
    .digest('hex');
}

function createMemoryBackend({ clock, maxEntries }) {
  const entries = new Map();

  function prune() {
    const now = clock();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
  }

  return {
    mode: 'memory',
    async issue(key, value, ttlMs) {
      prune();
      if (entries.has(key)) return false;
      if (entries.size >= maxEntries) {
        throw stateError(OAUTH_STATE_STORE_CAPACITY);
      }
      entries.set(key, { value, expiresAt: clock() + ttlMs });
      return true;
    },
    async consume(key) {
      prune();
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      return entry.value;
    },
    size() {
      prune();
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}

function createRedisBackend({
  redis,
  prefix,
  commandTimeoutMs,
  maxEntries,
  clock,
}) {
  const keyPrefix = clusterSafePrefix(prefix, 'oauth-state');
  const indexKey = `${keyPrefix}bounded:index`;
  const fullKey = (jti) => `${keyPrefix}${digestStateKey(jti)}`;

  async function run(command) {
    try {
      return await withTimeout(command(), commandTimeoutMs);
    } catch (error) {
      if (error?.code === OAUTH_STATE_STORE_CAPACITY) throw error;
      throw stateError(OAUTH_STATE_STORE_UNAVAILABLE, error);
    }
  }

  return {
    mode: 'redis',
    async issue(jti, value, ttlMs) {
      const result = await run(() => redis.eval(
        ISSUE_LUA,
        2,
        fullKey(jti),
        indexKey,
        String(clock()),
        String(ttlMs),
        String(maxEntries),
        value,
      ));
      if (Number(result) === -1) throw stateError(OAUTH_STATE_STORE_CAPACITY);
      return Number(result) === 1;
    },
    async consume(jti) {
      return run(() => redis.eval(
        CONSUME_LUA,
        2,
        fullKey(jti),
        indexKey,
        String(clock()),
      ));
    },
    size() {
      return 0;
    },
  };
}

function createOAuthStateStore({
  env = process.env,
  redis: injectedRedis = null,
  createRedis = () => defaultCreateRedis(env),
  clock = Date.now,
} = {}) {
  const production = isProductionLike(env);
  const maxEntries = clampInteger(
    env.OAUTH_STATE_CACHE_MAX_ENTRIES,
    DEFAULT_MAX_ENTRIES,
    1,
    100_000,
  );
  const redisPrefix = String(env.OAUTH_STATE_REDIS_PREFIX || DEFAULT_REDIS_PREFIX);
  const redisOptions = oauthStateRedisOptions(env);
  const commandTimeoutMs = redisOptions.commandTimeout;
  const memory = createMemoryBackend({ clock, maxEntries });

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

  async function closeOwnedRedis() {
    if (!redis || !ownsRedis) return;
    try {
      if (typeof redis.quit === 'function') {
        await withTimeout(redis.quit(), commandTimeoutMs);
      } else {
        redis.disconnect?.();
      }
    } catch (error) {
      try { redis.disconnect?.(); } catch (_disconnectError) { /* best effort */ }
      throw stateError('OAUTH_STATE_STORE_CLOSE_FAILED', error);
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

  function unavailable(error) {
    mode = 'unavailable';
    backend = null;
    lastErrorAt = clock();
    lastErrorCode = error?.code || OAUTH_STATE_STORE_UNAVAILABLE;
    if (error?.redisHealth) redisHealth = { ...redisHealth, ...error.redisHealth };
    throw stateError(OAUTH_STATE_STORE_UNAVAILABLE, error);
  }

  async function ready() {
    if (backend) return health();
    if (mode === 'closed') throw stateError(OAUTH_STATE_STORE_UNAVAILABLE);
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
          throw stateError(OAUTH_STATE_STORE_UNAVAILABLE);
        }
        if (redis.status === 'wait' && typeof redis.connect === 'function') {
          await withTimeout(redis.connect(), redisOptions.connectTimeout);
        }
        await withTimeout(redis.ping(), commandTimeoutMs);
        redisHealth = await probeAuthSecurityRedis({
          redis,
          run: (command) => withTimeout(Promise.resolve().then(command), commandTimeoutMs),
          env,
          production,
          probeKey: `${clusterSafePrefix(redisPrefix, 'oauth-state')}readiness`,
        });
        backend = createRedisBackend({
          redis,
          prefix: redisPrefix,
          commandTimeoutMs,
          maxEntries,
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

  async function run(method, ...args) {
    await ready();
    try {
      return await backend[method](...args);
    } catch (error) {
      if (error?.code === OAUTH_STATE_STORE_CAPACITY) throw error;
      lastErrorAt = clock();
      if (ownsRedis) await discardOwnedRedis();
      if (production) return unavailable(error);
      backend = memory;
      mode = 'memory';
      return backend[method](...args);
    }
  }

  function health() {
    return Object.freeze({
      ok: mode === 'redis' || (!production && mode === 'memory'),
      mode,
      distributed: mode === 'redis',
      failClosed: production,
      redisConfigured: Boolean(env.REDIS_URL || injectedRedis),
      maxEntries,
      localEntries: memory.size(),
      lastErrorAt,
      lastErrorCode,
      ...redisHealth,
    });
  }

  function config() {
    return Object.freeze({
      failClosed: production,
      redisConfigured: Boolean(env.REDIS_URL || injectedRedis),
      redisPrefix,
      maxEntries,
      ttl: `${resolveOAuthStateTtlSeconds(env)}s`,
      ttlSeconds: resolveOAuthStateTtlSeconds(env),
      connectTimeoutMs: redisOptions.connectTimeout,
      commandTimeoutMs,
      offlineQueue: false,
      clusterHashTag: 'oauth-state',
      maxMemoryRatio: redisHealth.maxMemoryRatio,
    });
  }

  return {
    ready,
    issue(jti, value, ttlMs) {
      return run('issue', jti, value, ttlMs);
    },
    consume(jti) {
      return run('consume', jti);
    },
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
        lastErrorCode = error?.code || 'OAUTH_STATE_STORE_CLOSE_FAILED';
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

function requiredText(value, field) {
  const normalized = String(value || '').trim();
  if (!normalized) throw stateError('OAUTH_STATE_INPUT_INVALID');
  if (normalized.length > 2_048) throw stateError('OAUTH_STATE_INPUT_INVALID');
  if (field === 'service' && !/^[a-z][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw stateError('OAUTH_STATE_INPUT_INVALID');
  }
  return normalized;
}

function normalizeRedirectUri(value, { production = false } = {}) {
  const raw = requiredText(value, 'redirectUri');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_error) {
    throw stateError('OAUTH_STATE_INPUT_INVALID');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw stateError('OAUTH_STATE_INPUT_INVALID');
  }
  const localHostname = (
    parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '::1'
  );
  if (production && (parsed.protocol !== 'https:' || localHostname)) {
    throw stateError('OAUTH_STATE_INPUT_INVALID');
  }
  parsed.hash = '';
  return parsed.toString();
}

function timingSafeTextEqual(left, right) {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createOAuthStateCodec({
  env = process.env,
  store = createOAuthStateStore({ env }),
  clock = Date.now,
  randomUUID = crypto.randomUUID,
} = {}) {
  const production = isProductionLike(env);
  const ttlSeconds = resolveOAuthStateTtlSeconds(env);

  function secret() {
    const value = String(env.JWT_SECRET || '');
    if (!value) throw new Error('JWT_SECRET is required for OAuth state');
    return value;
  }

  async function issue({ userId, service, redirectUri }) {
    const signingSecret = secret();
    const binding = {
      userId: requiredText(userId, 'userId'),
      service: requiredText(service, 'service'),
      redirectUri: normalizeRedirectUri(redirectUri, { production }),
    };
    await store.ready();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const jti = randomUUID();
      const token = jwt.sign(
        {
          typ: OAUTH_STATE_TYPE,
          ...binding,
          jti,
        },
        signingSecret,
        { expiresIn: ttlSeconds },
      );
      const decoded = jwt.decode(token);
      const ttlMs = Math.max(1, Number(decoded.exp) * 1_000 - clock());
      const stored = await store.issue(jti, JSON.stringify(binding), ttlMs);
      if (stored) return token;
    }
    throw stateError('OAUTH_STATE_JTI_COLLISION');
  }

  async function consume(rawState, expected = {}) {
    if (!rawState) throw stateError('OAUTH_STATE_REQUIRED');
    const expectedService = requiredText(expected.service, 'service');
    const expectedRedirect = normalizeRedirectUri(expected.redirectUri, { production });
    const expectedUser = expected.userId == null
      ? null
      : requiredText(expected.userId, 'userId');

    const decoded = jwt.verify(String(rawState), secret());
    if (
      !decoded
      || decoded.typ !== OAUTH_STATE_TYPE
      || !decoded.jti
      || !decoded.userId
      || !decoded.service
      || !decoded.redirectUri
    ) {
      throw stateError('OAUTH_STATE_INVALID');
    }

    const storedRaw = await store.consume(decoded.jti);
    if (!storedRaw) throw stateError(OAUTH_STATE_REPLAYED_OR_EXPIRED);

    let stored;
    try {
      stored = JSON.parse(storedRaw);
    } catch (_error) {
      throw stateError(OAUTH_STATE_BINDING_INVALID);
    }

    const claimRedirect = normalizeRedirectUri(decoded.redirectUri, { production });
    const valid = (
      timingSafeTextEqual(decoded.userId, stored.userId)
      && timingSafeTextEqual(decoded.service, stored.service)
      && timingSafeTextEqual(claimRedirect, stored.redirectUri)
      && timingSafeTextEqual(decoded.service, expectedService)
      && timingSafeTextEqual(claimRedirect, expectedRedirect)
      && (!expectedUser || timingSafeTextEqual(decoded.userId, expectedUser))
    );
    if (!valid) throw stateError(OAUTH_STATE_BINDING_INVALID);

    return {
      userId: String(decoded.userId),
      service: String(decoded.service),
      redirectUri: claimRedirect,
    };
  }

  return {
    issue,
    consume,
    ready: store.ready,
    health: store.health,
    config: store.config,
    close: store.close,
  };
}

module.exports = {
  OAUTH_STATE_BINDING_INVALID,
  OAUTH_STATE_REPLAYED_OR_EXPIRED,
  OAUTH_STATE_STORE_CAPACITY,
  OAUTH_STATE_STORE_UNAVAILABLE,
  createOAuthStateCodec,
  createOAuthStateStore,
  oauthStateRedisOptions,
  resolveOAuthStateTtlSeconds,
};

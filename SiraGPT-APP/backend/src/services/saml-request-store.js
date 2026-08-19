'use strict';

const crypto = require('node:crypto');
const { isProductionLike } = require('../utils/environment');

const SAML_REQUEST_STORE_UNAVAILABLE = 'SAML_REQUEST_STORE_UNAVAILABLE';
const DEFAULT_SAML_REQUEST_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SAML_REQUEST_CACHE_MAX_ENTRIES = 5_000;
const DEFAULT_SAML_REDIS_CONNECT_TIMEOUT_MS = 500;
const DEFAULT_SAML_REDIS_COMMAND_TIMEOUT_MS = 500;
const DEFAULT_SAML_REDIS_RETRY_BASE_MS = 100;
const DEFAULT_SAML_REDIS_RETRY_MAX_MS = 5_000;
const DEFAULT_SAML_REDIS_PREFIX = 'sira:saml:';

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function unavailableError(retryAfterMs) {
  const error = new Error(SAML_REQUEST_STORE_UNAVAILABLE);
  error.code = SAML_REQUEST_STORE_UNAVAILABLE;
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    error.retryAfterMs = Math.floor(retryAfterMs);
  }
  return error;
}

function relayStateError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(unavailableError()), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function redisClientOptions(env = process.env) {
  return {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    connectTimeout: clampInteger(
      env.SAML_REDIS_CONNECT_TIMEOUT_MS,
      DEFAULT_SAML_REDIS_CONNECT_TIMEOUT_MS,
      10,
      2_000,
    ),
    commandTimeout: clampInteger(
      env.SAML_REDIS_COMMAND_TIMEOUT_MS,
      DEFAULT_SAML_REDIS_COMMAND_TIMEOUT_MS,
      10,
      2_000,
    ),
  };
}

function defaultCreateRedis(env) {
  // Loaded lazily so importing auth routes never creates a Redis socket.
  // eslint-disable-next-line global-require
  const IORedis = require('ioredis');
  const redis = new IORedis(env.REDIS_URL, redisClientOptions(env));
  redis.on('error', () => {});
  return redis;
}

function normalizeOrgSlug(orgSlug) {
  const normalized = String(orgSlug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(normalized)) {
    throw relayStateError('SAML_RELAY_STATE_INVALID');
  }
  return normalized;
}

function normalizeRequestId(requestId) {
  const normalized = String(requestId || '').trim();
  if (!/^_[A-Za-z0-9._-]{1,255}$/.test(normalized)) {
    throw relayStateError('SAML_RELAY_STATE_INVALID');
  }
  return normalized;
}

function normalizePreAuthNonceHash(value) {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(normalized)) {
    throw relayStateError('SAML_BROWSER_BINDING_INVALID');
  }
  return normalized;
}

function createMemoryBackend({ clock, maxEntries }) {
  const entries = new Map();

  function prune() {
    const timestamp = clock();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= timestamp) entries.delete(key);
    }
  }

  function makeRoom() {
    prune();
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  return {
    mode: 'memory',
    async put(key, value, ttlMs) {
      prune();
      if (entries.has(key)) return null;
      makeRoom();
      const entry = {
        value,
        createdAt: clock(),
        expiresAt: clock() + ttlMs,
      };
      entries.set(key, entry);
      return { value: entry.value, createdAt: entry.createdAt };
    },
    async claim(key) {
      prune();
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      return entry.value;
    },
    async claimMatching(key, expectedHash) {
      prune();
      const entry = entries.get(key);
      if (!entry) return { status: 'missing', value: null };
      let parsed;
      try {
        parsed = JSON.parse(entry.value);
      } catch (_error) {
        return { status: 'mismatch', value: null };
      }
      if (!timingSafeTextEqual(parsed.preAuthNonceHash, expectedHash)) {
        return { status: 'mismatch', value: null };
      }
      entries.delete(key);
      return { status: 'claimed', value: entry.value };
    },
    async delete(key) {
      return entries.delete(key);
    },
    size() {
      prune();
      return entries.size;
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
  const fullKey = (key) => `${prefix}${key}`;
  const indexKey = `${prefix}bounded:index`;
  const saveLua = [
    "redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))",
    "if redis.call('EXISTS', KEYS[1]) == 1 then",
    '  return 0',
    'end',
    "redis.call('PSETEX', KEYS[1], tonumber(ARGV[2]), ARGV[4])",
    "redis.call('ZADD', KEYS[2], tonumber(ARGV[1]), KEYS[1])",
    "local overflow = redis.call('ZCARD', KEYS[2]) - tonumber(ARGV[3])",
    'if overflow > 0 then',
    "  local evicted = redis.call('ZRANGE', KEYS[2], 0, overflow - 1)",
    '  for _, evictedKey in ipairs(evicted) do',
    "    redis.call('DEL', evictedKey)",
    '  end',
    "  redis.call('ZREMRANGEBYRANK', KEYS[2], 0, overflow - 1)",
    'end',
    "redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[2]))",
    'return 1',
  ].join('\n');
  const claimLua = [
    "local value = redis.call('GET', KEYS[1])",
    'if value then',
    "  redis.call('DEL', KEYS[1])",
    "  redis.call('ZREM', KEYS[2], KEYS[1])",
    'end',
    'return value',
  ].join('\n');
  const claimMatchingLua = [
    "local value = redis.call('GET', KEYS[1])",
    'if not value then',
    "  return {0, ''}",
    'end',
    'local ok, decoded = pcall(cjson.decode, value)',
    "if not ok or decoded['preAuthNonceHash'] ~= ARGV[1] then",
    "  return {-1, ''}",
    'end',
    "redis.call('DEL', KEYS[1])",
    "redis.call('ZREM', KEYS[2], KEYS[1])",
    'return {1, value}',
  ].join('\n');
  const deleteLua = [
    "local deleted = redis.call('DEL', KEYS[1])",
    "redis.call('ZREM', KEYS[2], KEYS[1])",
    'return deleted',
  ].join('\n');

  async function run(command) {
    try {
      return await withTimeout(command(), commandTimeoutMs);
    } catch (_error) {
      throw unavailableError();
    }
  }

  return {
    mode: 'redis',
    async put(key, value, ttlMs) {
      const timestamp = clock();
      const result = await run(() => redis.eval(
        saveLua,
        2,
        fullKey(key),
        indexKey,
        String(timestamp),
        String(ttlMs),
        String(maxEntries),
        value,
      ));
      if (Number(result) !== 1) return null;
      return { value, createdAt: timestamp };
    },
    async claim(key) {
      return run(() => redis.eval(claimLua, 2, fullKey(key), indexKey));
    },
    async claimMatching(key, expectedHash) {
      const result = await run(() => redis.eval(
        claimMatchingLua,
        2,
        fullKey(key),
        indexKey,
        expectedHash,
      ));
      if (!Array.isArray(result)) return { status: 'missing', value: null };
      if (Number(result[0]) === -1) return { status: 'mismatch', value: null };
      if (Number(result[0]) !== 1) return { status: 'missing', value: null };
      return { status: 'claimed', value: result[1] };
    },
    async delete(key) {
      const deleted = await run(() => redis.eval(deleteLua, 2, fullKey(key), indexKey));
      return Number(deleted) > 0;
    },
    size() {
      return 0;
    },
  };
}

function timingSafeTextEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createSamlRequestStore({
  env = process.env,
  redis: injectedRedis = null,
  createRedis = () => defaultCreateRedis(env),
  clock = Date.now,
  randomBytes = crypto.randomBytes,
} = {}) {
  const production = isProductionLike(env);
  const ttlMs = clampInteger(
    env.SAML_REQUEST_TTL_MS,
    DEFAULT_SAML_REQUEST_TTL_MS,
    60_000,
    15 * 60_000,
  );
  const maxEntries = clampInteger(
    env.SAML_REQUEST_CACHE_MAX_ENTRIES,
    DEFAULT_SAML_REQUEST_CACHE_MAX_ENTRIES,
    1,
    50_000,
  );
  const commandTimeoutMs = clampInteger(
    env.SAML_REDIS_COMMAND_TIMEOUT_MS,
    DEFAULT_SAML_REDIS_COMMAND_TIMEOUT_MS,
    10,
    2_000,
  );
  const retryBaseMs = clampInteger(
    env.SAML_REDIS_RETRY_BASE_MS,
    DEFAULT_SAML_REDIS_RETRY_BASE_MS,
    10,
    5_000,
  );
  const retryMaxMs = Math.max(
    retryBaseMs,
    clampInteger(
      env.SAML_REDIS_RETRY_MAX_MS,
      DEFAULT_SAML_REDIS_RETRY_MAX_MS,
      10,
      60_000,
    ),
  );
  const prefix = String(env.SAML_REDIS_PREFIX || DEFAULT_SAML_REDIS_PREFIX);
  const memoryBackend = createMemoryBackend({ clock, maxEntries });
  let redis = injectedRedis;
  let ownsRedis = false;
  let backend = null;
  let mode = 'pending';
  let initPromise = null;
  let circuitState = 'closed';
  let consecutiveFailures = 0;
  let retryAt = 0;

  function secret() {
    const value = String(env.SAML_RELAY_STATE_SECRET || env.JWT_SECRET || '');
    if (Buffer.byteLength(value, 'utf8') < 32) {
      throw relayStateError('SAML_RELAY_STATE_SECRET_UNAVAILABLE');
    }
    return value;
  }

  async function closeRedis() {
    if (!redis || !ownsRedis) return;
    try {
      if (typeof redis.quit === 'function') {
        await withTimeout(redis.quit(), commandTimeoutMs);
      } else {
        redis.disconnect?.();
      }
    } catch (_error) {
      redis.disconnect?.();
    }
  }

  function failDistributed() {
    consecutiveFailures += 1;
    const exponent = Math.min(20, consecutiveFailures - 1);
    const delayMs = Math.min(retryMaxMs, retryBaseMs * (2 ** exponent));
    retryAt = clock() + delayMs;
    circuitState = 'open';
    mode = 'unavailable';
    backend = null;
    throw unavailableError(delayMs);
  }

  async function ensureAvailable() {
    if (backend) return status();
    if (mode === 'closed') throw unavailableError();
    if (production && circuitState === 'open' && clock() < retryAt) {
      throw unavailableError(retryAt - clock());
    }
    if (initPromise) return initPromise;

    initPromise = (async () => {
      if (production) circuitState = 'half_open';
      if (!redis && !env.REDIS_URL) {
        if (production) return failDistributed();
        backend = memoryBackend;
        mode = 'memory';
        return status();
      }

      try {
        if (!redis) {
          redis = createRedis();
          ownsRedis = true;
        }
        if (!redis || typeof redis.ping !== 'function') throw unavailableError();
        if (redis.status === 'wait' && typeof redis.connect === 'function') {
          await withTimeout(redis.connect(), redisClientOptions(env).connectTimeout);
        }
        await withTimeout(redis.ping(), commandTimeoutMs);
        backend = createRedisBackend({
          redis,
          prefix,
          commandTimeoutMs,
          maxEntries,
          clock,
        });
        mode = 'redis';
        circuitState = 'closed';
        consecutiveFailures = 0;
        retryAt = 0;
        return status();
      } catch (_error) {
        if (ownsRedis) {
          await closeRedis();
          redis = null;
          ownsRedis = false;
        }
        if (production) return failDistributed();
        backend = memoryBackend;
        mode = 'memory';
        return status();
      }
    })();

    try {
      return await initPromise;
    } finally {
      initPromise = null;
    }
  }

  function status() {
    return Object.freeze({
      mode,
      distributed: mode === 'redis',
      circuitState,
      consecutiveFailures,
      retryAt,
      ttlMs,
      maxEntries,
      localEntries: memoryBackend.size(),
    });
  }

  function requestKey(orgSlug, requestId) {
    return `request:${normalizeOrgSlug(orgSlug)}:${normalizeRequestId(requestId)}`;
  }

  function relayKey(orgSlug, nonce) {
    return `relay:${normalizeOrgSlug(orgSlug)}:${nonce}`;
  }

  function createCacheProvider(orgSlug) {
    const normalizedOrg = normalizeOrgSlug(orgSlug);
    const claimed = new Map();

    return {
      async saveAsync(key, value) {
        await ensureAvailable();
        const normalizedId = normalizeRequestId(key);
        return backend.put(requestKey(normalizedOrg, normalizedId), String(value), ttlMs);
      },
      async getAsync(key) {
        await ensureAvailable();
        const normalizedId = normalizeRequestId(key);
        if (claimed.has(normalizedId)) return claimed.get(normalizedId);
        const value = await backend.claim(requestKey(normalizedOrg, normalizedId));
        if (value != null) claimed.set(normalizedId, value);
        return value;
      },
      async removeAsync(key) {
        if (key == null) return null;
        await ensureAvailable();
        const normalizedId = normalizeRequestId(key);
        const hadClaim = claimed.delete(normalizedId);
        const deleted = await backend.delete(requestKey(normalizedOrg, normalizedId));
        return hadClaim || deleted ? normalizedId : null;
      },
    };
  }

  function sign(value) {
    return crypto.createHmac('sha256', secret())
      .update(value)
      .digest('base64url');
  }

  async function issueRelayState({ orgSlug, requestId, preAuthNonceHash }) {
    await ensureAvailable();
    const org = normalizeOrgSlug(orgSlug);
    const rid = normalizeRequestId(requestId);
    const browserHash = normalizePreAuthNonceHash(preAuthNonceHash);
    const expiresAt = clock() + ttlMs;
    const expires = expiresAt.toString(36);
    const nonce = Buffer.from(randomBytes(16)).subarray(0, 16).toString('base64url');
    const unsigned = `${expires}.${nonce}`;
    const relayState = `${unsigned}.${sign(`${org}\n${unsigned}`)}`;
    const stored = await backend.put(
      relayKey(org, nonce),
      JSON.stringify({
        rid,
        exp: expiresAt,
        digest: crypto.createHash('sha256').update(relayState).digest('base64url'),
        preAuthNonceHash: browserHash,
      }),
      ttlMs,
    );
    if (!stored) throw relayStateError('SAML_RELAY_STATE_INVALID');
    return relayState;
  }

  async function consumeRelayState({ relayState, orgSlug, preAuthNonceHash }) {
    const org = normalizeOrgSlug(orgSlug);
    const browserHash = normalizePreAuthNonceHash(preAuthNonceHash);
    const parts = typeof relayState === 'string' ? relayState.split('.') : [];
    if (
      parts.length !== 3
      || !/^[a-z0-9]{1,16}$/.test(parts[0])
      || !/^[A-Za-z0-9_-]{22}$/.test(parts[1])
    ) {
      throw relayStateError('SAML_RELAY_STATE_INVALID');
    }
    const unsigned = `${parts[0]}.${parts[1]}`;
    if (!timingSafeTextEqual(sign(`${org}\n${unsigned}`), parts[2])) {
      throw relayStateError('SAML_RELAY_STATE_INVALID');
    }
    const expiresAt = Number.parseInt(parts[0], 36);
    if (!Number.isSafeInteger(expiresAt)) {
      throw relayStateError('SAML_RELAY_STATE_INVALID');
    }
    if (expiresAt <= clock()) {
      throw relayStateError('SAML_RELAY_STATE_EXPIRED');
    }

    await ensureAvailable();
    const claimed = await backend.claimMatching(relayKey(org, parts[1]), browserHash);
    if (claimed.status === 'mismatch') {
      throw relayStateError('SAML_BROWSER_BINDING_INVALID');
    }
    if (claimed.status !== 'claimed' || !claimed.value) {
      throw relayStateError('SAML_RELAY_STATE_INVALID');
    }
    const raw = claimed.value;
    let stored;
    try {
      stored = JSON.parse(raw);
    } catch (_error) {
      throw relayStateError('SAML_RELAY_STATE_INVALID');
    }
    const requestId = normalizeRequestId(stored.rid);
    const expectedDigest = crypto.createHash('sha256').update(relayState).digest('base64url');
    if (
      stored.exp !== expiresAt
      || !timingSafeTextEqual(stored.preAuthNonceHash, browserHash)
      || !timingSafeTextEqual(stored.digest, expectedDigest)
    ) {
      throw relayStateError('SAML_RELAY_STATE_INVALID');
    }
    return { requestId };
  }

  async function close() {
    await closeRedis();
    backend = null;
    mode = 'closed';
    circuitState = 'closed';
    retryAt = 0;
  }

  return {
    close,
    consumeRelayState,
    createCacheProvider,
    ensureAvailable,
    issueRelayState,
    status,
  };
}

let defaultStore = null;
function getDefaultSamlRequestStore(env = process.env) {
  if (!defaultStore) defaultStore = createSamlRequestStore({ env });
  return defaultStore;
}

function __resetDefaultStoreForTest() {
  defaultStore = null;
}

module.exports = {
  DEFAULT_SAML_REDIS_COMMAND_TIMEOUT_MS,
  DEFAULT_SAML_REDIS_CONNECT_TIMEOUT_MS,
  DEFAULT_SAML_REDIS_PREFIX,
  DEFAULT_SAML_REDIS_RETRY_BASE_MS,
  DEFAULT_SAML_REDIS_RETRY_MAX_MS,
  DEFAULT_SAML_REQUEST_CACHE_MAX_ENTRIES,
  DEFAULT_SAML_REQUEST_TTL_MS,
  SAML_REQUEST_STORE_UNAVAILABLE,
  __resetDefaultStoreForTest,
  createSamlRequestStore,
  getDefaultSamlRequestStore,
  redisClientOptions,
};

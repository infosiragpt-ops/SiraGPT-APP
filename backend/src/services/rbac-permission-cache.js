'use strict';

const crypto = require('node:crypto');
const {
  MODES,
  resolveRbacEnforcementMode,
} = require('./rbac-enforcement-mode');

const INVALIDATION_CHANNEL = 'sira:rbac:permission-cache:invalidate:v1';
const MIN_CACHE_TTL_MS = 1_000;
const MAX_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 5_000;
const ENFORCE_FALLBACK_MAX_TTL_MS = 5_000;
const DEFAULT_REDIS_STARTUP_TIMEOUT_MS = 500;
const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 500;

function clampCacheTtl(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_CACHE_TTL_MS;
  return Math.max(MIN_CACHE_TTL_MS, Math.min(MAX_CACHE_TTL_MS, Math.floor(parsed)));
}

function clampMaxEntries(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_ENTRIES;
  return Math.max(100, Math.min(50_000, Math.floor(parsed)));
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function redisClientOptions(env = process.env) {
  return {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    lazyConnect: true,
    connectTimeout: clampInteger(
      env.RBAC_REDIS_CONNECT_TIMEOUT_MS,
      500,
      50,
      2_000,
    ),
    commandTimeout: clampInteger(
      env.RBAC_REDIS_COMMAND_TIMEOUT_MS,
      DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
      10,
      2_000,
    ),
  };
}

function defaultCreateRedis(env) {
  // Loaded lazily so deployments that do not configure Redis do not create
  // sockets merely by importing authorization middleware.
  // eslint-disable-next-line global-require
  const IORedis = require('ioredis');
  return new IORedis(env.REDIS_URL, redisClientOptions(env));
}

function cacheUserId(key) {
  return String(key || '').split('\u0000', 1)[0];
}

async function closeRedisClient(client, channel = null) {
  if (!client) return;
  if (channel && typeof client.unsubscribe === 'function') {
    try { await client.unsubscribe(channel); } catch (_) { /* best effort */ }
  }
  if (typeof client.quit === 'function') {
    try {
      await client.quit();
      return;
    } catch (_) { /* fall back to disconnect */ }
  }
  try { client.disconnect?.(); } catch (_) { /* best effort */ }
}

function withTimeout(promise, timeoutMs, code) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(code);
        error.code = code;
        reject(error);
      }, timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function createRbacPermissionCache({
  env = process.env,
  createRedis = () => defaultCreateRedis(env),
  instanceId = crypto.randomUUID(),
  clock = Date.now,
  logger = console,
  readVersion = async () => '0',
} = {}) {
  const configuredTtlMs = clampCacheTtl(env.RBAC_CACHE_TTL_MS);
  const maxEntries = clampMaxEntries(env.RBAC_CACHE_MAX_ENTRIES);
  const startupTimeoutMs = clampInteger(
    env.RBAC_REDIS_STARTUP_TIMEOUT_MS,
    DEFAULT_REDIS_STARTUP_TIMEOUT_MS,
    10,
    2_000,
  );
  const commandTimeoutMs = clampInteger(
    env.RBAC_REDIS_COMMAND_TIMEOUT_MS,
    DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
    10,
    2_000,
  );
  const entries = new Map();
  const inFlight = new Map();
  const userGenerations = new Map();
  let globalGeneration = 0;
  let publisher = null;
  let subscriber = null;
  let distributedReady = false;
  let initialized = false;
  let closed = false;
  let initPromise = null;

  function mode() {
    return resolveRbacEnforcementMode(env);
  }

  function redisConfigured() {
    return Boolean(env.REDIS_URL);
  }

  function cacheEnabled() {
    if (closed) return false;
    return true;
  }

  function effectiveTtlMs() {
    if (mode() === MODES.ENFORCE && !distributedReady) {
      return Math.min(configuredTtlMs, ENFORCE_FALLBACK_MAX_TTL_MS);
    }
    return configuredTtlMs;
  }

  function status() {
    const enabled = cacheEnabled();
    return Object.freeze({
      enabled,
      distributed: distributedReady,
      initialized,
      ttlMs: effectiveTtlMs(),
      maxEntries,
      reason: closed
        ? 'closed'
        : (
          mode() === MODES.ENFORCE && !distributedReady
            ? 'bounded_local_fallback'
            : null
        ),
    });
  }

  function generationFor(key) {
    const userId = cacheUserId(key);
    return `${globalGeneration}:${userGenerations.get(userId) || 0}`;
  }

  function clearLocal(userId) {
    if (!userId) {
      globalGeneration += 1;
      entries.clear();
      return;
    }
    const normalized = String(userId);
    userGenerations.set(normalized, (userGenerations.get(normalized) || 0) + 1);
    for (const key of entries.keys()) {
      if (cacheUserId(key) === normalized) entries.delete(key);
    }
  }

  function handleMessage(channel, raw) {
    if (channel !== INVALIDATION_CHANNEL) return;
    let message;
    try { message = JSON.parse(raw); } catch (_) { return; }
    if (!message || message.origin === instanceId || message.version !== 1) return;
    clearLocal(message.userId || null);
  }

  function disableDistributedCache() {
    distributedReady = false;
    if (mode() === MODES.ENFORCE) clearLocal(null);
  }

  async function init() {
    if (closed) return status();
    if (initialized) return status();
    if (initPromise) return initPromise;
    initPromise = (async () => {
      if (!redisConfigured()) {
        initialized = true;
        return status();
      }
      try {
        publisher = createRedis('publisher');
        subscriber = createRedis('subscriber');
        if (!publisher || !subscriber || typeof subscriber.subscribe !== 'function') {
          throw new Error('RBAC Redis pubsub unavailable');
        }
        subscriber.on?.('message', handleMessage);
        subscriber.on?.('end', disableDistributedCache);
        subscriber.on?.('close', disableDistributedCache);
        const connects = [publisher, subscriber]
          .filter((client) => typeof client?.connect === 'function')
          .map((client) => client.connect());
        if (connects.length) {
          await withTimeout(
            Promise.all(connects),
            startupTimeoutMs,
            'RBAC_CACHE_REDIS_CONNECT_TIMEOUT',
          );
        }
        await withTimeout(
          subscriber.subscribe(INVALIDATION_CHANNEL),
          startupTimeoutMs,
          'RBAC_CACHE_REDIS_SUBSCRIBE_TIMEOUT',
        );
        distributedReady = true;
      } catch (error) {
        disableDistributedCache();
        if (env.NODE_ENV !== 'test') {
          logger.warn?.({ code: 'RBAC_CACHE_REDIS_UNAVAILABLE' }, 'rbac_cache_redis_unavailable');
        }
        await Promise.all([
          withTimeout(
            closeRedisClient(publisher),
            startupTimeoutMs,
            'RBAC_CACHE_REDIS_CLOSE_TIMEOUT',
          ).catch(() => publisher?.disconnect?.()),
          withTimeout(
            closeRedisClient(subscriber, INVALIDATION_CHANNEL),
            startupTimeoutMs,
            'RBAC_CACHE_REDIS_CLOSE_TIMEOUT',
          ).catch(() => subscriber?.disconnect?.()),
        ]);
        publisher = null;
        subscriber = null;
      } finally {
        initialized = true;
      }
      return status();
    })();
    try {
      return await initPromise;
    } finally {
      initPromise = null;
    }
  }

  function prune() {
    const timestamp = clock();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= timestamp) entries.delete(key);
    }
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  async function currentDurableVersion() {
    try {
      const raw = await readVersion();
      const normalized = String(raw ?? '').trim();
      return /^(?:0|[1-9]\d*)$/.test(normalized) ? normalized : '0';
    } catch (error) {
      if (env.NODE_ENV !== 'test') {
        logger.warn?.(
          { code: 'RBAC_PERMISSION_VERSION_UNAVAILABLE' },
          'rbac_permission_version_unavailable',
        );
      }
      return null;
    }
  }

  async function get(key, loader) {
    if (typeof loader !== 'function') {
      throw new TypeError('RBAC permission cache loader is required');
    }
    const normalizedKey = String(key || '');
    if (!normalizedKey || !cacheEnabled()) return loader();
    const durableVersion = await currentDurableVersion();
    if (durableVersion == null) return loader();

    const cached = entries.get(normalizedKey);
    if (cached
        && cached.expiresAt > clock()
        && cached.durableVersion === durableVersion) {
      // Refresh insertion order for bounded LRU eviction.
      entries.delete(normalizedKey);
      entries.set(normalizedKey, cached);
      return cached.value;
    }
    if (cached) entries.delete(normalizedKey);

    const generation = generationFor(normalizedKey);
    const flightKey = `${normalizedKey}\u0000GEN:${generation}\u0000VER:${durableVersion}`;
    if (inFlight.has(flightKey)) return inFlight.get(flightKey);

    const pending = Promise.resolve()
      .then(loader)
      .then(async (value) => {
        const versionAfterLoad = await currentDurableVersion();
        if (cacheEnabled()
            && generationFor(normalizedKey) === generation
            && versionAfterLoad === durableVersion) {
          prune();
          entries.set(normalizedKey, {
            value,
            expiresAt: clock() + effectiveTtlMs(),
            generation,
            durableVersion,
          });
        }
        return value;
      })
      .finally(() => {
        inFlight.delete(flightKey);
      });
    inFlight.set(flightKey, pending);
    return pending;
  }

  async function invalidate(userId = null) {
    clearLocal(userId);
    if (!publisher || !distributedReady || typeof publisher.publish !== 'function') return false;
    try {
      await withTimeout(
        publisher.publish(INVALIDATION_CHANNEL, JSON.stringify({
          version: 1,
          origin: instanceId,
          userId: userId ? String(userId) : null,
        })),
        commandTimeoutMs,
        'RBAC_CACHE_REDIS_PUBLISH_TIMEOUT',
      );
      return true;
    } catch (_) {
      disableDistributedCache();
      return false;
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    distributedReady = false;
    entries.clear();
    inFlight.clear();
    await Promise.all([
      withTimeout(
        closeRedisClient(publisher),
        startupTimeoutMs,
        'RBAC_CACHE_REDIS_CLOSE_TIMEOUT',
      ).catch(() => publisher?.disconnect?.()),
      withTimeout(
        closeRedisClient(subscriber, INVALIDATION_CHANNEL),
        startupTimeoutMs,
        'RBAC_CACHE_REDIS_CLOSE_TIMEOUT',
      ).catch(() => subscriber?.disconnect?.()),
    ]);
    publisher = null;
    subscriber = null;
  }

  return {
    init,
    get,
    invalidate,
    close,
    status,
    _entriesForTests: entries,
  };
}

module.exports = {
  INVALIDATION_CHANNEL,
  MIN_CACHE_TTL_MS,
  MAX_CACHE_TTL_MS,
  DEFAULT_CACHE_TTL_MS,
  ENFORCE_FALLBACK_MAX_TTL_MS,
  DEFAULT_REDIS_STARTUP_TIMEOUT_MS,
  DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
  createRbacPermissionCache,
  clampCacheTtl,
  redisClientOptions,
};

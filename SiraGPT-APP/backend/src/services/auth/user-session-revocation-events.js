'use strict';

const crypto = require('node:crypto');

const REVOCATION_CHANNEL = 'sira:auth:user-session-revoked:v1';
const DEFAULT_REDIS_CONNECT_TIMEOUT_MS = 500;
const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 500;

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function revocationRedisOptions(env = process.env) {
  return {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    lazyConnect: true,
    connectTimeout: clampInteger(
      env.AUTH_REVOCATION_REDIS_CONNECT_TIMEOUT_MS,
      DEFAULT_REDIS_CONNECT_TIMEOUT_MS,
      10,
      2_000,
    ),
    commandTimeout: clampInteger(
      env.AUTH_REVOCATION_REDIS_COMMAND_TIMEOUT_MS,
      DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
      10,
      2_000,
    ),
  };
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

function defaultCreateRedis(env) {
  // eslint-disable-next-line global-require
  const IORedis = require('ioredis');
  return new IORedis(env.REDIS_URL, revocationRedisOptions(env));
}

async function closeRedisClient(client, channel = null, timeoutMs = 500) {
  if (!client) return;
  if (channel && typeof client.unsubscribe === 'function') {
    await withTimeout(
      client.unsubscribe(channel),
      timeoutMs,
      'AUTH_REVOCATION_REDIS_UNSUBSCRIBE_TIMEOUT',
    ).catch(() => {});
  }
  if (typeof client.quit === 'function') {
    try {
      await withTimeout(
        client.quit(),
        timeoutMs,
        'AUTH_REVOCATION_REDIS_QUIT_TIMEOUT',
      );
      return;
    } catch {
      // Fall through to the synchronous hard disconnect.
    }
  }
  try { client.disconnect?.(); } catch { /* best effort */ }
}

function normalizeRevocationEvent(event) {
  if (!event?.userId) return null;
  return {
    userId: String(event.userId),
    reason: String(event.reason || 'sessions_revoked').slice(0, 123),
  };
}

function createUserSessionRevocationBus({
  env = process.env,
  createRedis = () => defaultCreateRedis(env),
  instanceId = crypto.randomUUID(),
  onEvent = () => {},
  logger = console,
} = {}) {
  const options = revocationRedisOptions(env);
  let publisher = null;
  let subscriber = null;
  let initialized = false;
  let distributedReady = false;
  let closed = false;
  let initPromise = null;

  function status() {
    return Object.freeze({
      initialized,
      distributed: distributedReady,
      closed,
    });
  }

  function markUnavailable() {
    distributedReady = false;
  }

  function handleMessage(channel, raw) {
    if (channel !== REVOCATION_CHANNEL) return;
    let envelope;
    try { envelope = JSON.parse(raw); } catch { return; }
    if (!envelope || envelope.version !== 1 || envelope.origin === instanceId) return;
    const event = normalizeRevocationEvent(envelope);
    if (!event) return;
    try { onEvent(event); } catch { /* one socket listener cannot break pub/sub */ }
  }

  async function init() {
    if (closed || initialized) return status();
    if (initPromise) return initPromise;
    initPromise = (async () => {
      if (!env.REDIS_URL) {
        initialized = true;
        return status();
      }
      try {
        publisher = createRedis('publisher');
        subscriber = createRedis('subscriber');
        if (!publisher || !subscriber || typeof subscriber.subscribe !== 'function') {
          throw new Error('AUTH_REVOCATION_REDIS_UNAVAILABLE');
        }
        subscriber.on?.('message', handleMessage);
        subscriber.on?.('end', markUnavailable);
        subscriber.on?.('close', markUnavailable);
        subscriber.on?.('error', markUnavailable);
        publisher.on?.('error', markUnavailable);
        const connects = [publisher, subscriber]
          .filter((client) => typeof client?.connect === 'function')
          .map((client) => client.connect());
        if (connects.length) {
          await withTimeout(
            Promise.all(connects),
            options.connectTimeout,
            'AUTH_REVOCATION_REDIS_CONNECT_TIMEOUT',
          );
        }
        await withTimeout(
          subscriber.subscribe(REVOCATION_CHANNEL),
          options.connectTimeout,
          'AUTH_REVOCATION_REDIS_SUBSCRIBE_TIMEOUT',
        );
        distributedReady = true;
      } catch (error) {
        markUnavailable();
        if (env.NODE_ENV !== 'test') {
          logger.warn?.(
            { code: 'AUTH_REVOCATION_REDIS_UNAVAILABLE' },
            'auth_revocation_redis_unavailable',
          );
        }
        await Promise.all([
          closeRedisClient(publisher, null, options.connectTimeout),
          closeRedisClient(subscriber, REVOCATION_CHANNEL, options.connectTimeout),
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

  async function publish(rawEvent) {
    const event = normalizeRevocationEvent(rawEvent);
    if (!event || !distributedReady || typeof publisher?.publish !== 'function') {
      return false;
    }
    try {
      await withTimeout(
        publisher.publish(REVOCATION_CHANNEL, JSON.stringify({
          version: 1,
          origin: instanceId,
          ...event,
        })),
        options.commandTimeout,
        'AUTH_REVOCATION_REDIS_PUBLISH_TIMEOUT',
      );
      return true;
    } catch {
      markUnavailable();
      return false;
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    distributedReady = false;
    await Promise.all([
      closeRedisClient(publisher, null, options.connectTimeout),
      closeRedisClient(subscriber, REVOCATION_CHANNEL, options.connectTimeout),
    ]);
    publisher = null;
    subscriber = null;
  }

  return {
    init,
    publish,
    close,
    status,
  };
}

// Process-local fan-out for long-lived transports. Database session deletion is
// the source of truth; this bus only shortens the window before already-open
// WebSockets notice an account deletion/revocation.
const listeners = new Set();
let distributedBus = null;
let distributedInitPromise = null;

function onUserSessionsRevoked(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('user-session revocation listener must be a function');
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emitUserSessionsRevoked({ userId, reason = 'sessions_revoked' } = {}) {
  const event = normalizeRevocationEvent({ userId, reason });
  if (!event) return 0;
  let delivered = 0;
  for (const listener of [...listeners]) {
    try {
      listener(event);
      delivered += 1;
    } catch {
      // A stale socket listener must never roll back or fail account deletion.
    }
  }
  return delivered;
}

async function initializeUserSessionRevocationBus({
  bus = null,
  ...options
} = {}) {
  if (distributedBus) return distributedBus.status?.() || { initialized: true };
  if (distributedInitPromise) return distributedInitPromise;
  distributedInitPromise = (async () => {
    distributedBus = bus || createUserSessionRevocationBus({
      ...options,
      onEvent: emitUserSessionsRevoked,
    });
    try {
      await distributedBus.init();
    } catch {
      // Redis is an acceleration path. Periodic persisted-session validation
      // remains authoritative when startup or subscription fails.
    }
    return distributedBus.status?.() || { initialized: true };
  })();
  try {
    return await distributedInitPromise;
  } finally {
    distributedInitPromise = null;
  }
}

async function publishUserSessionsRevoked(rawEvent) {
  const event = normalizeRevocationEvent(rawEvent);
  if (!event) return { delivered: 0, published: false };
  const delivered = emitUserSessionsRevoked(event);
  let published = false;
  try {
    published = Boolean(await distributedBus?.publish?.(event));
  } catch {
    published = false;
  }
  return { delivered, published };
}

async function closeUserSessionRevocationBus() {
  const bus = distributedBus;
  distributedBus = null;
  distributedInitPromise = null;
  try { await bus?.close?.(); } catch { /* bounded best effort */ }
}

function getUserSessionRevocationBusStatus() {
  return distributedBus?.status?.() || {
    initialized: false,
    distributed: false,
    closed: false,
  };
}

module.exports = {
  DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
  DEFAULT_REDIS_CONNECT_TIMEOUT_MS,
  REVOCATION_CHANNEL,
  closeUserSessionRevocationBus,
  createUserSessionRevocationBus,
  emitUserSessionsRevoked,
  getUserSessionRevocationBusStatus,
  initializeUserSessionRevocationBus,
  onUserSessionsRevoked,
  publishUserSessionsRevoked,
  revocationRedisOptions,
};

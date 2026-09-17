'use strict';

/**
 * codex/redis-pubsub — best-effort pub/sub for live run streaming. The event
 * store persists every event to `codex_events` (durable, the replay source of
 * truth) and ALSO publishes it here so connected SSE clients see it live.
 *
 * Reuses the same ioredis + REDIS_URL + redis-resilience stack as BullMQ
 * (goal-queue.js). Publishing is best-effort: with Redis down the DB append
 * still succeeds and only the live fan-out is lost (replay stays intact).
 * A Redis SUBSCRIBE connection cannot issue other commands, so subscribers
 * get their own dedicated connection.
 */

const {
  attachRedisListeners,
  createThrottledLogger,
  markRedisFailure,
  reconnectDelay,
} = require('../agents/redis-resilience');

const DEFAULT_PUBLISH_TIMEOUT_MS = 200;
const MIN_PUBLISH_TIMEOUT_MS = 25;
const MAX_PUBLISH_TIMEOUT_MS = 2_000;
const PUBLISH_WARNING_WINDOW_MS = 60_000;

let warnPublishFailure = createThrottledLogger(PUBLISH_WARNING_WINDOW_MS);

function channelFor(runId) {
  return `codex:run:${runId}`;
}

function redisUrl(env = process.env) {
  return env.REDIS_URL || '';
}

function isConfigured(env = process.env) {
  return Boolean(redisUrl(env));
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function resolvePublishTimeoutMs(env = process.env) {
  return clampInteger(
    env.CODEX_REDIS_PUBLISH_TIMEOUT_MS,
    DEFAULT_PUBLISH_TIMEOUT_MS,
    MIN_PUBLISH_TIMEOUT_MS,
    MAX_PUBLISH_TIMEOUT_MS,
  );
}

function publisherRedisOptions(env = process.env) {
  const timeoutMs = resolvePublishTimeoutMs(env);
  return {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    enableOfflineQueue: false,
    connectTimeout: timeoutMs,
    commandTimeout: timeoutMs,
    retryStrategy(attempt) {
      return attempt <= 1 ? Math.min(50, timeoutMs) : null;
    },
  };
}

function newConnection(label, env = process.env, options = {}) {
  const url = redisUrl(env);
  if (!url) return null;
  // Keep the optional Redis dependency off the durable DB-only path.
  // eslint-disable-next-line global-require
  const IORedis = require('ioredis');
  const conn = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: reconnectDelay,
    enableOfflineQueue: true,
    ...options,
  });
  attachRedisListeners(conn, { label });
  return conn;
}

// Lazy shared publisher connection (a normal connection, not in subscribe mode).
let publisher;
function getPublisher(env = process.env) {
  if (publisher && publisher.status !== 'end') return publisher;
  publisher = newConnection('codex-pubsub', env, publisherRedisOptions(env));
  return publisher;
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`Redis publish timed out after ${timeoutMs}ms`);
        err.code = 'CODEX_REDIS_PUBLISH_TIMEOUT';
        reject(err);
      }, timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Publish one event envelope on the run's channel. Best-effort: never throws,
 * returns true only when the message was handed to Redis.
 */
async function publishEvent(
  runId,
  envelope,
  { env = process.env, connection = null, logger = console } = {},
) {
  const timeoutMs = resolvePublishTimeoutMs(env);
  try {
    const conn = connection || getPublisher(env);
    if (!conn) return false;
    await withTimeout((async () => {
      if (conn.status === 'wait' && typeof conn.connect === 'function') {
        await conn.connect();
      }
      await conn.publish(channelFor(runId), JSON.stringify(envelope));
    })(), timeoutMs);
    return true;
  } catch (err) {
    // Redis blip — the DB append already happened, so this is non-fatal.
    markRedisFailure(err);
    if (env.NODE_ENV !== 'test') {
      warnPublishFailure(() => {
        logger.warn('[codex-pubsub] publish failed; durable replay remains available:', err?.message || err);
      });
    }
    return false;
  }
}

/**
 * Create a dedicated subscriber for one run. Calls `onEvent(envelope)` for each
 * live message. Returns `{ close }` to tear it down (unsubscribe + quit).
 * Returns null when Redis is not configured (caller falls back to replay-only).
 */
async function createRunSubscriber(runId, onEvent, { env = process.env } = {}) {
  const conn = newConnection('codex-pubsub-sub', env);
  if (!conn) return null;
  const channel = channelFor(runId);
  conn.on('message', (chan, message) => {
    if (chan !== channel) return;
    let envelope;
    try { envelope = JSON.parse(message); } catch { return; }
    try { onEvent(envelope); } catch { /* consumer error must not kill the sub */ }
  });
  try {
    await conn.subscribe(channel);
  } catch (err) {
    try { conn.disconnect(); } catch { /* ignore */ }
    return null;
  }
  return {
    close: async () => {
      try { await conn.unsubscribe(channel); } catch { /* ignore */ }
      try { conn.disconnect(); } catch { /* ignore */ }
    },
  };
}

/** Test/shutdown hook: drop the shared publisher connection. */
function _resetPublisher() {
  if (publisher) {
    try { publisher.disconnect(); } catch { /* ignore */ }
  }
  publisher = undefined;
  warnPublishFailure = createThrottledLogger(PUBLISH_WARNING_WINDOW_MS);
}

module.exports = {
  channelFor,
  isConfigured,
  publisherRedisOptions,
  resolvePublishTimeoutMs,
  getPublisher,
  publishEvent,
  createRunSubscriber,
  _resetPublisher,
};

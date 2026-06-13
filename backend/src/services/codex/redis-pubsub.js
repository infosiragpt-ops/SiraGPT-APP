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

const IORedis = require('ioredis');
const { attachRedisListeners, reconnectDelay } = require('../agents/redis-resilience');

function channelFor(runId) {
  return `codex:run:${runId}`;
}

function redisUrl(env = process.env) {
  return env.REDIS_URL || '';
}

function isConfigured(env = process.env) {
  return Boolean(redisUrl(env));
}

function newConnection(label, env = process.env) {
  const url = redisUrl(env);
  if (!url) return null;
  const conn = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: reconnectDelay,
    enableOfflineQueue: true,
  });
  attachRedisListeners(conn, { label });
  return conn;
}

// Lazy shared publisher connection (a normal connection, not in subscribe mode).
let publisher;
function getPublisher(env = process.env) {
  if (publisher) return publisher;
  publisher = newConnection('codex-pubsub', env);
  return publisher;
}

/**
 * Publish one event envelope on the run's channel. Best-effort: never throws,
 * returns true only when the message was handed to Redis.
 */
async function publishEvent(runId, envelope, { env = process.env } = {}) {
  try {
    const conn = getPublisher(env);
    if (!conn) return false;
    await conn.publish(channelFor(runId), JSON.stringify(envelope));
    return true;
  } catch (err) {
    // Redis blip — the DB append already happened, so this is non-fatal.
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[codex-pubsub] publish failed:', err?.message || err);
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
}

module.exports = {
  channelFor,
  isConfigured,
  getPublisher,
  publishEvent,
  createRunSubscriber,
  _resetPublisher,
};

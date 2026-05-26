'use strict';

/**
 * Chat-run BullMQ queue helper.
 *
 * This is the producer-side façade. The HTTP route (`POST /api/ai/generate`)
 * persists a `ChatRun` row + an assistant `Message` placeholder, then
 * calls `enqueueChatRun({ runId })` to schedule the worker.
 *
 * Sprint 3 introduces the queue itself + the row schema only. The
 * `routes/ai.js` refactor that actually publishes jobs lives in
 * Sprint 4 behind `CHAT_RUN_QUEUE_ENABLED`. Today the queue is idle —
 * importing this module does not start any worker. The worker module
 * `chat-run-worker.js` is also dormant (Sprint 4 wires it).
 *
 * Separation from `agent-task-queue.js`:
 *  - Different queue name (`CHAT_RUN_QUEUE_NAME`, default
 *    `siragpt-chat-runs`) so chat throughput cannot starve agent jobs
 *    and vice-versa.
 *  - Different concurrency knob (`CHAT_RUN_WORKER_CONCURRENCY`).
 *  - Idempotency on `jobId = runId` — re-enqueue of the same run is a
 *    no-op for BullMQ (the existing row in the DB is authoritative).
 */

const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const { attachRedisListeners, reconnectDelay } = require('./agents/redis-resilience');

let queue;
let queueConnection;

function getQueueName() {
  return process.env.CHAT_RUN_QUEUE_NAME || 'siragpt-chat-runs';
}

function requireRedisUrl() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL is required for the chat-run queue');
  }
  return redisUrl;
}

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function shouldSkipBullMQVersionCheck({ redisUrl = process.env.REDIS_URL, env = process.env } = {}) {
  if (isTruthyEnv(env.BULLMQ_SKIP_VERSION_CHECK)) return true;
  if (!redisUrl) return false;
  try {
    const { hostname } = new URL(redisUrl);
    return /(^|\.)upstash\.io$/i.test(hostname);
  } catch (_) {
    return /upstash\.io/i.test(String(redisUrl));
  }
}

function getBullMQRuntimeOptions({ redisUrl = process.env.REDIS_URL, env = process.env } = {}) {
  return shouldSkipBullMQVersionCheck({ redisUrl, env }) ? { skipVersionCheck: true } : {};
}

function createRedisConnection({ label = 'chat-run-queue' } = {}) {
  const redisUrl = requireRedisUrl();
  const conn = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: reconnectDelay,
    enableOfflineQueue: true,
  });
  attachRedisListeners(conn, { label });
  return conn;
}

function getChatRunQueue() {
  if (queue) return queue;
  queueConnection = createRedisConnection();
  queue = new Queue(getQueueName(), {
    ...getBullMQRuntimeOptions(),
    connection: queueConnection,
    defaultJobOptions: {
      // Worker handles retries via the ChatRun.attempt column itself —
      // we keep BullMQ attempts at 1 so the row is the single source
      // of truth for retry semantics.
      attempts: 1,
      removeOnComplete: { age: 60 * 60 * 24, count: 2000 },
      removeOnFail: { age: 60 * 60 * 24 * 7, count: 2000 },
    },
  });
  return queue;
}

/**
 * Enqueue a chat run for the worker to process.
 *
 * Idempotent on `runId`: passing the same id again returns the
 * existing job rather than creating a duplicate (BullMQ behaviour).
 * The HTTP route should persist the `ChatRun` row first, then call
 * this — if the enqueue throws, a sweeper job picks up
 * `status='pending'` rows older than N seconds and retries.
 *
 * @param {{ runId: string }} payload — must include the persisted ChatRun id.
 * @param {object} [opts] — BullMQ job options (delay, priority, …).
 */
async function enqueueChatRun(payload, opts = {}) {
  if (!payload?.runId) throw new Error('runId is required');
  const q = getChatRunQueue();
  return q.add('process-chat-run', payload, {
    jobId: payload.runId,
    ...opts,
  });
}

/**
 * Test/shutdown helper. Closes the BullMQ queue + the underlying
 * Redis connection. Safe to call when nothing was opened (no-op).
 */
async function closeChatRunQueue() {
  try {
    if (queue) await queue.close();
  } finally {
    queue = null;
  }
  try {
    if (queueConnection) await queueConnection.quit();
  } catch {
    // ignore — connection may already be closed
  } finally {
    queueConnection = null;
  }
}

module.exports = {
  getQueueName,
  getChatRunQueue,
  enqueueChatRun,
  closeChatRunQueue,
  // exported for tests
  _internals: {
    requireRedisUrl,
    shouldSkipBullMQVersionCheck,
    getBullMQRuntimeOptions,
  },
};

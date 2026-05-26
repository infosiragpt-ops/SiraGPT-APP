'use strict';

/**
 * Chat-run BullMQ worker (Sprint 3 skeleton — dormant in production until
 * Sprint 4 wires `routes/ai.js` to publish jobs).
 *
 * Importing this module has no side effects. Callers must call
 * `startChatRunWorker()` to actually attach a worker to the queue;
 * `stopChatRunWorker()` tears it down for tests/shutdown.
 *
 * The processor (`runChatJob`) is intentionally not implemented yet —
 * it will read the `ChatRun` row by id, stream the generation through
 * `services/chat-generation.js` (extracted from `routes/ai.js` in
 * Sprint 4), publish token chunks via Redis Pub/Sub for low-latency
 * client tailing, and batch-write `partialContent + lastChunkAt` to
 * the DB for durability. For Sprint 3 we ship the wiring and leave the
 * processor as a clearly-marked stub so the worker module exists,
 * compiles, and can be tested for boot-time wiring without a Redis
 * server.
 */

const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const { attachRedisListeners, reconnectDelay } = require('./agents/redis-resilience');

let worker;
let workerConnection;

function getQueueName() {
  return process.env.CHAT_RUN_QUEUE_NAME || 'siragpt-chat-runs';
}

function getConcurrency() {
  const raw = parseInt(process.env.CHAT_RUN_WORKER_CONCURRENCY || '4', 10);
  if (!Number.isFinite(raw) || raw < 1) return 4;
  return Math.min(raw, 64);
}

function requireRedisUrl() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL is required to start the chat-run worker');
  }
  return redisUrl;
}

function createWorkerConnection({ label = 'chat-run-worker' } = {}) {
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

/**
 * Stub processor for Sprint 3. Sprint 4 replaces this with the real
 * loop that loads ChatRun, dispatches to chat-generation, streams,
 * persists, and finalises.
 */
async function runChatJob(/* job */) {
  // Intentionally a no-op until Sprint 4. Returning early so dev
  // environments that accidentally enqueue a job pre-cutover get a
  // clean "completed" callback rather than a stuck queue.
  return { skipped: true, reason: 'chat-run-worker not yet implemented (Sprint 3 stub)' };
}

/**
 * Attach a BullMQ Worker to the chat-run queue. Idempotent: calling
 * twice returns the same instance.
 *
 * Not called automatically at module load — callers (e.g. the future
 * `index.js` boot path) decide whether to start the worker, typically
 * behind the `CHAT_RUN_QUEUE_ENABLED` flag.
 */
function startChatRunWorker({ processor = runChatJob, label = 'chat-run-worker' } = {}) {
  if (worker) return worker;
  workerConnection = createWorkerConnection({ label });
  worker = new Worker(getQueueName(), processor, {
    connection: workerConnection,
    concurrency: getConcurrency(),
    lockDuration: 4 * 60 * 1000, // 4 minutes
    stalledInterval: 60 * 1000,
    maxStalledCount: 2,
  });
  // Surface unhandled failures to the structured log so ops can grep.
  worker.on('failed', (job, err) => {
    const runId = job?.id || job?.data?.runId || 'unknown';
    console.error(`[chat-run-worker] job failed runId=${runId} err=${err?.message || err}`);
  });
  return worker;
}

async function stopChatRunWorker() {
  try {
    if (worker) await worker.close();
  } finally {
    worker = null;
  }
  try {
    if (workerConnection) await workerConnection.quit();
  } catch {
    // ignore — connection may already be closed
  } finally {
    workerConnection = null;
  }
}

module.exports = {
  getQueueName,
  getConcurrency,
  startChatRunWorker,
  stopChatRunWorker,
  // Exported so the future Sprint 4 processor can swap in its
  // implementation and so tests can call it directly.
  runChatJob,
};

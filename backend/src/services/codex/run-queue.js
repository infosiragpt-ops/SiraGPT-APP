'use strict';

/**
 * codex/run-queue — BullMQ queue + worker for Codex V2 runs (spec §3, §7,
 * feature 05). Each run is a job on the `codex-runs` queue; the worker drives
 * the agent loop (feature 06) and persists the lifecycle to `codex_runs` +
 * `codex_events`. Mirrors the queue/worker/recovery shape of goal-queue.js.
 *
 * The worker is registered ONLY when the flag is on (see startCodexWorker).
 * Redis connection + resilience are shared with the rest of the backend.
 */

const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const { attachRedisListeners, reconnectDelay, isTransientRedisError } = require('../agents/redis-resilience');
const { isCodexV2Enabled } = require('./flags');

const QUEUE_NAME = process.env.CODEX_QUEUE_NAME || 'codex-runs';

function getQueueName() {
  return QUEUE_NAME;
}

function requireRedisUrl() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is required for codex runs');
  return redisUrl;
}

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function getRuntimeOptions({ redisUrl = process.env.REDIS_URL } = {}) {
  if (isTruthyEnv(process.env.BULLMQ_SKIP_VERSION_CHECK)) return { skipVersionCheck: true };
  try {
    if (redisUrl && /(^|\.)upstash\.io$/i.test(new URL(redisUrl).hostname)) return { skipVersionCheck: true };
  } catch { /* ignore */ }
  return {};
}

function createRedisConnection({ label = 'codex-runs' } = {}) {
  const conn = new IORedis(requireRedisUrl(), {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: reconnectDelay,
    enableOfflineQueue: true,
  });
  attachRedisListeners(conn, { label });
  return conn;
}

let queue;
let queueConnection;

function getCodexQueue() {
  if (queue) return queue;
  queueConnection = createRedisConnection({ label: 'codex-runs-queue' });
  queue = new Queue(QUEUE_NAME, {
    ...getRuntimeOptions(),
    connection: queueConnection,
    defaultJobOptions: {
      attempts: 1, // the run lifecycle owns retry/error via codex_runs.status
      removeOnComplete: { age: 60 * 60 * 24, count: 500 },
      removeOnFail: { age: 60 * 60 * 24 * 7, count: 1000 },
    },
  });
  queue.on('error', (err) => {
    if (isTransientRedisError(err)) return;
    console.error('[codex-runs] queue error:', err?.message || err);
  });
  return queue;
}

/** Enqueue a persisted run. Idempotent on runId (jobId === runId). */
async function enqueueCodexRun({ runId }, opts = {}) {
  if (!runId) throw new Error('runId is required');
  const q = getCodexQueue();
  return q.add('codex-run', { runId }, { jobId: opts.jobId || String(runId), priority: opts.priority });
}

/** Remove a not-yet-running job. Running runs cancel cooperatively (status flip). */
async function cancelQueuedCodexRun(runId) {
  if (!runId) return { cancelled: false };
  const q = getCodexQueue();
  const job = await q.getJob(String(runId)).catch(() => null);
  if (!job) return { cancelled: false, reason: 'not_found' };
  const state = await job.getState().catch(() => null);
  if (['waiting', 'delayed', 'prioritized', 'paused'].includes(state)) {
    await job.remove().catch(() => {});
    return { cancelled: true, state };
  }
  return { cancelled: false, state };
}

let worker;
let workerConnection;

/**
 * Start the codex worker. No-op (returns null) when the flag is off — the
 * worker simply does not exist, so enqueued jobs never run. `processor` is
 * injectable for tests; defaults to the run-processor.
 */
function startCodexWorker({ env = process.env, processor } = {}) {
  if (worker) return worker;
  if (!isCodexV2Enabled(env)) return null;
  if (!process.env.REDIS_URL) {
    console.warn('[codex-runs] REDIS_URL not set — worker not started');
    return null;
  }
  const concurrency = Math.max(1, Number.parseInt(env.CODEX_WORKER_CONCURRENCY || '2', 10) || 2);
  const handler = processor || ((job) => require('./run-processor').processCodexRunJob({ runId: job.data?.runId }));

  workerConnection = createRedisConnection({ label: 'codex-runs-worker' });
  worker = new Worker(QUEUE_NAME, handler, {
    ...getRuntimeOptions(),
    connection: workerConnection,
    concurrency,
    lockDuration: Math.max(60_000, Number.parseInt(env.CODEX_RUN_TIMEOUT_MS || String(15 * 60_000), 10) || 15 * 60_000) + 60_000,
  });
  worker.on('error', (err) => {
    if (isTransientRedisError(err)) return;
    console.error('[codex-runs] worker error:', err?.message || err);
  });
  worker.on('failed', (job, err) => {
    console.error(`[codex-runs] job ${job?.id} failed:`, err?.message || err);
  });
  return worker;
}

/** Look up a job by runId (jobId === runId). Returns the job or null. */
async function peekCodexJob(runId) {
  if (!runId) return null;
  return getCodexQueue().getJob(String(runId)).catch(() => null);
}

async function getCodexQueueHealth() {
  const q = getCodexQueue();
  const counts = await q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
  return { queue: QUEUE_NAME, redisUrlConfigured: Boolean(process.env.REDIS_URL), counts };
}

async function closeCodexWorker() {
  const closing = [];
  if (worker) closing.push(worker.close());
  if (workerConnection) closing.push(workerConnection.quit().catch(() => workerConnection.disconnect()));
  worker = null;
  workerConnection = null;
  await Promise.allSettled(closing);
}

async function closeCodexQueue() {
  const closing = [];
  if (queue) closing.push(queue.close());
  if (queueConnection) closing.push(queueConnection.quit().catch(() => queueConnection.disconnect()));
  queue = null;
  queueConnection = null;
  await Promise.allSettled(closing);
}

module.exports = {
  getQueueName,
  requireRedisUrl,
  createRedisConnection,
  getRuntimeOptions,
  getCodexQueue,
  enqueueCodexRun,
  cancelQueuedCodexRun,
  peekCodexJob,
  startCodexWorker,
  getCodexQueueHealth,
  closeCodexWorker,
  closeCodexQueue,
};

'use strict';

/**
 * BullMQ queue `doc-jobs`, concurrency 2, timeout 180s.
 * Job payloads are metadata only — never binary buffers / base64.
 * Files live on disk via artifact-store.
 *
 * Without REDIS_URL the enqueue runs the pipeline in-process (tests / CI).
 * The worker starts only with FEATURE_DOC_ENGINE=1.
 */

const { Queue, Worker } = require('bullmq');
const { getDocEngineConfig, isDocEngineEnabled } = require('./flags');
const { createJob, getJob, setError, appendEvent } = require('./job-store');
const { runPipeline } = require('./pipeline');
const artifacts = require('./artifact-store');

function withTimeout(promise, ms, label = 'doc-engine') {
  let timer;
  const timed = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms);
  });
  return Promise.race([promise, timed]).finally(() => clearTimeout(timer));
}

function assertNoBinaryPayload(data) {
  if (!data || typeof data !== 'object') return;
  for (const key of Object.keys(data)) {
    if (/b64|buffer|binary|bytes/i.test(key)) {
      throw new Error('doc-jobs payload must not include binary buffers');
    }
    const v = data[key];
    if (Buffer.isBuffer(v)) {
      throw new Error('doc-jobs payload must not include binary buffers');
    }
  }
}

async function executeJob(data) {
  assertNoBinaryPayload(data);
  const cfg = getDocEngineConfig();
  const sourceBuffer = artifacts.readInput(data.jobId, 'source');
  const templateBuffer = artifacts.readInput(data.jobId, 'template');
  try {
    const result = await withTimeout(runPipeline({
      sourceBuffer,
      templateBuffer,
      instructions: data.instructions,
      jobId: data.jobId,
      userId: data.userId,
    }), cfg.timeoutMs);
    if (result && result.ok === false) throw new Error(result.error || 'doc-engine job failed');
    return result;
  } catch (err) {
    const message = String(err?.message || err).slice(0, 2000);
    try {
      setError(data.jobId, message);
      appendEvent(data.jobId, 'error', { message });
    } catch { /* noop */ }
    throw err;
  } finally {
    /* artifact files stay until TTL sweep; workspace scratch is cleaned in pipeline */
  }
}

let queue = null;
let queueConnection = null;
let worker = null;
let workerConnection = null;

function getQueueName(env = process.env) {
  return getDocEngineConfig(env).queueName;
}

function createRedisConnection({ label = 'doc-engine-queue' } = {}) {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is required for doc-jobs');
  const IORedis = require('ioredis');
  const { attachRedisListeners, reconnectDelay } = require('../agents/redis-resilience');
  const conn = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: reconnectDelay,
    enableOfflineQueue: true,
  });
  attachRedisListeners(conn, { label });
  return conn;
}

function getBullMQRuntimeOptions() {
  try {
    const goal = require('../goal-queue');
    return goal.getBullMQRuntimeOptions();
  } catch {
    return {};
  }
}

function getDocQueue() {
  if (queue) return queue;
  queueConnection = createRedisConnection({ label: 'doc-engine-queue' });
  queue = new Queue(getQueueName(), {
    ...getBullMQRuntimeOptions(),
    connection: queueConnection,
    defaultJobOptions: {
      attempts: 1,
      timeout: getDocEngineConfig().timeoutMs,
      removeOnComplete: { age: 60 * 60, count: 200 },
      removeOnFail: { age: 60 * 60 * 24, count: 200 },
    },
  });
  queue.on('error', (err) => {
    console.error('[doc-engine] queue error:', err?.message || err);
  });
  return queue;
}

async function enqueueDocJob({
  userId,
  sourceBuffer,
  templateBuffer,
  instructions,
  sourceName,
  templateName,
} = {}) {
  const job = createJob({ userId, instructions, sourceName, templateName });
  artifacts.writeInputs(job.id, { sourceBuffer, templateBuffer });
  const payload = {
    jobId: job.id,
    userId,
    instructions,
    sourceName,
    templateName,
  };
  assertNoBinaryPayload(payload);

  if (!process.env.REDIS_URL) {
    setImmediate(() => {
      executeJob(payload).catch((err) => {
        try { console.error('[doc-engine] inline job failed:', err?.message || err); } catch { /* noop */ }
      });
    });
    return job;
  }

  const q = getDocQueue();
  await q.add('doc-transform', payload, {
    jobId: job.id,
    timeout: getDocEngineConfig().timeoutMs,
  });
  return job;
}

function startDocEngineWorker({ env = process.env } = {}) {
  if (!isDocEngineEnabled(env)) return null;
  if (!env.REDIS_URL) return null;
  if (worker) return worker;
  const cfg = getDocEngineConfig(env);
  workerConnection = createRedisConnection({ label: 'doc-engine-worker' });
  worker = new Worker(getQueueName(env), async (bullJob) => {
    const data = bullJob.data || {};
    assertNoBinaryPayload(data);
    const result = await executeJob(data);
    if (!result.ok) throw new Error(result.error || 'doc-engine job failed');
    return { jobId: data.jobId, ok: true };
  }, {
    ...getBullMQRuntimeOptions(),
    connection: workerConnection,
    concurrency: cfg.concurrency,
    lockDuration: cfg.timeoutMs,
  });
  worker.on('error', (err) => {
    console.error('[doc-engine] worker error:', err?.message || err);
  });
  return worker;
}

async function closeDocEngineWorker() {
  const closing = [];
  if (worker) closing.push(worker.close());
  if (workerConnection) closing.push(workerConnection.quit().catch(() => workerConnection.disconnect()));
  worker = null;
  workerConnection = null;
  await Promise.allSettled(closing);
}

async function closeDocEngineQueue() {
  const closing = [];
  if (queue) closing.push(queue.close());
  if (queueConnection) closing.push(queueConnection.quit().catch(() => queueConnection.disconnect()));
  queue = null;
  queueConnection = null;
  await Promise.allSettled(closing);
}

module.exports = {
  enqueueDocJob,
  getDocQueue,
  getQueueName,
  startDocEngineWorker,
  closeDocEngineWorker,
  closeDocEngineQueue,
  getJob,
  assertNoBinaryPayload,
  executeJob,
};

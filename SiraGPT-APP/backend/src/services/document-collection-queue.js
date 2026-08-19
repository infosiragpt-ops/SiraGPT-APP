'use strict';

const crypto = require('crypto');
const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const prisma = require('../config/database');
const { attachRedisListeners, reconnectDelay, isTransientRedisError } = require('./agents/redis-resilience');

let queue;
let queueConnection;
let worker;
let workerConnection;

function getQueueName() {
  return process.env.DOCUMENT_COLLECTION_QUEUE_NAME || 'siragpt-document-collections';
}

function hasRedis() {
  return Boolean(process.env.REDIS_URL);
}

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function getRuntimeOptions({ redisUrl = process.env.REDIS_URL } = {}) {
  if (isTruthyEnv(process.env.BULLMQ_SKIP_VERSION_CHECK)) return { skipVersionCheck: true };
  try {
    if (redisUrl && /(^|\.)upstash\.io$/i.test(new URL(redisUrl).hostname)) return { skipVersionCheck: true };
  } catch {
    if (/upstash\.io/i.test(String(redisUrl || ''))) return { skipVersionCheck: true };
  }
  return {};
}

function createRedisConnection({ label }) {
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required for document collection queue');
  const conn = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: reconnectDelay,
    enableOfflineQueue: true,
  });
  attachRedisListeners(conn, { label });
  return conn;
}

function getDocumentCollectionQueue() {
  if (queue) return queue;
  queueConnection = createRedisConnection({ label: 'document-collections-queue' });
  queue = new Queue(getQueueName(), {
    ...getRuntimeOptions(),
    connection: queueConnection,
    defaultJobOptions: {
      attempts: Number.parseInt(process.env.DOCUMENT_COLLECTION_JOB_ATTEMPTS || '3', 10) || 3,
      backoff: {
        type: 'exponential',
        delay: Number.parseInt(process.env.DOCUMENT_COLLECTION_JOB_BACKOFF_MS || '3000', 10) || 3000,
      },
      removeOnComplete: { age: 60 * 60 * 24, count: 1000 },
      removeOnFail: { age: 60 * 60 * 24 * 7, count: 1000 },
    },
  });
  queue.on('error', (err) => {
    if (isTransientRedisError(err)) return;
    console.error('[document-collection-queue] queue error:', err?.message || err);
  });
  return queue;
}

function jobIdFor({ collectionId, documentIds = [] }) {
  const hash = crypto
    .createHash('sha1')
    .update(documentIds.map(String).sort().join(','))
    .digest('hex')
    .slice(0, 16);
  return `${collectionId}:${hash}`;
}

async function enqueueCollectionIngest({ ownerId, collectionId, documentIds = [] }, opts = {}) {
  if (!ownerId || !collectionId) throw new Error('ownerId and collectionId are required');
  const payload = { ownerId, collectionId, documentIds: documentIds.map(String).filter(Boolean) };
  if (!hasRedis()) {
    setImmediate(() => {
      processCollectionIngestJob({ data: payload, updateProgress: async () => {} })
        .catch((err) => console.error('[document-collection-queue] inline ingest failed:', err?.message || err));
    });
    return { inline: true, id: jobIdFor(payload) };
  }
  const q = getDocumentCollectionQueue();
  return q.add('ingest-document-collection', payload, {
    jobId: opts.jobId || jobIdFor(payload),
    ...opts,
  });
}

async function processCollectionIngestJob(job) {
  const documentCollections = require('./document-collections');
  const { ownerId, collectionId, documentIds } = job.data || {};
  if (!ownerId || !collectionId) throw new Error('document collection job requires ownerId and collectionId');
  return documentCollections.ingestCollectionDocuments({
    prisma,
    ownerId,
    collectionId,
    documentIds,
    progress: (progress) => job.updateProgress(progress),
  });
}

function startDocumentCollectionWorker({ processor = processCollectionIngestJob } = {}) {
  if (worker) return worker;
  if (!hasRedis()) {
    console.warn('[document-collection-queue] REDIS_URL not set — BullMQ worker not started; producer falls back to inline ingest');
    return null;
  }
  workerConnection = createRedisConnection({ label: 'document-collections-worker' });
  worker = new Worker(getQueueName(), processor, {
    ...getRuntimeOptions(),
    connection: workerConnection,
    concurrency: Math.max(1, Number.parseInt(process.env.DOCUMENT_COLLECTION_WORKER_CONCURRENCY || '2', 10) || 2),
    lockDuration: Math.max(60_000, Number.parseInt(process.env.DOCUMENT_COLLECTION_LOCK_MS || '600000', 10) || 600_000),
    stalledInterval: 60_000,
    maxStalledCount: 2,
  });
  worker.on('failed', (job, err) => {
    console.error(`[document-collection-queue] job ${job?.id || 'unknown'} failed:`, err?.message || err);
  });
  worker.on('error', (err) => {
    if (isTransientRedisError(err)) return;
    console.error('[document-collection-queue] worker error:', err?.message || err);
  });
  return worker;
}

async function closeDocumentCollectionQueue() {
  const closing = [];
  if (queue) closing.push(queue.close());
  if (queueConnection) closing.push(queueConnection.quit().catch(() => queueConnection.disconnect()));
  queue = null;
  queueConnection = null;
  await Promise.allSettled(closing);
}

async function closeDocumentCollectionWorker() {
  const closing = [];
  if (worker) closing.push(worker.close());
  if (workerConnection) closing.push(workerConnection.quit().catch(() => workerConnection.disconnect()));
  worker = null;
  workerConnection = null;
  await Promise.allSettled(closing);
}

async function getDocumentCollectionQueueHealth() {
  if (!hasRedis()) return { queue: getQueueName(), redisUrlConfigured: false, inlineFallback: true };
  const q = getDocumentCollectionQueue();
  const counts = await q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
  return { queue: getQueueName(), redisUrlConfigured: true, counts };
}

module.exports = {
  getQueueName,
  getDocumentCollectionQueue,
  enqueueCollectionIngest,
  processCollectionIngestJob,
  startDocumentCollectionWorker,
  closeDocumentCollectionQueue,
  closeDocumentCollectionWorker,
  getDocumentCollectionQueueHealth,
  _internals: {
    getRuntimeOptions,
    jobIdFor,
  },
};

'use strict';

// CI supplies its isolated Redis service. Local runs opt in explicitly; a
// configured but broken test Redis FAILS (it is never converted into a skip).
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createMediaTranscriptionService, configureMediaQueue, jobIdFor } = require('../src/services/media-transcription-queue');
const redisUrl = process.env.MEDIA_QUEUE_TEST_REDIS_URL || (process.env.CI ? process.env.REDIS_URL : '');

test('real Redis: 50 jobs survive worker interruption, global concurrency, transient retry and explicit failed-only recovery', {
  skip: !redisUrl && 'Set MEDIA_QUEUE_TEST_REDIS_URL or use CI REDIS_URL', timeout: 45000,
}, async () => {
  const { Queue, Worker } = require('bullmq');
  const Redis = require('ioredis');
  const queueName = `media-test-${randomUUID()}`;
  const connections = [];
  const workers = [];
  const connection = () => {
    const conn = new Redis(redisUrl, { maxRetriesPerRequest: null, connectTimeout: 3000,
      retryStrategy: () => null, enableReadyCheck: false });
    conn.on('error', () => {});
    connections.push(conn);
    return conn;
  };
  const queue = new Queue(queueName, { connection: connection() });
  const errors = [];
  queue.on('error', error => errors.push(error));
  const rows = new Map(Array.from({ length: 50 }, (_, i) => [`file-${i}`, {
    id: `file-${i}`, userId: 'owner', filename: `file-${i}.mp3`, originalName: `file-${i}.mp3`,
    mimeType: 'audio/mpeg', size: 100, path: `/tmp/file-${i}.mp3`, deletedAt: null,
    processingStage: 'uploaded', extractedText: null,
  }]));
  const owns = (row, where) => row && row.userId === where.userId && !row.deletedAt;
  const prisma = { file: {
    async findFirst({ where }) { const row = rows.get(where.id); return owns(row, where) ? { ...row } : null; },
    async updateMany({ where, data }) { const row = rows.get(where.id); if (!owns(row, where)) return { count: 0 }; Object.assign(row, data); return { count: 1 }; },
  } };
  let active = 0, peak = 0, allowCorrupt = false;
  const transcribed = new Map();
  const service = createMediaTranscriptionService({ prisma, getQueue: () => queue,
    materialize: async source => ({ path: source, cleanup: async () => {} }),
    validate: async () => 'audio/mpeg', offload: async row => row.path,
    processFile: async file => {
      active++; peak = Math.max(peak, active);
      const count = (transcribed.get(file.originalname) || 0) + 1;
      transcribed.set(file.originalname, count);
      try {
        await delay(15);
        if (file.originalname === 'file-47.mp3' && count === 1) throw Object.assign(new Error('provider busy'), { status: 429 });
        if (file.originalname === 'file-49.mp3' && !allowCorrupt) return { success: false, code: 'audio_decode_failed', error: 'Archivo dañado.' };
        return { success: true, extractedText: `Transcripción completa ${file.originalname}` };
      } finally { active--; }
    },
  });
  let releaseAbandoned;
  const abandoned = new Promise(resolve => { releaseAbandoned = resolve; });
  const awaitUntil = async (predicate, label, ms = 20000) => {
    const until = Date.now() + ms;
    while (!await predicate()) {
      if (Date.now() > until) throw new Error(`Timed out: ${label}`);
      await delay(25);
    }
  };
  const createWorker = processor => {
    const worker = new Worker(queueName, processor, { connection: connection(), concurrency: 2,
      lockDuration: 1000, stalledInterval: 1000, maxStalledCount: 2 });
    worker.on('error', error => { if (!/Missing lock|Connection is closed/i.test(error.message)) errors.push(error); });
    workers.push(worker);
    return worker;
  };
  try {
    await queue.waitUntilReady();
    await configureMediaQueue(queue);
    assert.equal(await queue.getGlobalConcurrency(), 2);
    // Simulate a process dying after claiming a job, before producing text.
    const interrupted = createWorker(async () => abandoned);
    await interrupted.waitUntilReady();
    for (const fileId of rows.keys()) await service.enqueueMediaTranscription({ fileId, userId: 'owner' });
    await awaitUntil(async () => await queue.getActiveCount() > 0, 'first worker claims work');
    await interrupted.close(true);
    await service.enqueueMediaTranscription({ fileId: 'file-0', userId: 'owner' });
    assert.equal(await queue.getJobCountByTypes('active', 'waiting'), 50, 'duplicate enqueue does not add a 51st job');
    // Two replacement replicas compete; queue-wide concurrency remains two.
    createWorker(job => service.processMediaJob(job));
    createWorker(job => service.processMediaJob(job));
    await awaitUntil(async () => await queue.getCompletedCount() === 49 && await queue.getFailedCount() === 1,
      'interrupted and transient jobs recover, corrupt file fails alone');
    assert.equal(peak, 2);
    assert.equal(transcribed.get('file-47.mp3'), 2, 'transient provider failure retried');
    assert.equal(transcribed.get('file-49.mp3'), 1, 'corrupt media not automatically retried');
    assert.equal([...rows.values()].filter(row => row.processingStage === 'ready').length, 49);
    assert.equal((await service.enqueueMediaTranscription({ fileId: 'file-49', userId: 'owner' })).queued, false);
    allowCorrupt = true;
    await service.enqueueMediaTranscription({ fileId: 'file-49', userId: 'owner', retry: true });
    await awaitUntil(async () => (await queue.getJob(jobIdFor('file-49', 'owner'))).getState().then(state => state === 'completed'), 'explicit retry completes');
    assert.equal([...rows.values()].filter(row => row.processingStage === 'ready').length, 50);
    assert.equal(transcribed.get('file-49.mp3'), 2);
    assert.equal(transcribed.get('file-0.mp3'), 1, 'restarted job produced one transcript');
    assert.deepEqual(errors, []);
  } finally {
    releaseAbandoned();
    await Promise.allSettled(workers.map(worker => worker.close(true)));
    await queue.obliterate({ force: true }).catch(() => {}); // Only this UUID test queue.
    await queue.close().catch(() => {});
    connections.forEach(conn => conn.disconnect());
  }
});

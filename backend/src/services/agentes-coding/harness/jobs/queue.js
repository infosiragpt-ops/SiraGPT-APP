'use strict';

/**
 * Harness job queue (Phase 4c).
 *
 * Contract adapted from doc-sandbox/queue (enqueue + jobId idempotency +
 * attempts:1) and codex/run-queue (flag-gated worker, injectable client).
 * Not coupled to document-sandbox tables. CI uses the memory queue —
 * BullMQ is lazy-required only when a real Redis connection is supplied.
 */

const { fail } = require('../../coding-sandbox/errors');

const QUEUE_NAME = 'agentes-coding-harness';
const JOB_NAME = 'harness-run';
const ACTIONS = Object.freeze(['start', 'resume', 'cancel']);

function normalizeAction(action) {
  const raw = String(action || 'start').trim().toLowerCase();
  return ACTIONS.includes(raw) ? raw : null;
}

function jobIdFor(data) {
  const runId = String((data && data.runId) || '').trim();
  const action = normalizeAction(data && data.action) || 'start';
  if (!runId) fail('E_PARAMS', 'Falta el id de ejecución del harness.');
  if (action === 'resume') {
    const permissionId = String((data && data.permissionId) || 'none').trim();
    return `${runId}:resume:${permissionId}`;
  }
  return `${runId}:${action}`;
}

function createMemoryQueue() {
  const jobs = new Map();
  const pending = [];

  return {
    kind: 'memory',
    name: QUEUE_NAME,
    async add(name, data, opts = {}) {
      const action = normalizeAction(data && data.action);
      if (!action) fail('E_PARAMS', 'La acción de cola del harness no es válida.');
      const id = String(opts.jobId || jobIdFor(data));
      const job = {
        id,
        name: name || JOB_NAME,
        data: { ...data, action },
        state: 'waiting',
      };
      jobs.set(id, job);
      pending.push(job);
      return job;
    },
    async getJob(id) {
      return jobs.get(String(id || '')) || null;
    },
    async remove(id) {
      const key = String(id || '');
      const job = jobs.get(key);
      if (!job) return false;
      if (job.state === 'waiting' || job.state === 'delayed') {
        const idx = pending.indexOf(job);
        if (idx >= 0) pending.splice(idx, 1);
        jobs.delete(key);
        return true;
      }
      return false;
    },
    take() {
      const job = pending.shift();
      if (job) job.state = 'active';
      return job || null;
    },
    pendingCount() {
      return pending.length;
    },
    async drain(handler) {
      const results = [];
      while (pending.length) {
        const job = this.take();
        try {
          const result = await handler(job);
          job.state = 'completed';
          results.push(result);
        } catch (err) {
          job.state = 'failed';
          job.error = err && err.message ? String(err.message) : 'E_HARNESS_QUEUE';
          throw err;
        }
      }
      return results;
    },
    async close() {
      pending.length = 0;
      jobs.clear();
    },
  };
}

function bullmqDefaults() {
  return {
    attempts: 1,
    removeOnComplete: { age: 86_400, count: 2000 },
    removeOnFail: { age: 604_800, count: 2000 },
  };
}

function createBullmqQueue(connection, opts = {}) {
  if (!connection) fail('E_PARAMS', 'Falta la conexión de cola del harness.');
  const { Queue } = require('bullmq');
  const name = String(opts.name || QUEUE_NAME);
  const queue = new Queue(name, {
    connection,
    ...(opts.skipVersionCheck ? { skipVersionCheck: true } : {}),
    defaultJobOptions: bullmqDefaults(),
  });
  return {
    kind: 'bullmq',
    name,
    queue,
    async add(jobName, data, addOpts = {}) {
      const action = normalizeAction(data && data.action);
      if (!action) fail('E_PARAMS', 'La acción de cola del harness no es válida.');
      const id = String(addOpts.jobId || jobIdFor(data));
      if (queue.closing) fail('E_HARNESS_QUEUE', 'La cola del harness está cerrada.');
      const job = await queue.add(jobName || JOB_NAME, { ...data, action }, { jobId: id });
      const stored = await queue.getJob(id);
      if (!stored || !stored.data || stored.data.runId !== data.runId) {
        fail('E_HARNESS_QUEUE', 'No se confirmó la entrega del turno.');
      }
      return job;
    },
    async getJob(id) {
      return queue.getJob(String(id || '')).catch(() => null);
    },
    async remove(id) {
      const job = await this.getJob(id);
      if (!job) return false;
      const state = typeof job.getState === 'function' ? await job.getState().catch(() => null) : null;
      if (['waiting', 'delayed', 'prioritized', 'paused'].includes(state)) {
        await job.remove().catch(() => {});
        return true;
      }
      return false;
    },
    async close() {
      await queue.close();
    },
  };
}

function createHarnessQueue(opts = {}) {
  if (opts.queue && typeof opts.queue.add === 'function') return opts.queue;
  if (opts.connection) return createBullmqQueue(opts.connection, opts);
  return createMemoryQueue();
}

module.exports = {
  QUEUE_NAME,
  JOB_NAME,
  ACTIONS,
  normalizeAction,
  jobIdFor,
  bullmqDefaults,
  createMemoryQueue,
  createBullmqQueue,
  createHarnessQueue,
};

'use strict';

/**
 * Durable in-process queue for RLHF SFT/DPO prep jobs.
 *
 * Mirrors voice-studio/jobs: Prisma row + single-flight pump, no Redis
 * required. Jobs are admin-triggered and flagged
 * (`SIRAGPT_RLHF_TRAIN_JOBS`, default OFF). The worker writes a scrubbed
 * JSONL artifact; it does not start a paid fine-tune.
 */

const { isTrainJobsEnabled, isTrainSubmitEnabled } = require('./flags');
const { processTrainJob, TrainJobError } = require('./train-processor');

const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  READY: 'ready',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const ACTIVE_STATUSES = Object.freeze([JOB_STATUS.QUEUED, JOB_STATUS.RUNNING]);
const MAX_ACTIVE = 8;
const IDEMPOTENCY_MS = 60_000;

function concurrencyLimit(env = process.env) {
  const n = Number(env.SIRAGPT_RLHF_TRAIN_JOB_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.min(4, Math.floor(n)) : 1;
}

function filterDigest(spec) {
  return JSON.stringify({
    format: spec.format,
    includeRlaif: !!spec.includeRlaif,
    minPairs: spec.minPairs,
    scope: spec.scope,
    scopeUserId: spec.scopeUserId || null,
    agent: spec.agent || null,
    scrubPii: spec.scrubPii !== false,
    aggressive: !!spec.aggressive,
    submitRequested: !!spec.submitRequested,
  });
}

function stripPrivate(result) {
  if (!result || typeof result !== 'object') return result || null;
  const { __private, ...rest } = result;
  void __private;
  return rest;
}

function publicJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    stage: row.stage || null,
    progress: Number(row.progress) || 0,
    format: row.format,
    scope: row.scope,
    scopeUserId: row.scopeUserId || null,
    includeRlaif: !!row.includeRlaif,
    minPairs: Number(row.minPairs) || 1,
    scrubPii: row.scrubPii !== false,
    submitRequested: !!row.submitRequested,
    result: stripPrivate(row.result),
    error: row.error || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt || null,
  };
}

function createTrainJobQueue({
  client,
  env = process.env,
  logger = console,
  processor = processTrainJob,
} = {}) {
  if (!client || typeof client.rlhfTrainJob?.create !== 'function') {
    throw new Error('rlhf.train-jobs: prisma client with rlhfTrainJob is required');
  }

  const runners = new Map();
  const pending = [];
  const controllers = new Map();
  const drainWaiters = [];
  let active = 0;

  function notifyIdle() {
    if (pending.length === 0 && active === 0) {
      for (const resolve of drainWaiters.splice(0)) resolve();
    }
  }

  async function update(jobId, data) {
    try {
      return await client.rlhfTrainJob.update({ where: { id: jobId }, data });
    } catch (err) {
      logger.warn?.(`[rlhf.train-jobs] update failed for ${jobId}: ${err?.message || err}`);
      return null;
    }
  }

  async function pump() {
    while (active < concurrencyLimit(env) && pending.length) {
      const jobId = pending.shift();
      const runner = runners.get(jobId);
      if (!runner) continue;
      active += 1;
      runOne(jobId, runner).finally(() => {
        active -= 1;
        runners.delete(jobId);
        controllers.delete(jobId);
        notifyIdle();
        pump();
      });
    }
    notifyIdle();
  }

  async function runOne(jobId, runner) {
    const controller = controllers.get(jobId) || new AbortController();
    controllers.set(jobId, controller);
    if (controller.signal.aborted) {
      await update(jobId, {
        status: JOB_STATUS.CANCELLED,
        finishedAt: new Date(),
        stage: 'Cancelado',
      });
      return;
    }
    await update(jobId, { status: JOB_STATUS.RUNNING, stage: 'Preparando', progress: 5 });
    const ctx = {
      jobId,
      env,
      signal: controller.signal,
      async progress({ stage, progress, result } = {}) {
        const data = {};
        if (stage) data.stage = String(stage).slice(0, 120);
        if (Number.isFinite(Number(progress))) {
          data.progress = Math.max(0, Math.min(99, Math.round(Number(progress))));
        }
        if (result && typeof result === 'object') data.result = result;
        await update(jobId, data);
      },
    };
    try {
      const result = await runner(ctx);
      if (controller.signal.aborted) {
        await update(jobId, {
          status: JOB_STATUS.CANCELLED,
          finishedAt: new Date(),
          stage: 'Cancelado',
        });
        return;
      }
      await update(jobId, {
        status: JOB_STATUS.READY,
        stage: 'Listo',
        progress: 100,
        result: result && typeof result === 'object' ? result : {},
        finishedAt: new Date(),
        error: null,
      });
    } catch (err) {
      const aborted = controller.signal.aborted || err?.name === 'AbortError' || err?.code === 'E_CANCELLED';
      const message = aborted
        ? 'Cancelado'
        : String(err?.message || 'Error desconocido').slice(0, 280);
      const code = err?.code || (aborted ? 'E_CANCELLED' : 'E_TIMEOUT');
      if (!aborted) logger.warn?.(`[rlhf.train-jobs] ${jobId} failed: ${code}`);
      try {
        require('./metrics').recordTrainJob({ status: aborted ? 'cancelled' : 'failed' });
      } catch {
        /* telemetry is optional */
      }
      await update(jobId, {
        status: aborted ? JOB_STATUS.CANCELLED : JOB_STATUS.FAILED,
        stage: aborted ? 'Cancelado' : 'Fallido',
        error: `${code}: ${message}`,
        finishedAt: new Date(),
      });
    }
  }

  return {
    JOB_STATUS,
    publicJob,

    async activeCount() {
      return client.rlhfTrainJob.count({
        where: { status: { in: [...ACTIVE_STATUSES] } },
      });
    },

    async enqueue(spec) {
      if (!isTrainJobsEnabled(env)) {
        throw new TrainJobError('E_DISABLED', 'RLHF train jobs are disabled', 403);
      }
      const format = String(spec.format || '').toLowerCase();
      if (!['sft', 'dpo', 'pairs', 'rm'].includes(format)) {
        throw new TrainJobError('E_PARAMS', `unknown format '${format}' — use sft, dpo, or rm`);
      }
      const scope = spec.scope === 'user' ? 'user' : 'global';
      const scopeUserId = scope === 'user' ? (spec.scopeUserId || null) : null;
      if (scope === 'user' && !scopeUserId) {
        throw new TrainJobError('E_PARAMS', 'scope=user requires scopeUserId');
      }
      const minPairs = Math.max(1, Math.min(10_000, Number(spec.minPairs) || 1));
      const includeRlaif = spec.includeRlaif === true;
      const scrubPii = spec.scrubPii !== false;
      const submitRequested = spec.submit === true || spec.submitRequested === true;
      const createdById = spec.createdById;
      if (!createdById) throw new TrainJobError('E_PARAMS', 'createdById required');

      const digest = filterDigest({
        format,
        includeRlaif,
        minPairs,
        scope,
        scopeUserId,
        agent: spec.agent || null,
        scrubPii,
        aggressive: !!spec.aggressive,
        submitRequested,
      });

      const since = new Date(Date.now() - IDEMPOTENCY_MS);
      try {
        const recent = await client.rlhfTrainJob.findFirst({
          where: {
            createdById,
            createdAt: { gte: since },
            status: { in: [JOB_STATUS.QUEUED, JOB_STATUS.RUNNING, JOB_STATUS.READY] },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (recent && recent.filters && recent.filters.digest === digest) {
          return publicJob(recent);
        }
      } catch {
        /* idempotency lookup is best-effort */
      }

      const inFlight = await client.rlhfTrainJob.count({
        where: { status: { in: [...ACTIVE_STATUSES] } },
      });
      if (inFlight >= MAX_ACTIVE) {
        throw new TrainJobError('E_QUOTA', `too many train jobs in flight (max ${MAX_ACTIVE})`, 429);
      }

      const row = await client.rlhfTrainJob.create({
        data: {
          createdById,
          status: JOB_STATUS.QUEUED,
          stage: 'Encolado',
          progress: 0,
          format: format === 'pairs' ? 'dpo' : format,
          scope,
          scopeUserId,
          includeRlaif,
          minPairs,
          scrubPii,
          submitRequested,
          filters: {
            digest,
            agent: spec.agent || null,
            aggressive: !!spec.aggressive,
          },
        },
      });

      try {
        require('./metrics').recordTrainJob({ status: 'created', format: row.format });
      } catch {
        /* telemetry is optional */
      }

      const snapshot = publicJob(row);
      const runSpec = {
        jobId: row.id,
        format: row.format,
        includeRlaif,
        minPairs,
        scope,
        scopeUserId,
        agent: spec.agent || null,
        scrubPii,
        aggressive: !!spec.aggressive,
        submitRequested,
        env,
        exportData: spec.exportData,
        persistJsonl: spec.persistJsonl,
        trySubmit: spec.trySubmit,
        storage: spec.storage,
      };
      runners.set(row.id, (ctx) => processor(runSpec, ctx));
      controllers.set(row.id, new AbortController());
      pending.push(row.id);
      pump();
      return snapshot;
    },

    async get(jobId) {
      const row = await client.rlhfTrainJob.findFirst({ where: { id: jobId } });
      return publicJob(row);
    },

    async getRow(jobId) {
      return client.rlhfTrainJob.findFirst({ where: { id: jobId } });
    },

    async list({ limit = 20 } = {}) {
      const rows = await client.rlhfTrainJob.findMany({
        orderBy: { createdAt: 'desc' },
        take: Math.max(1, Math.min(100, Number(limit) || 20)),
      });
      return rows.map(publicJob);
    },

    async cancel(jobId) {
      const row = await client.rlhfTrainJob.findFirst({ where: { id: jobId } });
      if (!row) return null;
      if (!ACTIVE_STATUSES.includes(row.status)) return publicJob(row);
      const controller = controllers.get(jobId);
      if (controller) controller.abort(new Error('cancelled'));
      const idx = pending.indexOf(jobId);
      if (idx >= 0) {
        pending.splice(idx, 1);
        runners.delete(jobId);
        controllers.delete(jobId);
        const updated = await update(jobId, {
          status: JOB_STATUS.CANCELLED,
          stage: 'Cancelado',
          finishedAt: new Date(),
        });
        notifyIdle();
        return publicJob(updated || { ...row, status: JOB_STATUS.CANCELLED });
      }
      return publicJob({ ...row, status: JOB_STATUS.CANCELLED, stage: 'Cancelado' });
    },

    async recoverInterruptedJobs() {
      try {
        const res = await client.rlhfTrainJob.updateMany({
          where: { status: { in: [...ACTIVE_STATUSES] } },
          data: {
            status: JOB_STATUS.FAILED,
            stage: 'Fallido',
            error: 'E_TIMEOUT: process restarted during the job',
            finishedAt: new Date(),
          },
        });
        return res?.count || 0;
      } catch (err) {
        logger.warn?.(`[rlhf.train-jobs] recovery skipped: ${err?.message || err}`);
        return 0;
      }
    },

    async drain() {
      if (pending.length === 0 && active === 0) return;
      await new Promise((resolve) => drainWaiters.push(resolve));
    },

    _internals: {
      pending,
      runners,
      get active() { return active; },
    },
  };
}

let defaultQueue = null;

function getTrainJobQueue() {
  if (defaultQueue) return defaultQueue;
  let prisma;
  try {
    prisma = require('../../config/database');
  } catch {
    throw new TrainJobError('E_DISABLED', 'train job store unavailable', 503);
  }
  if (!prisma || typeof prisma.rlhfTrainJob?.create !== 'function') {
    throw new TrainJobError('E_DISABLED', 'train job store unavailable', 503);
  }
  defaultQueue = createTrainJobQueue({ client: prisma });
  return defaultQueue;
}

function __setQueueForTests(queue) {
  defaultQueue = queue;
}

module.exports = {
  JOB_STATUS,
  ACTIVE_STATUSES,
  MAX_ACTIVE,
  IDEMPOTENCY_MS,
  concurrencyLimit,
  filterDigest,
  publicJob,
  stripPrivate,
  createTrainJobQueue,
  getTrainJobQueue,
  __setQueueForTests,
  isTrainJobsEnabled,
  isTrainSubmitEnabled,
  TrainJobError,
};

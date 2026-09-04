'use strict';

/**
 * Sira Voz studio jobs — a small in-process queue for the long-running
 * VoiceStudio work (dubbing a video, rendering an audiobook) with durable
 * state in `voice_studio_jobs` so the UI can poll `/api/voice-studio/jobs/:id`
 * and a reload never loses a result.
 *
 * Concurrency is deliberately low (VOICESTUDIO_JOB_CONCURRENCY, default 1):
 * the engines run on CPU on the production host and two dubs at once would
 * only make both slower. Per-user limit: one active studio job at a time.
 *
 * Jobs that were `queued`/`running` when the process died are marked
 * `failed` on the next boot (`recoverInterruptedJobs`) — VoiceStudio keeps its
 * own job dirs, so the user simply retries.
 */

const prisma = require('../../config/database');

const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const ACTIVE_STATUSES = Object.freeze([JOB_STATUS.QUEUED, JOB_STATUS.RUNNING]);

function concurrencyLimit(env = process.env) {
  const n = Number(env.VOICESTUDIO_JOB_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function createJobQueue({ client = prisma, env = process.env, logger = console } = {}) {
  const runners = new Map();
  const pending = [];
  const controllers = new Map();
  let active = 0;

  function publicJob(row) {
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      stage: row.stage || null,
      progress: Number(row.progress) || 0,
      title: row.title || null,
      chatId: row.chatId || null,
      input: row.input && typeof row.input === 'object' ? sanitizeInput(row.input) : null,
      result: row.result && typeof row.result === 'object' ? stripPrivate(row.result) : null,
      error: row.error || null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      finishedAt: row.finishedAt || null,
    };
  }

  function stripPrivate(result) {
    const { __private, ...rest } = result;
    return rest;
  }

  function sanitizeInput(input) {
    // Never echo server paths back to the browser.
    const { sourcePath, tmpPath, ...rest } = input;
    return rest;
  }

  async function update(jobId, data) {
    try {
      return await client.voiceStudioJob.update({ where: { id: jobId }, data });
    } catch (err) {
      logger.warn?.(`[voice-studio/jobs] update failed for ${jobId}: ${err?.message || err}`);
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
        pump();
      });
    }
  }

  async function runOne(jobId, runner) {
    const controller = controllers.get(jobId) || new AbortController();
    controllers.set(jobId, controller);
    if (controller.signal.aborted) {
      await update(jobId, { status: JOB_STATUS.CANCELLED, finishedAt: new Date(), stage: 'cancelado' });
      return;
    }
    await update(jobId, { status: JOB_STATUS.RUNNING, stage: 'iniciando', progress: 1 });
    let lastWrite = 0;
    const ctx = {
      jobId,
      signal: controller.signal,
      async progress({ stage, progress, result } = {}) {
        const data = {};
        if (stage) data.stage = String(stage).slice(0, 120);
        if (Number.isFinite(Number(progress))) data.progress = Math.max(0, Math.min(99, Math.round(Number(progress))));
        if (result && typeof result === 'object') data.result = result;
        // Throttle DB writes: at most one every 1.5 s unless the stage changed.
        const now = Date.now();
        if (!stage && now - lastWrite < 1500) return;
        lastWrite = now;
        await update(jobId, data);
      },
    };
    try {
      const result = await runner(ctx);
      if (controller.signal.aborted) {
        await update(jobId, { status: JOB_STATUS.CANCELLED, finishedAt: new Date(), stage: 'cancelado' });
        return;
      }
      await update(jobId, {
        status: JOB_STATUS.DONE,
        stage: 'listo',
        progress: 100,
        result: result && typeof result === 'object' ? result : {},
        finishedAt: new Date(),
        error: null,
      });
    } catch (err) {
      const aborted = controller.signal.aborted || err?.name === 'AbortError';
      const message = aborted ? 'Cancelado por el usuario' : String(err?.message || err || 'Error desconocido').slice(0, 500);
      if (!aborted) logger.error?.(`[voice-studio/jobs] ${jobId} failed: ${message}`);
      await update(jobId, {
        status: aborted ? JOB_STATUS.CANCELLED : JOB_STATUS.FAILED,
        stage: aborted ? 'cancelado' : 'error',
        error: message,
        finishedAt: new Date(),
      });
    }
  }

  return {
    JOB_STATUS,
    publicJob,

    /** How many jobs of this user are still queued/running. */
    async activeCount(userId) {
      return client.voiceStudioJob.count({ where: { userId, status: { in: ACTIVE_STATUSES } } });
    },

    /**
     * Create the DB row and enqueue `runner(ctx)`. `runner` resolves with the
     * public `result` object (urls, filenames, summary).
     */
    async enqueue({ userId, chatId = null, kind, title = null, input = null, runner }) {
      if (typeof runner !== 'function') throw new Error('runner is required');
      const row = await client.voiceStudioJob.create({
        data: {
          userId,
          chatId: chatId || null,
          kind,
          status: JOB_STATUS.QUEUED,
          stage: 'en cola',
          progress: 0,
          title: title ? String(title).slice(0, 160) : null,
          input: input && typeof input === 'object' ? input : null,
        },
      });
      // Snapshot BEFORE the pump: the runner may already be flipping the row
      // to `running` and the caller wants the state it was created in.
      const snapshot = publicJob(row);
      runners.set(row.id, runner);
      controllers.set(row.id, new AbortController());
      pending.push(row.id);
      pump();
      return snapshot;
    },

    async get(userId, jobId) {
      const row = await client.voiceStudioJob.findFirst({ where: { id: jobId, userId } });
      return publicJob(row);
    },

    async list(userId, { limit = 20 } = {}) {
      const rows = await client.voiceStudioJob.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: Math.max(1, Math.min(100, Number(limit) || 20)),
      });
      return rows.map(publicJob);
    },

    /** Raw row (server-side use: download needs result.path). */
    async getRow(userId, jobId) {
      return client.voiceStudioJob.findFirst({ where: { id: jobId, userId } });
    },

    async cancel(userId, jobId) {
      const row = await client.voiceStudioJob.findFirst({ where: { id: jobId, userId } });
      if (!row) return null;
      if (!ACTIVE_STATUSES.includes(row.status)) return publicJob(row);
      const controller = controllers.get(jobId);
      if (controller) controller.abort(new Error('cancelled by user'));
      const idx = pending.indexOf(jobId);
      if (idx >= 0) {
        pending.splice(idx, 1);
        runners.delete(jobId);
        controllers.delete(jobId);
        const updated = await update(jobId, { status: JOB_STATUS.CANCELLED, stage: 'cancelado', finishedAt: new Date() });
        return publicJob(updated || { ...row, status: JOB_STATUS.CANCELLED });
      }
      return publicJob({ ...row, status: JOB_STATUS.CANCELLED, stage: 'cancelando' });
    },

    /** Mark rows left active by a previous process as failed. */
    async recoverInterruptedJobs() {
      try {
        const res = await client.voiceStudioJob.updateMany({
          where: { status: { in: ACTIVE_STATUSES } },
          data: { status: JOB_STATUS.FAILED, stage: 'interrumpido', error: 'El servidor se reinició durante el trabajo. Vuelve a intentarlo.', finishedAt: new Date() },
        });
        return res?.count || 0;
      } catch (err) {
        logger.warn?.(`[voice-studio/jobs] recovery skipped: ${err?.message || err}`);
        return 0;
      }
    },

    /** Test seam. */
    _internals: { pending, runners, controllers, get active() { return active; } },
  };
}

let defaultQueue = null;
function getJobQueue() {
  if (!defaultQueue) defaultQueue = createJobQueue();
  return defaultQueue;
}

module.exports = {
  JOB_STATUS,
  ACTIVE_STATUSES,
  concurrencyLimit,
  createJobQueue,
  getJobQueue,
};

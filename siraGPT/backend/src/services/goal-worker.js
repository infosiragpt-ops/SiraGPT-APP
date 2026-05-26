'use strict';

/**
 * goal-worker — BullMQ consumer for persistent `/goal` runs.
 *
 * Mirrors the boot/shutdown wiring of `services/agents/agent-task-worker.js`.
 * The processor (`processGoalJob`) loads the persisted `GoalRun` row,
 * flips status to `running`, then drives `research-agent.run` to
 * completion — persisting each emitted SSE event through
 * `goal-events.appendEvent` so the chat composer's re-attach flow
 * can replay the timeline.
 *
 * Worker tuning: research-agent can legitimately spend minutes on a
 * single page (Playwright nav + vision LLM), so the lock duration is
 * bumped to 10 min vs the 5 min default for the generic agent-task
 * worker.
 *
 * User-initiated cancellation is cooperative: the worker polls the
 * row's `status` column every ~1.5s during a run and throws a
 * sentinel error (`__goal_run_cancelled__`) inside `onEvent` when
 * the status flips to `cancelled`, so the in-flight agent loop bails
 * at the next event boundary.
 */

const { Worker } = require('bullmq');
const {
  createRedisConnection,
  getBullMQRuntimeOptions,
  getQueueName,
  requireRedisUrl,
} = require('./goal-queue');
const goalEvents = require('./goal-events');
const { installProcessGuards, isTransientRedisError } = require('./agents/redis-resilience');

// Worker tuning defaults. Research-agent + Playwright + vision can spend
// minutes on one page legitimately, so the BullMQ defaults are far too
// tight. The values below match the values used in production since the
// agent-task reliability work, adjusted upward for the higher per-step
// cost of the research loop.
const DEFAULT_LOCK_DURATION_MS = 10 * 60_000;     // 10 minutes
const DEFAULT_STALLED_INTERVAL_MS = 60_000;       // 1 minute
const DEFAULT_MAX_STALLED_COUNT = 2;

const CANCEL_SENTINEL = '__goal_run_cancelled__';
const CANCEL_POLL_MIN_MS = 1500;

let prisma = null;
function getPrisma() {
  if (prisma) return prisma;
  try { prisma = require('../config/database'); } catch { prisma = null; }
  return prisma;
}

let researchAgent = null;
function getResearchAgent() {
  if (researchAgent) return researchAgent;
  try { researchAgent = require('./research-agent'); } catch { researchAgent = null; }
  return researchAgent;
}

function readPositiveInt(rawValue, fallback) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return fallback;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

let worker;
let workerConnection;

/**
 * Process a single goal-run BullMQ job. Loads the row, flips it to
 * running, then drives research-agent.run with an onEvent that
 * persists each event + checks the cancel flag.
 */
async function processGoalJob(job) {
  const goalRunId = String(job?.data?.goalRunId || job?.id || '');
  if (!goalRunId) {
    throw new Error('goal-worker: goalRunId missing from job payload');
  }

  const db = getPrisma();
  if (!db || !db.goalRun) {
    throw new Error('goal-worker: prisma goalRun model unavailable');
  }

  const row = await db.goalRun.findUnique({ where: { id: goalRunId } });
  if (!row) {
    // The row was deleted between enqueue and pickup — drop the job.
    console.warn(`[goal-worker] row missing for goalRunId=${goalRunId}, dropping job`);
    return { skipped: true, reason: 'row_missing' };
  }
  if (row.status === 'cancelled' || row.status === 'completed' || row.status === 'failed') {
    console.warn(`[goal-worker] row already terminal status=${row.status} goalRunId=${goalRunId}`);
    return { skipped: true, reason: `already_${row.status}` };
  }

  const agent = getResearchAgent();
  if (!agent || typeof agent.run !== 'function') {
    const errMsg = 'research-agent module unavailable';
    await db.goalRun.update({
      where: { id: goalRunId },
      data: { status: 'failed', failedAt: new Date(), error: errMsg },
    });
    await goalEvents.appendEvent({ goalRunId, type: 'error', payload: { type: 'error', message: errMsg } });
    throw new Error(errMsg);
  }

  // Mark running + record jobId (idempotent).
  const startedAt = new Date();
  await db.goalRun.update({
    where: { id: goalRunId },
    data: {
      status: 'running',
      startedAt: row.startedAt || startedAt,
      jobId: row.jobId || (job?.id ? String(job.id) : null),
      updatedAt: startedAt,
    },
  });
  await goalEvents.appendEvent({
    goalRunId,
    type: 'phase',
    payload: { type: 'phase', phase: 'starting', label: 'worker_started' },
  });

  // Cancel polling state. We rate-limit polls to 1500ms so a fast
  // event stream doesn't hammer the DB; the worker can therefore lag
  // up to ~1.5s behind a user-issued cancel, which is acceptable.
  let cancelled = false;
  let lastPollAt = 0;
  async function checkCancel() {
    const now = Date.now();
    if (now - lastPollAt < CANCEL_POLL_MIN_MS) return;
    lastPollAt = now;
    try {
      const snapshot = await db.goalRun.findUnique({
        where: { id: goalRunId },
        select: { status: true },
      });
      if (snapshot && snapshot.status === 'cancelled') {
        cancelled = true;
      }
    } catch {
      // Best-effort: a transient DB blip should not abort the run.
    }
  }

  let lastReportEvent = null;
  function onEvent(evt) {
    const type = evt && evt.type ? String(evt.type) : 'event';
    if (type === 'report') {
      lastReportEvent = evt;
    }
    // Fire-and-forget persistence. Each appendEvent already swallows
    // its own errors so we never throw out of this callback for IO.
    goalEvents
      .appendEvent({ goalRunId, type, payload: evt })
      .catch(() => {});
    checkCancel().catch(() => {});
    if (cancelled) {
      const err = new Error(CANCEL_SENTINEL);
      err.code = CANCEL_SENTINEL;
      throw err;
    }
  }

  try {
    const result = await agent.run({
      query: row.prompt,
      depth: row.depth,
      onEvent,
    });

    // Extract the final report text (research-agent.run emits a
    // `{type:'report', report:{report:'…'}}` event near the end).
    const finalReportText = (() => {
      const fromEvent = lastReportEvent?.report?.report;
      if (typeof fromEvent === 'string' && fromEvent.length) return fromEvent;
      const fromResult = result?.report?.report || result?.report;
      if (typeof fromResult === 'string' && fromResult.length) return fromResult;
      return null;
    })();

    // Re-check cancel one more time before declaring success — covers
    // the race where the user cancelled mid-finalise.
    await checkCancel();
    if (cancelled) {
      const now = new Date();
      await db.goalRun.update({
        where: { id: goalRunId },
        data: {
          status: 'cancelled',
          cancelledAt: now,
          updatedAt: now,
        },
      });
      return { ok: false, cancelled: true };
    }

    const completedAt = new Date();
    await db.goalRun.update({
      where: { id: goalRunId },
      data: {
        status: 'completed',
        completedAt,
        updatedAt: completedAt,
        finalReport: finalReportText || null,
      },
    });
    return { ok: true, finalReport: Boolean(finalReportText) };
  } catch (err) {
    const isCancel = err && (err.code === CANCEL_SENTINEL || err.message === CANCEL_SENTINEL);
    const now = new Date();
    if (isCancel) {
      await db.goalRun.update({
        where: { id: goalRunId },
        data: {
          status: 'cancelled',
          cancelledAt: now,
          updatedAt: now,
        },
      });
      return { ok: false, cancelled: true };
    }

    const message = (err && err.message) ? String(err.message).slice(0, 2000) : 'goal_run_failed';
    await db.goalRun.update({
      where: { id: goalRunId },
      data: {
        status: 'failed',
        failedAt: now,
        updatedAt: now,
        error: message,
      },
    });
    await goalEvents.appendEvent({
      goalRunId,
      type: 'error',
      payload: { type: 'error', message },
    });
    throw err;
  }
}

function startGoalWorker() {
  if (worker) return worker;
  try {
    requireRedisUrl();
  } catch (err) {
    console.warn(`[goal-worker] disabled: ${err.message}`);
    return null;
  }

  // Catches unhandled rejections that BullMQ surfaces from internal
  // Redis ops (Job.updateProgress during failover, etc.).
  installProcessGuards();

  const concurrency = Math.max(1, Number.parseInt(process.env.GOAL_WORKER_CONCURRENCY || '2', 10) || 2);
  const lockDuration = readPositiveInt(process.env.GOAL_WORKER_LOCK_DURATION_MS, DEFAULT_LOCK_DURATION_MS);
  const stalledInterval = readPositiveInt(process.env.GOAL_WORKER_STALLED_INTERVAL_MS, DEFAULT_STALLED_INTERVAL_MS);
  const maxStalledCount = readPositiveInt(process.env.GOAL_WORKER_MAX_STALLED_COUNT, DEFAULT_MAX_STALLED_COUNT);

  workerConnection = createRedisConnection({ label: 'goal-worker' });
  worker = new Worker(
    getQueueName(),
    async (job) => processGoalJob(job),
    {
      ...getBullMQRuntimeOptions(),
      connection: workerConnection,
      concurrency,
      lockDuration,
      stalledInterval,
      maxStalledCount,
    }
  );

  worker.on('ready', () => {
    console.log(`[goal-worker] ready queue=${getQueueName()} concurrency=${concurrency} lockDuration=${lockDuration}ms stalledInterval=${stalledInterval}ms`);
  });

  worker.on('failed', (job, err) => {
    if (err && isTransientRedisError(err)) {
      console.warn(`[goal-worker] job ${job?.id || 'unknown'} dropped by BullMQ after completion (${err.message || err}); not retrying — row is authoritative`);
      return;
    }
    console.error(`[goal-worker] job failed ${job?.id || 'unknown'}:`, err?.message || err);
  });

  worker.on('error', (err) => {
    if (isTransientRedisError(err)) {
      // Connection layer already throttles its own logs.
      return;
    }
    console.error('[goal-worker] worker error:', err?.message || err);
  });

  return worker;
}

async function closeGoalWorker() {
  const closing = [];
  if (worker) closing.push(worker.close());
  if (workerConnection) closing.push(workerConnection.quit().catch(() => workerConnection.disconnect()));
  worker = null;
  workerConnection = null;
  await Promise.allSettled(closing);
}

module.exports = {
  closeGoalWorker,
  processGoalJob,
  startGoalWorker,
  _internal: {
    CANCEL_SENTINEL,
    CANCEL_POLL_MIN_MS,
    DEFAULT_LOCK_DURATION_MS,
    DEFAULT_STALLED_INTERVAL_MS,
    DEFAULT_MAX_STALLED_COUNT,
  },
};

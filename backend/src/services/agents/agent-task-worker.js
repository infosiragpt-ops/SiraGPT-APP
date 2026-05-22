const { Worker } = require('bullmq');
const {
  createRedisConnection,
  getBullMQRuntimeOptions,
  getQueueName,
  requireRedisUrl,
} = require('./agent-task-queue');
const { runAgentTaskJob } = require('./agent-task-runner');
const { classifyTaskError } = require('../../utils/task-error-classifier');
const { installProcessGuards, isTransientRedisError } = require('./redis-resilience');

// Worker tuning defaults. BullMQ's own defaults (30s lock, 30s stall check,
// max 1 stall) are too aggressive for our long-running agent jobs that can
// legitimately spend minutes on a single LLM call. These envelopes match the
// values used in production since the "Improve reliability of long-running
// agent tasks" change.
const DEFAULT_LOCK_DURATION_MS = 5 * 60_000;      // 5 minutes
const DEFAULT_STALLED_INTERVAL_MS = 60_000;       // 1 minute
const DEFAULT_MAX_STALLED_COUNT = 2;

/**
 * Parse an env var as a positive integer, falling back to `fallback` when the
 * value is missing, malformed, zero, or negative. Anything that survives
 * Number.parseInt and is >0 wins.
 */
function readPositiveInt(rawValue, fallback) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return fallback;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Returns a function that, when invoked repeatedly, only forwards to the
 * underlying callback once per `windowMs`. Used to keep the worker from
 * spamming the console with one log line per BullMQ retry tick while Upstash
 * is flapping — operators still get a heartbeat every minute, suppressed
 * lines are counted and reported by the caller.
 */
function createThrottledLogger(windowMs = 60_000) {
  let lastFiredAt = 0;
  return function throttled(fn) {
    const now = Date.now();
    if (now - lastFiredAt < windowMs) return;
    lastFiredAt = now;
    try { fn(); } catch { /* never throw from log throttler */ }
  };
}

let worker;
let workerConnection;

function startAgentTaskWorker() {
  if (worker) return worker;
  try {
    requireRedisUrl();
  } catch (err) {
    console.warn(`[agent-task-worker] disabled: ${err.message}`);
    return null;
  }

  // Guards against unhandled Redis rejections bubbling up from BullMQ
  // internals (e.g. Job.updateProgress during a failover) and crashing
  // the parent process. Other rejections still surface as errors.
  installProcessGuards();

  const concurrency = Math.max(1, Number.parseInt(process.env.AGENT_WORKER_CONCURRENCY || '2', 10) || 2);
  const lockDuration = readPositiveInt(process.env.AGENT_WORKER_LOCK_DURATION_MS, DEFAULT_LOCK_DURATION_MS);
  const stalledInterval = readPositiveInt(process.env.AGENT_WORKER_STALLED_INTERVAL_MS, DEFAULT_STALLED_INTERVAL_MS);
  const maxStalledCount = readPositiveInt(process.env.AGENT_WORKER_MAX_STALLED_COUNT, DEFAULT_MAX_STALLED_COUNT);
  workerConnection = createRedisConnection({ label: 'agent-task-worker' });
  worker = new Worker(
    getQueueName(),
    async (job) => runAgentTaskJob(job.data, job),
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
    console.log(`[agent-task-worker] ready queue=${getQueueName()} concurrency=${concurrency} lockDuration=${lockDuration}ms stalledInterval=${stalledInterval}ms`);
  });
  worker.on('failed', (job, err) => {
    // "Missing lock" / "could not renew lock" surface here when BullMQ
    // tries to moveToFinished on a job whose lock expired mid-run. By
    // the time we see them the runner's own audit trail
    // (agent_task_worker_finished) has already persisted the result
    // and the user got their answer — retrying would re-run a 19-min
    // job for nothing and double-charge LLM tokens. Surface once at
    // warn and bail out without rescheduling.
    if (err && isTransientRedisError(err)) {
      console.warn(`[agent-task-worker] job ${job?.id || 'unknown'} dropped by BullMQ after completion (${err.message || err}); not retrying — result already persisted by runner`);
      return;
    }
    console.error(`[agent-task-worker] job failed ${job?.id || 'unknown'}:`, err?.message || err);
    if (job && err) {
      const classification = classifyTaskError(err);
      if (classification.retryable) {
        const maxRetries = Math.max(1, Number.parseInt(process.env.AGENT_TASK_MAX_RETRIES || '3', 10) || 3);
        const attemptsMade = (job.attemptsMade || 0);
        const remaining = maxRetries - attemptsMade;
        if (remaining > 0) {
          const delayMs = Math.min(classification.ttlMs || 5_000, 60_000);
          console.warn(`[agent-task-worker] retrying job ${job.id} (attempt ${attemptsMade + 1}/${maxRetries}) in ${delayMs}ms — ${classification.reason}`);
          job.retry(delayMs).catch((retryErr) => {
            console.error(`[agent-task-worker] retry scheduling failed for ${job.id}:`, retryErr?.message || retryErr);
          });
          return;
        }
        console.warn(`[agent-task-worker] job ${job.id} exhausted ${maxRetries} retries, final failure`);
      } else {
        console.warn(`[agent-task-worker] job ${job.id} non-retryable (${classification.reason}), not retrying`);
      }
    }
  });
  // The connection itself already logs transient errors via
  // attachRedisListeners; this handler only surfaces worker-level
  // BullMQ events that aren't connection-driven. Transient lock/Redis
  // hiccups (covered by isTransientRedisError) are funneled through a
  // throttled warn so operators still get one ping per minute when
  // Upstash flaps without flooding the console on every retry tick.
  const throttledTransient = createThrottledLogger();
  let suppressedTransient = 0;
  worker.on('error', (err) => {
    if (isTransientRedisError(err)) {
      suppressedTransient += 1;
      throttledTransient(() => {
        const extra = suppressedTransient > 1 ? ` (+${suppressedTransient - 1} suppressed)` : '';
        console.warn(`[agent-task-worker] transient worker error${extra}: ${err?.message || err}`);
        suppressedTransient = 0;
      });
      return;
    }
    console.error('[agent-task-worker] worker error:', err?.message || err);
  });

  return worker;
}

async function cancelRunningTask(taskId, userId) {
  try {
    const { INTERNAL } = require('../../routes/agent-task');
    const task = INTERNAL.getTaskForUser(taskId, userId);
    if (!task || task.status !== 'running') return { cancelled: false, reason: 'not_running' };
    task.status = 'cancelled';
    task.cancelledAt = new Date().toISOString();
    task.updatedAt = task.cancelledAt;
    task.controller?.abort?.();
    return { cancelled: true, state: 'running' };
  } catch (err) {
    return { cancelled: false, reason: err.message };
  }
}

async function closeAgentTaskWorker() {
  const closing = [];
  if (worker) closing.push(worker.close());
  if (workerConnection) closing.push(workerConnection.quit().catch(() => workerConnection.disconnect()));
  worker = null;
  workerConnection = null;
  await Promise.allSettled(closing);
}

module.exports = {
  cancelRunningTask,
  closeAgentTaskWorker,
  startAgentTaskWorker,
};

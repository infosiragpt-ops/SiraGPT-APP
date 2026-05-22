const { Worker } = require('bullmq');
const {
  createRedisConnection,
  getBullMQRuntimeOptions,
  getQueueName,
  requireRedisUrl,
} = require('./agent-task-queue');
const { runAgentTaskJob, classifyTaskError } = require('./agent-task-runner');
const {
  createThrottledLogger,
  installProcessGuards,
  isTransientRedisError,
} = require('./redis-resilience');

// BullMQ defaults: lockDuration 30s, lockRenewTime ~15s. Agent tasks
// here orchestrate LLM streams that routinely run 60-180s and can spike
// past 5 min during slow upstream providers (Together, Fireworks). The
// 30s default guarantees a "could not renew lock" race whenever a renew
// tick collides with an Upstash failover or a long LLM blocking call,
// which is exactly the spam we were seeing in production. 5 min gives
// the renew loop generous headroom; if a worker actually dies the job
// is still moved to failed via maxStalledCount on the next stalled
// check (configurable via STALLED_INTERVAL_MS).
const DEFAULT_LOCK_DURATION_MS = 5 * 60 * 1000;
const DEFAULT_STALLED_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_STALLED_COUNT = 1;

function readPositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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

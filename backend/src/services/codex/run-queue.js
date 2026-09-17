'use strict';

/**
 * codex/run-queue — BullMQ queue + worker for Codex V2 runs (spec §3, §7,
 * feature 05). Each run is a job on the `codex-runs` queue; the worker drives
 * the configured AgentAdapter and persists the lifecycle to `codex_runs` +
 * `codex_events`. Mirrors the queue/worker/recovery shape of goal-queue.js.
 *
 * The worker is registered ONLY when the flag is on (see startCodexWorker).
 * Redis connection + resilience are shared with the rest of the backend.
 */

const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const { attachRedisListeners, reconnectDelay, isTransientRedisError } = require('../agents/redis-resilience');
const { isCodexV2Enabled } = require('./flags');
const {
  IMPLEMENTER_ADAPTER_ENV,
  assertImplementerAdapterConfigured,
} = require('./agent-adapters/registry');

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

/**
 * Enqueue a persisted run. Default jobId === runId (idempotent). Boot-recovery
 * passes an explicit `jobId` to sidestep BullMQ's silent no-op when a dead job
 * record with the same id lingers in Redis — accepted in the first argument
 * (the documented call shape) or in opts, so a contract drift between the two
 * can never silently discard it again.
 */
function normaliseResumeSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sessionId = String(value.sessionId || '').trim();
  const cursorSeq = Number(value.cursorSeq);
  const checkpointSha = value.checkpointSha == null ? null : String(value.checkpointSha).trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(sessionId)
    || !Number.isSafeInteger(cursorSeq)
    || cursorSeq < 0
    || (checkpointSha && !/^[0-9a-f]{7,64}$/i.test(checkpointSha))
  ) {
    return null;
  }
  return { sessionId, cursorSeq, checkpointSha };
}

async function enqueueCodexRun({ runId, jobId, resumeSnapshot } = {}, opts = {}) {
  if (!runId) throw new Error('runId is required');
  const q = getCodexQueue();
  const resume = normaliseResumeSnapshot(resumeSnapshot);
  return q.add(
    'codex-run',
    { runId, ...(resume ? { resumeSnapshot: resume } : {}) },
    { jobId: jobId || opts.jobId || String(runId), priority: opts.priority },
  );
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
let autoscalerTimer;
let autoscalerState;

function parsePositiveIntEnv(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/**
 * Autoscaler config. Floor = the operator's CODEX_WORKER_CONCURRENCY (the
 * steady-state capacity that was safe enough to configure); ceiling defaults
 * to 8 so a queue burst can use the runner's dev-port pool (5173-5182, 10
 * slots) and stay inside the shared runner's 2g memory budget without
 * starving the single-VPS host. Disabled when ceiling <= floor.
 */
function getAutoscalerConfig(env = process.env) {
  const floor = Math.max(1, Number.parseInt(env.CODEX_WORKER_CONCURRENCY || '2', 10) || 2);
  const max = parsePositiveIntEnv(env.CODEX_WORKER_MAX_CONCURRENCY, 8);
  const ceiling = Math.max(floor, max);
  return {
    enabled: ceiling > floor,
    floor,
    ceiling,
    scaleUpThreshold: parsePositiveIntEnv(env.CODEX_AUTOSCALE_QUEUE_DEPTH, 3),
    scaleUpStep: parsePositiveIntEnv(env.CODEX_AUTOSCALE_STEP, 2),
    scaleDownAfterMs: Math.max(0, Number.parseInt(env.CODEX_AUTOSCALE_SCALE_DOWN_MS || '120000', 10) || 120000),
    intervalMs: Math.max(5_000, Number.parseInt(env.CODEX_AUTOSCALE_INTERVAL_MS || '15000', 10) || 15000),
  };
}

function clampConcurrency(value, config) {
  return Math.min(Math.max(1, Math.trunc(value)), config.ceiling);
}

/**
 * Pure transition for the autoscaler: given queue depth, the worker's current
 * concurrency and the last time it grew, return the next target concurrency
 * and whether "busy" was observed (used for the scale-down timer). Scale-up is
 * immediate when waiting jobs exceed the threshold; scale-down returns to the
 * floor only after a quiet period, so a bursty queue does not oscillate.
 */
function nextAutoscalerTarget({ depth, current, busySinceMs, now, config }) {
  if (depth > config.scaleUpThreshold) {
    const target = clampConcurrency(current + config.scaleUpStep, config);
    return { target, changed: target > current, busySinceMs: now, grewNow: target > current };
  }
  const quietForMs = busySinceMs == null ? Infinity : now - busySinceMs;
  if (current > config.floor && quietForMs >= config.scaleDownAfterMs) {
    return { target: config.floor, changed: true, busySinceMs: null, grewNow: false };
  }
  return { target: current, changed: false, busySinceMs, grewNow: false };
}

function startCodexAutoscaler({ env = process.env, log = console } = {}) {
  if (!worker || autoscalerTimer) return null;
  const config = getAutoscalerConfig(env);
  if (!config.enabled) return null;
  autoscalerState = { busySinceMs: null, current: worker.concurrency };
  const tick = async () => {
    if (!worker) return;
    try {
      const depth = await getCodexQueue().getWaitingCount();
      const now = Date.now();
      const next = nextAutoscalerTarget({
        depth,
        current: autoscalerState.current,
        busySinceMs: autoscalerState.busySinceMs,
        now,
        config,
      });
      autoscalerState.busySinceMs = next.busySinceMs;
      if (next.changed) {
        worker.concurrency = next.target;
        autoscalerState.current = next.target;
        log.info?.(`[codex-runs] autoscaler concurrency ${next.target} (waiting=${depth})`);
      }
    } catch (err) {
      if (!isTransientRedisError(err)) {
        log.warn?.(`[codex-runs] autoscaler tick failed: ${err?.message || err}`);
      }
    }
  };
  autoscalerTimer = setInterval(tick, config.intervalMs);
  autoscalerTimer.unref?.();
  return { config };
}

function stopCodexAutoscaler() {
  if (autoscalerTimer) clearInterval(autoscalerTimer);
  autoscalerTimer = null;
  autoscalerState = null;
}

/**
 * Build the default BullMQ handler with the adapter id that passed boot
 * validation pinned into every job. Production still snapshots process.env at
 * job time so dynamically applied provider keys remain visible; injected envs
 * are captured once for deterministic tests/embedders.
 */
function createDefaultCodexJobHandler({ env = process.env, processRun } = {}) {
  const adapter = assertImplementerAdapterConfigured(env);
  const capturedEnv = env === process.env ? null : Object.freeze({ ...env });
  const runJob = processRun || ((args) => require('./run-processor').processCodexRunJob(args));
  return (job) => {
    const sourceEnv = capturedEnv || process.env;
    const jobEnv = Object.freeze({ ...sourceEnv, [IMPLEMENTER_ADAPTER_ENV]: adapter.id });
    return runJob({
      runId: job.data?.runId,
      resumeSnapshot: normaliseResumeSnapshot(job.data?.resumeSnapshot),
      env: jobEnv,
    });
  };
}

/**
 * Start the codex worker. No-op (returns null) when the flag is off — the
 * worker simply does not exist, so enqueued jobs never run. `processor` is
 * injectable for tests; defaults to the run-processor.
 */
function startCodexWorker({ env = process.env, processor } = {}) {
  if (worker) return worker;
  if (!isCodexV2Enabled(env)) return null;
  // Unknown adapter ids must never fall back to native implicitly. Resolve the
  // configured implementation before touching Redis/starting a worker so a
  // typo fails closed during backend boot.
  assertImplementerAdapterConfigured(env);
  if (!process.env.REDIS_URL) {
    console.warn('[codex-runs] REDIS_URL not set — worker not started');
    return null;
  }
  const concurrency = Math.max(1, Number.parseInt(env.CODEX_WORKER_CONCURRENCY || '2', 10) || 2);
  const handler = processor || createDefaultCodexJobHandler({ env });

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
  startCodexAutoscaler({ env });
  return worker;
}

/** Look up a job by runId (jobId === runId). Returns the job or null. */
async function peekCodexJob(runId) {
  if (!runId) return null;
  return getCodexQueue().getJob(String(runId)).catch(() => null);
}

const LIVE_JOB_STATES = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);

/**
 * A job counts as LIVE only while it can still run. A completed/failed record
 * lingering in Redis (removeOnComplete/Fail retention) is NOT live — treating
 * it as such made boot-recovery skip re-enqueues and resumed runs sat 'queued'
 * forever (BullMQ also silently ignores q.add with an existing jobId).
 */
async function peekLiveCodexJob(runId) {
  const job = await peekCodexJob(runId);
  if (!job) return null;
  try {
    const state = typeof job.getState === 'function' ? await job.getState() : null;
    return state && LIVE_JOB_STATES.has(state) ? job : null;
  } catch {
    return job; // state unavailable → be conservative, treat as live
  }
}

async function getCodexQueueHealth() {
  const q = getCodexQueue();
  const counts = await q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
  return { queue: QUEUE_NAME, redisUrlConfigured: Boolean(process.env.REDIS_URL), counts };
}

async function closeCodexWorker() {
  stopCodexAutoscaler();
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

/**
 * Test hook: inject a fake Queue so contract tests exercise the REAL enqueue
 * body without Redis (the boot-recovery jobId regression slipped past tests
 * that faked this whole module). Pass null to restore lazy creation.
 */
function __setQueueForTests(q) { queue = q; }

module.exports = {
  getQueueName,
  requireRedisUrl,
  createRedisConnection,
  getRuntimeOptions,
  getCodexQueue,
  enqueueCodexRun,
  cancelQueuedCodexRun,
  peekCodexJob,
  peekLiveCodexJob,
  createDefaultCodexJobHandler,
  startCodexWorker,
  startCodexAutoscaler,
  stopCodexAutoscaler,
  getAutoscalerConfig,
  nextAutoscalerTarget,
  getCodexQueueHealth,
  closeCodexWorker,
  closeCodexQueue,
  normaliseResumeSnapshot,
  __setQueueForTests,
};

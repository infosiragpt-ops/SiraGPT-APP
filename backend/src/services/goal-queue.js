'use strict';

/**
 * goal-queue — BullMQ producer for persistent `/goal` runs.
 *
 * Mirrors the shape of `services/agents/agent-task-queue.js`. A separate
 * queue (`siragpt-goal-runs`) isolates `/goal` throughput from the
 * generic agent-task pipeline so a flood of slash commands cannot
 * starve durable tool-calling work and vice-versa.
 *
 * The HTTP route (`routes/goals.js`) persists a `GoalRun` row first,
 * then calls `enqueueGoalRun({ goalRunId })`. The worker
 * (`services/goal-worker.js`) loads the row, runs `research-agent.run`,
 * and writes each SSE event into `goal_run_events` so the chat
 * composer can re-attach after a reload.
 */

const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const { attachRedisListeners, isTransientRedisError, reconnectDelay } = require('./agents/redis-resilience');

let queue;
let queueConnection;

function getQueueName() {
  return process.env.GOAL_QUEUE_NAME || 'siragpt-goal-runs';
}

function requireRedisUrl() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL is required for durable goal runs');
  }
  return redisUrl;
}

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function shouldSkipBullMQVersionCheck({ redisUrl = process.env.REDIS_URL, env = process.env } = {}) {
  if (isTruthyEnv(env.BULLMQ_SKIP_VERSION_CHECK)) return true;
  if (!redisUrl) return false;

  // Upstash serverless plans report `optimistic-volatile` eviction; BullMQ's
  // generic warning recommends `noeviction` but we can't change a managed
  // policy. Skipping the startup INFO check silences a recurring production
  // warning without hiding actual Redis errors (still flow through
  // attachRedisListeners). See agent-task-queue.js for the original.
  try {
    const { hostname } = new URL(redisUrl);
    return /(^|\.)upstash\.io$/i.test(hostname);
  } catch (_) {
    return /upstash\.io/i.test(String(redisUrl));
  }
}

function getBullMQRuntimeOptions({ redisUrl = process.env.REDIS_URL, env = process.env } = {}) {
  return shouldSkipBullMQVersionCheck({ redisUrl, env }) ? { skipVersionCheck: true } : {};
}

function createRedisConnection({ label = 'goal-queue' } = {}) {
  const redisUrl = requireRedisUrl();
  const conn = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: reconnectDelay,
    enableOfflineQueue: true,
  });
  attachRedisListeners(conn, { label });
  return conn;
}

function getGoalQueue() {
  if (queue) return queue;
  queueConnection = createRedisConnection({ label: 'goal-queue' });
  queue = new Queue(getQueueName(), {
    ...getBullMQRuntimeOptions(),
    connection: queueConnection,
    defaultJobOptions: {
      // Goal runs do their own retry through GoalRun.status — keep the
      // BullMQ attempt count at 1 and let the persistence layer decide.
      attempts: 1,
      removeOnComplete: { age: 60 * 60 * 24, count: 500 },
      removeOnFail: { age: 60 * 60 * 24 * 7, count: 1000 },
    },
  });
  // Consume Queue-level 'error' events so a Redis blip cannot surface as an
  // unhandled EventEmitter 'error' (Node turns those into a full-stack-trace
  // unhandledRejection). The connection already logs transient errors via
  // attachRedisListeners; this only forwards genuine queue errors.
  queue.on('error', (err) => {
    if (isTransientRedisError(err)) return;
    console.error('[goal-queue] queue error:', err?.message || err);
  });
  return queue;
}

/**
 * Enqueue a persisted goal run for the worker to process.
 *
 * Idempotent on `goalRunId`: re-enqueuing the same id returns the
 * existing BullMQ job instead of creating a duplicate. The HTTP
 * route must persist the `GoalRun` row first; if this throws, the
 * row is left in `queued` status and a future sweep can re-enqueue.
 *
 * @param {{ goalRunId: string }} payload
 * @param {object} [opts]
 */
async function enqueueGoalRun(payload, opts = {}) {
  if (!payload?.goalRunId) throw new Error('goalRunId is required');
  const q = getGoalQueue();
  return q.add('goal-run', payload, {
    jobId: opts.jobId || String(payload.goalRunId),
    priority: opts.priority,
  });
}

/**
 * Cancel a queued (not-yet-running) goal job. Running jobs are
 * cancelled cooperatively by flipping the row's status to
 * `cancelled` — see `goal-events.markCancelRequested`.
 */
async function cancelQueuedGoalRun(goalRunId) {
  if (!goalRunId) return { cancelled: false };
  const q = getGoalQueue();
  const job = await q.getJob(String(goalRunId));
  if (!job) return { cancelled: false, reason: 'not_found' };
  const state = await job.getState();
  if (['waiting', 'delayed', 'prioritized', 'paused'].includes(state)) {
    await job.remove();
    return { cancelled: true, state };
  }
  return { cancelled: false, state };
}

async function getGoalQueueHealth() {
  const q = getGoalQueue();
  const counts = await q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
  return {
    queue: getQueueName(),
    redisUrlConfigured: Boolean(process.env.REDIS_URL),
    counts,
  };
}

async function closeGoalQueue() {
  const closing = [];
  if (queue) closing.push(queue.close());
  if (queueConnection) closing.push(queueConnection.quit().catch(() => queueConnection.disconnect()));
  queue = null;
  queueConnection = null;
  await Promise.allSettled(closing);
}

module.exports = {
  cancelQueuedGoalRun,
  closeGoalQueue,
  createRedisConnection,
  enqueueGoalRun,
  getBullMQRuntimeOptions,
  getGoalQueue,
  getGoalQueueHealth,
  getQueueName,
  requireRedisUrl,
  shouldSkipBullMQVersionCheck,
};

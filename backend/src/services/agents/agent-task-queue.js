const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const { attachRedisListeners, isTransientRedisError, markRedisFailure, reconnectDelay } = require('./redis-resilience');

let queue;
let queueConnection;

function getQueueName() {
  return process.env.AGENT_QUEUE_NAME || 'siragpt-agent-tasks';
}

function requireRedisUrl() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL is required for durable agentic tasks');
  }
  return redisUrl;
}

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function shouldSkipBullMQVersionCheck({ redisUrl = process.env.REDIS_URL, env = process.env } = {}) {
  if (isTruthyEnv(env.BULLMQ_SKIP_VERSION_CHECK)) return true;
  if (!redisUrl) return false;

  // Upstash serverless plans can report managed maxmemory policies such as
  // `optimistic-volatile`. BullMQ's generic Redis warning recommends
  // `noeviction`, but this deployment keeps bounded jobs via removeOn* counts
  // and cannot change the provider policy. Skipping BullMQ's startup INFO check
  // prevents noisy recurring production warnings without hiding Redis runtime
  // errors, which still flow through attachRedisListeners().
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

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getQueueCommandTimeoutMs(env = process.env) {
  return readPositiveInt(env.AGENT_TASK_QUEUE_COMMAND_TIMEOUT_MS, 10_000);
}

function getQueueEnqueueTimeoutMs(env = process.env) {
  return readPositiveInt(env.AGENT_TASK_QUEUE_ENQUEUE_TIMEOUT_MS, 5_000);
}

function makeEnqueueTimeoutError(timeoutMs, taskId) {
  const err = new Error(`agent task enqueue timed out after ${timeoutMs}ms${taskId ? ` for task ${taskId}` : ''}`);
  err.code = 'agent_task_enqueue_timeout';
  err.taskId = taskId;
  return err;
}

function withEnqueueTimeout(promise, timeoutMs, taskId) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = makeEnqueueTimeoutError(timeoutMs, taskId);
      markRedisFailure(err);
      Promise.resolve(closeAgentTaskQueue({ force: true }))
        .catch(() => null)
        .finally(() => reject(err));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function createRedisConnection({
  label = 'redis',
  maxRetriesPerRequest = null,
  enableOfflineQueue = true,
  connectTimeout,
  commandTimeout,
} = {}) {
  const redisUrl = requireRedisUrl();
  const conn = new IORedis(redisUrl, {
    maxRetriesPerRequest,
    enableReadyCheck: false,
    retryStrategy: reconnectDelay,
    // Worker connections can keep commands queued during a reconnect window,
    // but request-path producers must fail fast. `getAgentTaskQueue()` passes
    // enableOfflineQueue:false so POST /api/agent/task can fall back to the
    // local runtime instead of leaving the browser idle until its 90s watchdog.
    enableOfflineQueue,
    ...(connectTimeout ? { connectTimeout } : {}),
    ...(commandTimeout ? { commandTimeout } : {}),
  });
  attachRedisListeners(conn, { label });
  return conn;
}

function getAgentTaskQueue() {
  if (queue) return queue;
  const producerTimeoutMs = getQueueCommandTimeoutMs();
  queueConnection = createRedisConnection({
    label: 'agent-task-queue',
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: producerTimeoutMs,
    commandTimeout: producerTimeoutMs,
  });
  queue = new Queue(getQueueName(), {
    ...getBullMQRuntimeOptions(),
    connection: queueConnection,
    defaultJobOptions: {
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
    console.error('[agent-task-queue] queue error:', err?.message || err);
  });
  return queue;
}

async function enqueueAgentTask(payload, opts = {}) {
  if (!payload?.taskId) throw new Error('taskId is required');

  // Per-task-type Temporal opt-in. When `USE_TEMPORAL_FOR_<TYPE>=1` is
  // set AND `TEMPORAL_ADDRESS` is configured, dispatch to a Temporal
  // workflow instead of BullMQ. Any failure here silently falls back
  // to BullMQ so a misbehaving Temporal Cloud namespace can never
  // strand a user's task. See `infra/temporal/README.md`.
  // Existing producers (routes/agent-task.js, workspace orchestrator)
  // don't yet attach a `taskType` discriminator — the worker just runs
  // `runAgentTaskJob` on whatever payload. Default to a stable bucket
  // ('agent_task') so the rollout flags are actually usable today
  // (USE_TEMPORAL_FOR_AGENT_TASK=1 or USE_TEMPORAL_FOR_ALL=1). Once the
  // first migrated route starts tagging payloads with a finer-grained
  // type (e.g. 'research', 'deep_research'), this default will just be
  // the catch-all for the rest.
  const resolvedTaskType = String(payload.taskType || 'agent_task');
  try {
    // eslint-disable-next-line global-require
    const { shouldUseTemporalForTaskType, startAgentTaskWorkflow } = require('./temporal/temporal-client');
    if (shouldUseTemporalForTaskType(resolvedTaskType)) {
      const handle = await startAgentTaskWorkflow({
        taskType: resolvedTaskType,
        jobData: { ...payload, taskType: resolvedTaskType },
        idempotencyKey: payload.taskId,
      });
      if (handle) {
        console.log(`[agent-task-queue] dispatched via temporal taskId=${payload.taskId} taskType=${resolvedTaskType} workflowId=${handle.workflowId} runId=${handle.runId}`);
        return { id: handle.workflowId, _temporal: true };
      }
    }
  } catch (err) {
    console.warn(`[agent-task-queue] temporal dispatch failed taskId=${payload.taskId}, falling back to bullmq: ${err && err.message || err}`);
  }

  const q = getAgentTaskQueue();
  const addPromise = q.add('agent-task', payload, {
    jobId: opts.jobId || payload.taskId,
    priority: opts.priority,
  });
  return withEnqueueTimeout(addPromise, readPositiveInt(opts.timeoutMs, getQueueEnqueueTimeoutMs()), payload.taskId);
}

async function cancelQueuedTask(taskId) {
  if (!taskId) return { cancelled: false };
  const q = getAgentTaskQueue();
  const job = await q.getJob(String(taskId));
  if (!job) return { cancelled: false, reason: 'not_found' };
  const state = await job.getState();
  if (['waiting', 'delayed', 'prioritized', 'paused'].includes(state)) {
    await job.remove();
    return { cancelled: true, state };
  }
  return { cancelled: false, state };
}

async function getQueueHealth() {
  const q = getAgentTaskQueue();
  const counts = await q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
  return {
    queue: getQueueName(),
    redisUrlConfigured: Boolean(process.env.REDIS_URL),
    counts,
  };
}

async function closeAgentTaskQueue({ force = false } = {}) {
  const activeQueue = queue;
  const activeConnection = queueConnection;
  queue = null;
  queueConnection = null;

  if (force) {
    if (activeQueue && typeof activeQueue.disconnect === 'function') {
      try { activeQueue.disconnect(); } catch (_) { /* ignore */ }
    }
    if (activeConnection && typeof activeConnection.disconnect === 'function') {
      try { activeConnection.disconnect(); } catch (_) { /* ignore */ }
    }
    return;
  }

  const closing = [];
  if (activeQueue) closing.push(activeQueue.close());
  if (activeConnection) {
    closing.push(activeConnection.quit().catch(() => activeConnection.disconnect()));
  }
  await Promise.allSettled(closing);
}

module.exports = {
  cancelQueuedTask,
  closeAgentTaskQueue,
  createRedisConnection,
  enqueueAgentTask,
  getAgentTaskQueue,
  getBullMQRuntimeOptions,
  getQueueHealth,
  getQueueName,
  requireRedisUrl,
  shouldSkipBullMQVersionCheck,
};

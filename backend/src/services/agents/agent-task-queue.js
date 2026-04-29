const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const { attachRedisListeners, reconnectDelay } = require('./redis-resilience');

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

function createRedisConnection({ label = 'redis' } = {}) {
  const redisUrl = requireRedisUrl();
  const conn = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: reconnectDelay,
    // Keep BullMQ commands queued during a reconnect window instead of
    // failing them — pairs with maxRetriesPerRequest:null.
    enableOfflineQueue: true,
  });
  attachRedisListeners(conn, { label });
  return conn;
}

function getAgentTaskQueue() {
  if (queue) return queue;
  queueConnection = createRedisConnection({ label: 'agent-task-queue' });
  queue = new Queue(getQueueName(), {
    connection: queueConnection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 60 * 60 * 24, count: 500 },
      removeOnFail: { age: 60 * 60 * 24 * 7, count: 1000 },
    },
  });
  return queue;
}

async function enqueueAgentTask(payload, opts = {}) {
  if (!payload?.taskId) throw new Error('taskId is required');
  const q = getAgentTaskQueue();
  return q.add('agent-task', payload, {
    jobId: opts.jobId || payload.taskId,
    priority: opts.priority,
  });
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

async function closeAgentTaskQueue() {
  const closing = [];
  if (queue) closing.push(queue.close());
  if (queueConnection) closing.push(queueConnection.quit().catch(() => queueConnection.disconnect()));
  queue = null;
  queueConnection = null;
  await Promise.allSettled(closing);
}

module.exports = {
  cancelQueuedTask,
  closeAgentTaskQueue,
  createRedisConnection,
  enqueueAgentTask,
  getAgentTaskQueue,
  getQueueHealth,
  getQueueName,
  requireRedisUrl,
};

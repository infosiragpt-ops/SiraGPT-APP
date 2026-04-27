const { Worker } = require('bullmq');
const {
  createRedisConnection,
  getQueueName,
  requireRedisUrl,
} = require('./agent-task-queue');
const { runAgentTaskJob } = require('./agent-task-runner');

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

  const concurrency = Math.max(1, Number.parseInt(process.env.AGENT_WORKER_CONCURRENCY || '2', 10) || 2);
  workerConnection = createRedisConnection();
  worker = new Worker(
    getQueueName(),
    async (job) => runAgentTaskJob(job.data, job),
    {
      connection: workerConnection,
      concurrency,
    }
  );

  worker.on('ready', () => {
    console.log(`[agent-task-worker] ready queue=${getQueueName()} concurrency=${concurrency}`);
  });
  worker.on('failed', (job, err) => {
    console.error(`[agent-task-worker] job failed ${job?.id || 'unknown'}:`, err?.message || err);
  });
  worker.on('error', (err) => {
    console.error('[agent-task-worker] redis/worker error:', err?.message || err);
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

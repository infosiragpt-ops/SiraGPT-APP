'use strict';

/**
 * BullMQ wrapper so AgentRunner tasks can run in the background and stream
 * steps over Redis pub/sub (SSE on the chat side).
 *
 * Default chat path still runs in-process with live SSE. Set
 * AGENT_RUNNER_ASYNC=1 to enqueue instead (long tasks, no blocked request).
 */

const QUEUE_NAME = process.env.AGENT_RUNNER_QUEUE_NAME || 'siragpt-agent-runner';
const CHANNEL_PREFIX = 'agent-runner:events:';

function isLikelyTestProcess(env = process.env) {
  if (env.SIRAGPT_AGENT_RUNNER_IN_TESTS === '1') return false;
  if (env.NODE_ENV === 'test') return true;
  if (typeof env.NODE_TEST_CONTEXT !== 'undefined') return true;
  return false;
}

function isAsyncEnabled(env = process.env) {
  const raw = String(env.AGENT_RUNNER_ASYNC || '').trim();
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  // Default OFF so chat SSE stays in-process. Redis being present used to
  // enqueue a BullMQ job; if the worker was down, the chat fell through to
  // the dark document pipeline. Set AGENT_RUNNER_ASYNC=1 for long jobs.
  return false;
}

function eventChannel(jobId) {
  return `${CHANNEL_PREFIX}${jobId}`;
}

async function enqueueAgentRunnerJob(data, { QueueImpl, connection, queueName = QUEUE_NAME } = {}) {
  if (!QueueImpl) {
    const { Queue } = require('bullmq');
    QueueImpl = Queue;
  }
  const queue = new QueueImpl(queueName, { connection, skipVersionCheck: true });
  const job = await queue.add('run', {
    instruction: data.instruction,
    userId: data.userId || null,
    chatId: data.chatId || null,
    fileIds: data.fileIds || [],
    model: data.model || null,
  }, {
    attempts: 1,
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
  });
  return { jobId: String(job.id), queue: queueName };
}

function startAgentRunnerWorker({
  WorkerImpl,
  connection,
  queueName = QUEUE_NAME,
  run = null,
  publish = null,
} = {}) {
  if (!WorkerImpl) {
    const { Worker } = require('bullmq');
    WorkerImpl = Worker;
  }
  const runner = run || require('./index').runAgentRunnerForChat;
  const worker = new WorkerImpl(queueName, async (job) => {
    const jobId = String(job.id);
    const emit = async (ev) => {
      if (typeof publish === 'function') {
        await publish(eventChannel(jobId), ev);
        return;
      }
      if (connection && typeof connection.publish === 'function') {
        await connection.publish(eventChannel(jobId), JSON.stringify(ev));
      }
    };
    await emit({ type: 'stage', label: 'Agente trabajando', tool: 'agent_runner' });
    let prisma = null;
    try { prisma = require('../../config/database'); } catch (_) { prisma = null; }
    try {
      const result = await runner({
        prisma,
        ...job.data,
        onEvent: (ev) => { emit(ev).catch(() => {}); },
      });
      await emit({ type: 'final', label: 'Listo', summary: result.summary, artifacts: result.artifacts });
      await emit({ type: 'job_done', result, label: 'Listo' });
      return result;
    } catch (err) {
      await emit({ type: 'job_error', message: err?.message || String(err), label: 'Error' });
      throw err;
    }
  }, {
    connection,
    concurrency: Math.max(1, Number(process.env.AGENT_RUNNER_CONCURRENCY) || 2),
    skipVersionCheck: true,
  });
  return worker;
}

/**
 * Subscribe to Redis pub/sub for one job and resolve with the worker result.
 */
async function waitForAgentRunnerJob({
  jobId,
  connection,
  onEvent = () => {},
  signal,
  timeoutMs = 10 * 60 * 1000,
} = {}) {
  if (!connection || typeof connection.duplicate !== 'function') {
    throw new Error('waitForAgentRunnerJob: redis connection is required');
  }
  const channel = eventChannel(jobId);
  const sub = connection.duplicate();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error('agent_runner_job_timeout')), timeoutMs);
    const onAbort = () => finish(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    function finish(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { signal?.removeEventListener?.('abort', onAbort); } catch (_) { /* ignore */ }
      try { sub.disconnect(); } catch (_) { /* ignore */ }
      if (err) reject(err);
      else resolve(result);
    }
    if (signal?.aborted) {
      finish(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    sub.subscribe(channel, (err) => {
      if (err) finish(err);
    });
    sub.on('message', (_ch, raw) => {
      let ev;
      try { ev = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
      try { onEvent(ev); } catch (_) { /* UI must never fail the wait */ }
      if (ev && ev.type === 'job_done') finish(null, ev.result);
      if (ev && ev.type === 'job_error') finish(new Error(ev.message || 'agent_runner_job_failed'));
    });
  });
}

module.exports = {
  QUEUE_NAME,
  CHANNEL_PREFIX,
  isAsyncEnabled,
  isLikelyTestProcess,
  eventChannel,
  enqueueAgentRunnerJob,
  startAgentRunnerWorker,
  waitForAgentRunnerJob,
};

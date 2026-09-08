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
const CANCEL_CHANNEL_PREFIX = 'agent-runner:cancel:';

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

function cancelChannel(jobId) {
  return `${CANCEL_CHANNEL_PREFIX}${jobId}`;
}

/**
 * F3 — cancel a running AgentRunner BullMQ job from any process.
 *
 * Publishes on the job's cancel channel; the worker holds a per-job
 * AbortController and aborts the in-flight loop + sandbox when the message
 * arrives. Best-effort by contract (a dead Redis just means the job runs to
 * its own timeout); never throws.
 */
async function requestAgentRunnerJobCancel({ jobId, connection, publish } = {}) {
  if (!jobId) return false;
  const payload = JSON.stringify({ type: 'cancel', jobId: String(jobId), at: Date.now() });
  try {
    if (typeof publish === 'function') {
      await publish(cancelChannel(jobId), payload);
      return true;
    }
    if (connection && typeof connection.publish === 'function') {
      await connection.publish(cancelChannel(jobId), payload);
      return true;
    }
  } catch (_) { /* best-effort */ }
  return false;
}

/** Default worker-side cancel listener: one duplicated Redis sub per job. */
function defaultSubscribeCancel(connection, jobId, onCancel) {
  if (!connection || typeof connection.duplicate !== 'function') return () => {};
  let sub = null;
  try {
    sub = connection.duplicate();
    sub.subscribe(cancelChannel(jobId), () => {});
    sub.on('message', (ch) => {
      if (ch === cancelChannel(jobId)) {
        try { onCancel(); } catch (_) { /* abort must never throw */ }
      }
    });
  } catch (_) {
    return () => {};
  }
  return () => { try { sub.disconnect(); } catch (_) { /* ignore */ } };
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
  subscribeCancel = null,
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
    // F3: per-job AbortController. The chat side publishes on the cancel
    // channel when the user hits Stop; aborting here stops the LLM loop and
    // the in-flight sandbox command, and the runner destroys the sandbox in
    // its own finally — no leaked process.
    const controller = new AbortController();
    const unsubscribeCancel = typeof subscribeCancel === 'function'
      ? subscribeCancel(jobId, () => controller.abort())
      : defaultSubscribeCancel(connection, jobId, () => controller.abort());
    await emit({ type: 'stage', label: 'Agente trabajando', tool: 'agent_runner' });
    let prisma = null;
    try { prisma = require('../../config/database'); } catch (_) { prisma = null; }
    try {
      const result = await runner({
        prisma,
        ...job.data,
        signal: controller.signal,
        onEvent: (ev) => { emit(ev).catch(() => {}); },
      });
      if (controller.signal.aborted) {
        // The runner settled with a result AFTER the cancel arrived — do not
        // claim success for a partially-done turn.
        await emit({ type: 'job_cancelled', label: 'Cancelado', message: 'cancelled_by_user' });
        throw Object.assign(new Error('agent_runner_job_cancelled'), { name: 'AbortError' });
      }
      await emit({ type: 'final', label: 'Listo', summary: result.summary, artifacts: result.artifacts });
      await emit({ type: 'job_done', result, label: 'Listo' });
      return result;
    } catch (err) {
      if (err?.name === 'AbortError' && err?.message === 'agent_runner_job_cancelled') throw err;
      if (controller.signal.aborted) {
        await emit({ type: 'job_cancelled', label: 'Cancelado', message: 'cancelled_by_user' });
        throw Object.assign(new Error('agent_runner_job_cancelled'), { name: 'AbortError' });
      }
      await emit({ type: 'job_error', message: err?.message || String(err), label: 'Error' });
      throw err;
    } finally {
      try { unsubscribeCancel(); } catch (_) { /* ignore */ }
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
  requestCancel = null,
} = {}) {
  if (!connection || typeof connection.duplicate !== 'function') {
    throw new Error('waitForAgentRunnerJob: redis connection is required');
  }
  const channel = eventChannel(jobId);
  const sub = connection.duplicate();
  // Stop button (F3): aborting the wait must also cancel the WORKER-side job,
  // otherwise the loop keeps burning tokens/sandbox time with nobody watching.
  const propagateCancel = () => {
    const req = typeof requestCancel === 'function'
      ? requestCancel
      : () => requestAgentRunnerJobCancel({ jobId, connection });
    Promise.resolve()
      .then(() => req())
      .catch(() => { /* best-effort */ });
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error('agent_runner_job_timeout')), timeoutMs);
    const onAbort = () => {
      propagateCancel();
      finish(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
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
      propagateCancel();
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
      if (ev && ev.type === 'job_cancelled') {
        finish(Object.assign(new Error('agent_runner_job_cancelled'), { name: 'AbortError' }));
      }
      if (ev && ev.type === 'job_error') finish(new Error(ev.message || 'agent_runner_job_failed'));
    });
  });
}

module.exports = {
  QUEUE_NAME,
  CHANNEL_PREFIX,
  CANCEL_CHANNEL_PREFIX,
  isAsyncEnabled,
  isLikelyTestProcess,
  eventChannel,
  cancelChannel,
  requestAgentRunnerJobCancel,
  enqueueAgentRunnerJob,
  startAgentRunnerWorker,
  waitForAgentRunnerJob,
};

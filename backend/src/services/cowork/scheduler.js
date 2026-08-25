'use strict';

const crypto = require('node:crypto');
const cron = require('node-cron');
const cronParser = require('cron-parser');
const controlPlane = require('./control-plane');
const { notify } = require('./notify');

const WORKER_INTERVAL_MS = Math.max(
  15_000,
  Number.parseInt(process.env.SIRAGPT_COWORK_SCHEDULER_INTERVAL_MS || '60000', 10),
);
const LOCK_MS = Math.max(
  60_000,
  Number.parseInt(process.env.SIRAGPT_COWORK_SCHEDULER_LOCK_MS || `${25 * 60_000}`, 10),
);
const BATCH_SIZE = Math.min(
  50,
  Math.max(1, Number.parseInt(process.env.SIRAGPT_COWORK_SCHEDULER_BATCH || '10', 10)),
);

let workerTimer = null;
let workerBusy = false;

function nextRun(cronExpr, tz, from = new Date()) {
  if (!cron.validate(String(cronExpr || ''))) {
    const error = new Error('Invalid cron expression.');
    error.code = 'cron_expression_invalid';
    error.status = 400;
    throw error;
  }
  try {
    return cronParser.parseExpression(String(cronExpr), {
      currentDate: from,
      tz: String(tz || 'UTC'),
    }).next().toDate();
  } catch (error) {
    const wrapped = new Error(`Invalid schedule or timezone: ${error.message}`);
    wrapped.code = 'schedule_invalid';
    wrapped.status = 400;
    throw wrapped;
  }
}

async function createScheduledTask(prisma, {
  userId,
  workspaceId = null,
  prompt,
  cronExpr,
  tz = 'UTC',
  deliver = 'chat',
  maxSteps = 12,
  maxCostUsd = null,
  createdFrom = 'ui',
}) {
  const text = String(prompt || '').trim();
  if (!text) {
    const error = new Error('Prompt is required.');
    error.code = 'scheduled_prompt_required';
    error.status = 400;
    throw error;
  }
  if (!['chat', 'email', 'telegram'].includes(deliver)) {
    const error = new Error('Delivery channel must be chat, email, or telegram.');
    error.code = 'scheduled_delivery_invalid';
    error.status = 400;
    throw error;
  }
  if (workspaceId) {
    const workspace = await prisma.coworkWorkspace.findFirst({
      where: { id: String(workspaceId), userId: String(userId) },
      select: { id: true },
    });
    if (!workspace) {
      const error = new Error('Workspace not found.');
      error.code = 'workspace_not_found';
      error.status = 404;
      throw error;
    }
  }
  const limits = await controlPlane.loadUserLimits(prisma, userId);
  return prisma.scheduledAgentTask.create({
    data: {
      userId: String(userId),
      workspaceId: workspaceId || null,
      prompt: text.slice(0, 100_000),
      cronExpr: String(cronExpr),
      tz: String(tz || 'UTC').slice(0, 100),
      deliver,
      createdFrom: String(createdFrom || 'ui').slice(0, 60),
      maxSteps: Math.round(Math.min(Math.max(Number(maxSteps) || 12, 1), limits.maxSteps)),
      maxCostUsd: maxCostUsd == null
        ? limits.maxCostUsd
        : Math.min(Math.max(Number(maxCostUsd) || 0.01, 0.01), limits.maxCostUsd),
      nextRunAt: nextRun(cronExpr, tz),
    },
  });
}

async function listScheduledTasks(prisma, { userId, workspaceId = null }) {
  return prisma.scheduledAgentTask.findMany({
    where: {
      userId: String(userId),
      ...(workspaceId ? { workspaceId: String(workspaceId) } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

async function updateScheduledTask(prisma, {
  userId,
  taskId,
  patch,
}) {
  const existing = await prisma.scheduledAgentTask.findFirst({
    where: { id: String(taskId), userId: String(userId) },
  });
  if (!existing) {
    const error = new Error('Scheduled task not found.');
    error.code = 'scheduled_task_not_found';
    error.status = 404;
    throw error;
  }
  const cronExpr = patch.cronExpr == null ? existing.cronExpr : String(patch.cronExpr);
  const tz = patch.tz == null ? existing.tz : String(patch.tz);
  const deliver = patch.deliver == null ? existing.deliver : String(patch.deliver);
  if (!['chat', 'email', 'telegram'].includes(deliver)) {
    const error = new Error('Delivery channel must be chat, email, or telegram.');
    error.code = 'scheduled_delivery_invalid';
    error.status = 400;
    throw error;
  }
  const limits = await controlPlane.loadUserLimits(prisma, userId);
  const prompt = patch.prompt == null ? existing.prompt : String(patch.prompt).trim();
  if (!prompt) {
    const error = new Error('Prompt is required.');
    error.code = 'scheduled_prompt_required';
    error.status = 400;
    throw error;
  }
  const data = {
    prompt: prompt.slice(0, 100_000),
    ...(patch.enabled != null ? { enabled: Boolean(patch.enabled) } : {}),
    ...(patch.maxSteps != null
      ? { maxSteps: Math.min(Math.max(Number(patch.maxSteps) || 12, 1), limits.maxSteps) }
      : {}),
    ...(patch.maxCostUsd !== undefined
      ? {
        maxCostUsd: patch.maxCostUsd == null
          ? limits.maxCostUsd
          : Math.min(Math.max(0.01, Number(patch.maxCostUsd) || 0.01), limits.maxCostUsd),
      }
      : {}),
    cronExpr,
    tz,
    deliver,
    nextRunAt: nextRun(cronExpr, tz),
    lockedBy: null,
    lockedUntil: null,
  };
  return prisma.scheduledAgentTask.update({ where: { id: existing.id }, data });
}

async function deleteScheduledTask(prisma, { userId, taskId }) {
  const deleted = await prisma.scheduledAgentTask.deleteMany({
    where: { id: String(taskId), userId: String(userId) },
  });
  return deleted.count === 1;
}

async function claimTask(prisma, task, workerId, now = new Date()) {
  const claimed = await prisma.scheduledAgentTask.updateMany({
    where: {
      id: task.id,
      enabled: true,
      nextRunAt: { lte: now },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    data: {
      lockedBy: workerId,
      lockedUntil: new Date(now.getTime() + LOCK_MS),
    },
  });
  return claimed.count === 1;
}

async function ensureDeliveryChat(prisma, task) {
  if (task.workspaceId) {
    const linked = await prisma.chat.findFirst({
      where: { userId: task.userId, coworkWorkspaceId: task.workspaceId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });
    if (linked) return linked.id;
  }
  const chat = await prisma.chat.create({
    data: {
      userId: task.userId,
      title: `Scheduled: ${task.prompt.slice(0, 60)}`,
      model: process.env.SIRAGPT_COWORK_SCHEDULER_MODEL || 'gpt-4o-mini',
      coworkWorkspaceId: task.workspaceId,
    },
    select: { id: true },
  });
  return chat.id;
}

async function executeTask(prisma, task, { runAgentImpl = null } = {}) {
  const chatId = await ensureDeliveryChat(prisma, task);
  const run = await controlPlane.createRun(prisma, {
    userId: task.userId,
    chatId,
    workspaceId: task.workspaceId,
    prompt: task.prompt,
    kind: 'scheduled',
    maxSteps: task.maxSteps,
    maxCostUsd: task.maxCostUsd,
    status: 'running',
  });
  await prisma.message.create({
    data: {
      chatId,
      role: 'USER',
      content: task.prompt,
      metadata: { scheduledTaskId: task.id, coworkRunId: run.id },
    },
  });

  let result;
  try {
    if (runAgentImpl) {
      result = await runAgentImpl({
        userId: task.userId,
        prompt: task.prompt,
        thinking: 'low',
        mode: 'sandbox',
        source: `cowork-schedule:${task.id}`,
        maxSteps: task.maxSteps,
      });
    } else {
      const { runCoworkHeadless } = require('./headless-runner');
      result = await runCoworkHeadless(prisma, {
        run,
        chatId,
        prompt: task.prompt,
        source: `cowork-schedule:${task.id}`,
        model: process.env.SIRAGPT_COWORK_SCHEDULER_MODEL || null,
      });
    }
    const answer = String(result?.answer || '(No answer)').trim();
    const stoppedReason = String(result?.stoppedReason || 'finalized');
    const terminalStatus = /cancel|abort|budget_exhausted|max_steps/i.test(stoppedReason)
      ? 'cancelled'
      : (/error|failed/i.test(stoppedReason) ? 'failed' : 'completed');
    await prisma.message.create({
      data: {
        chatId,
        role: 'ASSISTANT',
        content: answer,
        metadata: {
          scheduledTaskId: task.id,
          coworkRunId: run.id,
          stoppedReason,
        },
      },
    });
    await controlPlane.finishRun(prisma, {
      runId: run.id,
      userId: task.userId,
      status: terminalStatus,
      lastEvent: terminalStatus === 'completed'
        ? 'Scheduled task completed'
        : `Scheduled task stopped: ${stoppedReason}`,
    });
    if (terminalStatus === 'completed' && task.deliver !== 'chat') {
      await notify(prisma, {
        userId: task.userId,
        type: 'cowork_scheduled_completed',
        title: 'Tarea programada completada',
        message: answer.slice(0, 3500),
        channels: ['in_app', task.deliver],
        actionUrl: `${String(process.env.FRONTEND_URL || 'https://siragpt.com').replace(/\/$/, '')}/agentes?id=${encodeURIComponent(chatId)}`,
        metadata: { taskId: task.id, runId: run.id, chatId },
      });
    } else if (terminalStatus !== 'completed') {
      await notify(prisma, {
        userId: task.userId,
        type: 'cowork_scheduled_stopped',
        title: 'Tarea programada detenida',
        message: `La tarea se detuvo: ${stoppedReason}`,
        severity: 'warning',
        channels: ['in_app', 'web_push'],
        actionUrl: `${String(process.env.FRONTEND_URL || 'https://siragpt.com').replace(/\/$/, '')}/agentes?id=${encodeURIComponent(chatId)}`,
        metadata: { taskId: task.id, runId: run.id, chatId, stoppedReason },
      });
    }
    return {
      ok: terminalStatus === 'completed',
      status: terminalStatus,
      runId: run.id,
      chatId,
      answer,
      stoppedReason,
    };
  } catch (error) {
    await controlPlane.finishRun(prisma, {
      runId: run.id,
      userId: task.userId,
      status: 'failed',
      lastEvent: error.message,
    }).catch(() => {});
    await notify(prisma, {
      userId: task.userId,
      type: 'cowork_scheduled_failed',
      title: 'Tarea programada detenida',
      message: String(error.message || 'Unknown error').slice(0, 2000),
      severity: 'warning',
      channels: ['in_app', 'web_push'],
      metadata: { taskId: task.id, runId: run.id },
    });
    throw error;
  }
}

async function executeClaimedTask(prisma, task, {
  now,
  runAgentImpl = null,
  nextRunAt = null,
} = {}) {
  try {
    const result = await executeTask(prisma, task, { runAgentImpl });
    await prisma.scheduledAgentTask.update({
      where: { id: task.id },
      data: {
        lastRunAt: now,
        lastStatus: result.status || (result.ok ? 'completed' : 'failed'),
        nextRunAt: nextRunAt || nextRun(task.cronExpr, task.tz, new Date(now.getTime() + 1000)),
        lockedBy: null,
        lockedUntil: null,
      },
    });
    return { taskId: task.id, ...result };
  } catch (error) {
    await prisma.scheduledAgentTask.update({
      where: { id: task.id },
      data: {
        lastRunAt: now,
        lastStatus: 'failed',
        nextRunAt: nextRunAt || nextRun(task.cronExpr, task.tz, new Date(now.getTime() + 1000)),
        lockedBy: null,
        lockedUntil: null,
      },
    }).catch(() => {});
    return { taskId: task.id, ok: false, error: error.message };
  }
}

async function runDueTasks(prisma, {
  now = new Date(),
  runAgentImpl = null,
  detached = false,
} = {}) {
  if (workerBusy) return { skipped: true, reason: 'busy', claimed: 0 };
  workerBusy = true;
  const workerId = `${process.pid}:${crypto.randomUUID()}`;
  let claimedCount = 0;
  const results = [];
  try {
    const due = await prisma.scheduledAgentTask.findMany({
      where: {
        enabled: true,
        nextRunAt: { lte: now },
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      orderBy: { nextRunAt: 'asc' },
      take: BATCH_SIZE,
    });
    for (const task of due) {
      if (!await claimTask(prisma, task, workerId, now)) continue;
      claimedCount += 1;
      const nextRunAt = nextRun(task.cronExpr, task.tz, new Date(now.getTime() + 1000));
      if (detached) {
        await prisma.scheduledAgentTask.update({
          where: { id: task.id },
          data: {
            lastRunAt: now,
            lastStatus: 'running',
            nextRunAt,
          },
        });
        setImmediate(() => {
          executeClaimedTask(prisma, task, { now, runAgentImpl, nextRunAt }).catch(() => {});
        });
        results.push({ taskId: task.id, ok: true, status: 'started' });
      } else {
        results.push(await executeClaimedTask(prisma, task, { now, runAgentImpl, nextRunAt }));
      }
    }
    return { skipped: false, claimed: claimedCount, results };
  } finally {
    workerBusy = false;
  }
}

function startSchedulerWorker(prisma) {
  if (workerTimer || String(process.env.SIRAGPT_COWORK_SCHEDULER_ENABLED || '1') === '0') return false;
  workerTimer = setInterval(() => {
    runDueTasks(prisma, { detached: true }).catch((error) => {
      try { console.warn('[cowork-scheduler] tick failed:', error.message); } catch (_) { /* noop */ }
    });
  }, WORKER_INTERVAL_MS);
  workerTimer.unref?.();
  setTimeout(() => runDueTasks(prisma, { detached: true }).catch(() => {}), 5_000).unref?.();
  return true;
}

function stopSchedulerWorker() {
  if (!workerTimer) return;
  clearInterval(workerTimer);
  workerTimer = null;
}

module.exports = {
  WORKER_INTERVAL_MS,
  LOCK_MS,
  nextRun,
  createScheduledTask,
  listScheduledTasks,
  updateScheduledTask,
  deleteScheduledTask,
  claimTask,
  executeTask,
  executeClaimedTask,
  runDueTasks,
  startSchedulerWorker,
  stopSchedulerWorker,
};

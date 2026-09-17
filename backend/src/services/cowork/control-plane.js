'use strict';

const workspaceStore = require('./workspace-store');

const ACTIVE_STATUSES = Object.freeze(['queued', 'running', 'paused', 'waiting_approval']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const VALID_STATUSES = new Set([...ACTIVE_STATUSES, ...TERMINAL_STATUSES]);
const DEFAULT_PAUSE_POLL_MS = Math.max(
  250,
  Number.parseInt(process.env.SIRAGPT_COWORK_PAUSE_POLL_MS || '1000', 10),
);

const PLAN_LIMITS = Object.freeze({
  FREE: { concurrency: 1, maxSteps: 12, maxCostUsd: 0.25 },
  PRO: { concurrency: 3, maxSteps: 40, maxCostUsd: 3 },
  PRO_MAX: { concurrency: 6, maxSteps: 80, maxCostUsd: 10 },
  ENTERPRISE: { concurrency: 12, maxSteps: 160, maxCostUsd: 50 },
});

class CoworkControlError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'CoworkControlError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function limitsForPlan(plan) {
  return PLAN_LIMITS[String(plan || 'FREE').toUpperCase()] || PLAN_LIMITS.FREE;
}

async function loadUserLimits(prisma, userId) {
  const user = await prisma.user.findUnique({
    where: { id: String(userId) },
    select: { id: true, plan: true, isAdmin: true, isSuperAdmin: true },
  });
  if (!user) throw new CoworkControlError('user_not_found', 'User not found.', 404);
  if (user.isAdmin || user.isSuperAdmin) {
    return { ...PLAN_LIMITS.ENTERPRISE, plan: 'ENTERPRISE' };
  }
  return { ...limitsForPlan(user.plan), plan: user.plan };
}

function normalizeChecklist(input) {
  if (!Array.isArray(input)) return [];
  if (input.length > 100) {
    throw new CoworkControlError('checklist_too_large', 'A checklist can contain at most 100 items.', 413);
  }
  const normalized = input.map((item, index) => {
    const source = typeof item === 'string' ? { text: item } : (item || {});
    const text = String(source.text || source.label || '').trim();
    if (!text) throw new CoworkControlError('checklist_item_invalid', `Checklist item ${index + 1} is empty.`);
    const status = ['pending', 'in_progress', 'completed', 'blocked'].includes(source.status)
      ? source.status
      : 'pending';
    return {
      id: String(source.id || `item-${index + 1}`).slice(0, 100),
      text: text.slice(0, 500),
      status,
      ...(source.note ? { note: String(source.note).slice(0, 1000) } : {}),
    };
  });
  const activeItems = normalized.filter((item) => item.status === 'in_progress');
  if (activeItems.length > 1) {
    throw new CoworkControlError(
      'checklist_multiple_active_items',
      'A checklist can have at most one item in progress.',
      400,
    );
  }
  return normalized;
}

async function appendAudit(prisma, {
  userId,
  workspaceId = null,
  runId = null,
  action,
  targetType = null,
  targetId = null,
  inputSummary = null,
  resultSummary = null,
  metadata = null,
}) {
  if (!prisma?.agentAuditLog || !userId || !action) return null;
  try {
    return await prisma.agentAuditLog.create({
      data: {
        userId: String(userId),
        workspaceId: workspaceId || null,
        runId: runId || null,
        action: String(action).slice(0, 160),
        targetType: targetType ? String(targetType).slice(0, 100) : null,
        targetId: targetId ? String(targetId).slice(0, 200) : null,
        inputSummary: inputSummary ? String(inputSummary).slice(0, 4000) : null,
        resultSummary: resultSummary ? String(resultSummary).slice(0, 4000) : null,
        metadata,
      },
    });
  } catch (error) {
    try { console.warn('[cowork] audit append failed:', error.message); } catch (_) { /* noop */ }
    return null;
  }
}

async function getOwnedRun(prisma, { runId, userId, include = null }) {
  const run = await prisma.coworkRun.findFirst({
    where: { id: String(runId), userId: String(userId) },
    ...(include ? { include } : {}),
  });
  if (!run) throw new CoworkControlError('cowork_run_not_found', 'Cowork run not found.', 404);
  return run;
}

async function createRun(prisma, {
  userId,
  chatId = null,
  workspaceId = null,
  parentRunId = null,
  prompt,
  kind = 'chat',
  checklist = [],
  maxSteps = null,
  maxCostUsd = null,
  status = 'running',
}) {
  const limits = await loadUserLimits(prisma, userId);
  let workspace = null;
  if (workspaceId) {
    workspace = await workspaceStore.getWorkspace(prisma, { workspaceId, userId });
  } else if (chatId) {
    workspace = await workspaceStore.ensureWorkspaceForChat(prisma, { userId, chatId });
  }
  if (parentRunId) await getOwnedRun(prisma, { runId: parentRunId, userId });

  const boundedSteps = Math.round(clampNumber(maxSteps, Math.min(24, limits.maxSteps), 1, limits.maxSteps));
  const boundedCost = maxCostUsd == null
    ? limits.maxCostUsd
    : clampNumber(maxCostUsd, limits.maxCostUsd, 0.01, limits.maxCostUsd);
  const data = {
    userId: String(userId),
    chatId: chatId || null,
    workspaceId: workspace?.id || null,
    parentRunId: parentRunId || null,
    prompt: String(prompt || '').slice(0, 100_000),
    kind: String(kind || 'chat').slice(0, 60),
    checklist: normalizeChecklist(checklist),
    maxSteps: boundedSteps,
    maxCostUsd: boundedCost,
    status: VALID_STATUSES.has(status) ? status : 'running',
    startedAt: status === 'running' ? new Date() : null,
    lastEvent: status === 'running' ? 'Task started' : 'Task queued',
  };
  let run = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      run = await prisma.$transaction(async (tx) => {
        const activeCount = await tx.coworkRun.count({
          where: { userId: String(userId), status: { in: ACTIVE_STATUSES } },
        });
        if (activeCount >= limits.concurrency) {
          throw new CoworkControlError(
            'cowork_concurrency_limit',
            `Your plan allows ${limits.concurrency} concurrent Cowork task(s).`,
            429,
            { concurrency: limits.concurrency, active: activeCount, plan: limits.plan },
          );
        }
        return tx.coworkRun.create({ data });
      }, { isolationLevel: 'Serializable' });
      break;
    } catch (error) {
      if (error?.code !== 'P2034' || attempt === 2) throw error;
    }
  }
  if (!run) {
    throw new CoworkControlError(
      'cowork_concurrency_retry_exhausted',
      'Cowork could not reserve a task slot. Retry the request.',
      409,
    );
  }
  await appendAudit(prisma, {
    userId,
    workspaceId: run.workspaceId,
    runId: run.id,
    action: 'cowork.run.created',
    targetType: 'cowork_run',
    targetId: run.id,
    inputSummary: run.prompt.slice(0, 1000),
    metadata: { kind: run.kind, maxSteps: run.maxSteps, maxCostUsd: run.maxCostUsd },
  });
  return run;
}

async function listRuns(prisma, {
  userId,
  workspaceId = null,
  chatId = null,
  status = null,
  limit = 100,
}) {
  const where = { userId: String(userId) };
  if (workspaceId) where.workspaceId = String(workspaceId);
  if (chatId) where.chatId = String(chatId);
  if (status) {
    const values = String(status).split(',').map((value) => value.trim()).filter(VALID_STATUSES.has.bind(VALID_STATUSES));
    if (values.length) where.status = { in: values };
  }
  return prisma.coworkRun.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: Math.min(Math.max(Number(limit) || 100, 1), 250),
    include: {
      childRuns: {
        select: {
          id: true,
          status: true,
          kind: true,
          prompt: true,
          currentStep: true,
          maxSteps: true,
          costUsd: true,
          updatedAt: true,
        },
      },
      approvals: {
        where: { status: 'pending' },
        select: { id: true, tool: true, humanDescription: true, expiresAt: true },
      },
    },
  });
}

async function enqueueSteering(prisma, { runId, userId, note }) {
  const text = String(note || '').trim();
  if (!text) throw new CoworkControlError('steering_note_required', 'A steering note is required.');
  if (text.length > 8_000) {
    throw new CoworkControlError('steering_note_too_long', 'Steering notes are limited to 8,000 characters.', 413);
  }
  const run = await getOwnedRun(prisma, { runId, userId });
  if (TERMINAL_STATUSES.has(run.status)) {
    throw new CoworkControlError('cowork_run_finished', 'This task has already finished.', 409);
  }
  const steering = await prisma.$transaction(async (tx) => {
    const row = await tx.coworkSteeringNote.create({
      data: { runId: run.id, userId: String(userId), note: text },
    });
    await tx.coworkRun.update({
      where: { id: run.id },
      data: {
        controlVersion: { increment: 1 },
        lastEvent: 'New steering note queued',
      },
    });
    return row;
  });
  await appendAudit(prisma, {
    userId,
    workspaceId: run.workspaceId,
    runId: run.id,
    action: 'cowork.run.steered',
    targetType: 'cowork_run',
    targetId: run.id,
    inputSummary: text,
  });
  return steering;
}

async function consumeSteering(prisma, { runId, userId }) {
  const notes = await prisma.coworkSteeringNote.findMany({
    where: { runId: String(runId), userId: String(userId), status: 'queued' },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });
  if (!notes.length) return [];
  const ids = notes.map((note) => note.id);
  await prisma.coworkSteeringNote.updateMany({
    where: { id: { in: ids }, status: 'queued' },
    data: { status: 'consumed', consumedAt: new Date() },
  });
  return notes;
}

async function updateChecklist(prisma, { runId, userId, checklist }) {
  const run = await getOwnedRun(prisma, { runId, userId });
  const normalized = normalizeChecklist(checklist);
  const updated = await prisma.coworkRun.update({
    where: { id: run.id },
    data: {
      checklist: normalized,
      controlVersion: { increment: 1 },
      lastEvent: 'Checklist updated',
    },
  });
  await appendAudit(prisma, {
    userId,
    workspaceId: run.workspaceId,
    runId: run.id,
    action: 'cowork.checklist.updated',
    targetType: 'cowork_run',
    targetId: run.id,
    metadata: { items: normalized.length },
  });
  return updated;
}

async function transitionRun(prisma, { runId, userId, action }) {
  const run = await getOwnedRun(prisma, { runId, userId });
  if (TERMINAL_STATUSES.has(run.status)) {
    throw new CoworkControlError('cowork_run_finished', 'This task has already finished.', 409);
  }
  const transitions = {
    pause: { status: 'paused', event: 'Task paused by user' },
    resume: { status: 'running', event: 'Task resumed by user' },
    cancel: { status: 'cancelled', event: 'Task cancelled by user' },
  };
  const next = transitions[action];
  if (!next) throw new CoworkControlError('cowork_action_invalid', 'Unsupported task control action.');
  if (action === 'pause' && !['queued', 'running'].includes(run.status)) {
    throw new CoworkControlError('cowork_transition_invalid', `Cannot pause a ${run.status} task.`, 409);
  }
  if (action === 'resume' && run.status !== 'paused') {
    throw new CoworkControlError('cowork_transition_invalid', `Cannot resume a ${run.status} task.`, 409);
  }
  const claimed = await prisma.coworkRun.updateMany({
    where: {
      id: run.id,
      userId: String(userId),
      status: run.status,
    },
    data: {
      status: next.status,
      lastEvent: next.event,
      controlVersion: { increment: 1 },
      ...(action === 'resume' && !run.startedAt ? { startedAt: new Date() } : {}),
      ...(action === 'cancel' ? { finishedAt: new Date() } : {}),
    },
  });
  if (claimed.count !== 1) {
    const current = await getOwnedRun(prisma, { runId, userId });
    if (TERMINAL_STATUSES.has(current.status)) return current;
    throw new CoworkControlError(
      'cowork_transition_conflict',
      'The task state changed concurrently. Refresh and retry.',
      409,
      { previousStatus: run.status, currentStatus: current.status },
    );
  }
  const updated = await getOwnedRun(prisma, { runId, userId });
  await appendAudit(prisma, {
    userId,
    workspaceId: run.workspaceId,
    runId: run.id,
    action: `cowork.run.${action}`,
    targetType: 'cowork_run',
    targetId: run.id,
  });
  if (action === 'cancel') {
    await rollupCost(prisma, updated).catch((error) => {
      try { console.warn('[cowork] cancelled run cost rollup failed:', error.message); } catch (_) { /* noop */ }
    });
  }
  return updated;
}

function sleep(ms, signal = null) {
  return new Promise((resolve) => {
    let settled = false;
    let onAbort = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        finish();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function beforeStep(prisma, {
  runId,
  userId,
  step,
  signal = null,
  onEvent = null,
}) {
  let announcedPause = false;
  for (;;) {
    if (signal?.aborted) return { stop: true, reason: 'aborted' };
    const run = await getOwnedRun(prisma, { runId, userId });
    if (run.status === 'cancelled') return { stop: true, reason: 'cancelled_by_user' };
    if (run.status === 'failed' || run.status === 'completed') {
      return { stop: true, reason: `run_${run.status}` };
    }
    if (run.maxCostUsd != null && Number(run.costUsd) >= Number(run.maxCostUsd)) {
      const cancelled = await prisma.coworkRun.updateMany({
        where: {
          id: run.id,
          userId: String(userId),
          status: { in: ACTIVE_STATUSES },
        },
        data: {
          status: 'cancelled',
          finishedAt: new Date(),
          lastEvent: 'Cost budget reached',
        },
      });
      if (cancelled.count !== 1) continue;
      const updated = await getOwnedRun(prisma, { runId, userId });
      await rollupCost(prisma, updated).catch(() => {});
      await appendAudit(prisma, {
        userId,
        workspaceId: updated.workspaceId,
        runId: updated.id,
        action: 'cowork.run.cancelled',
        targetType: 'cowork_run',
        targetId: updated.id,
        resultSummary: updated.lastEvent,
        metadata: { costUsd: updated.costUsd, tokensEstimate: updated.tokensEstimate },
      });
      return { stop: true, reason: 'cost_budget_exhausted' };
    }
    if (Number(step) >= run.maxSteps) return { stop: true, reason: 'step_budget_exhausted' };
    if (run.status !== 'paused') {
      const claimed = await prisma.coworkRun.updateMany({
        where: {
          id: run.id,
          userId: String(userId),
          status: run.status,
        },
        data: {
          status: 'running',
          currentStep: Number(step) + 1,
          startedAt: run.startedAt || new Date(),
          lastEvent: `Running step ${Number(step) + 1}`,
        },
      });
      if (claimed.count !== 1) continue;
      const notes = await consumeSteering(prisma, { runId, userId });
      if (notes.length) {
        await prisma.coworkRun.updateMany({
          where: { id: run.id, userId: String(userId), status: 'running' },
          data: { lastEvent: 'Steering applied before next step' },
        });
      }
      const current = await getOwnedRun(prisma, { runId, userId });
      if (current.status === 'cancelled') return { stop: true, reason: 'cancelled_by_user' };
      if (notes.length && typeof onEvent === 'function') {
        onEvent({
          type: 'cowork_steering_applied',
          runId: run.id,
          notes: notes.map((note) => ({ id: note.id, note: note.note })),
        });
      }
      return {
        stop: false,
        run: current,
        steeringNotes: notes.map((note) => note.note),
      };
    }
    if (!announcedPause && typeof onEvent === 'function') {
      announcedPause = true;
      onEvent({ type: 'cowork_run_paused', runId: run.id });
    }
    await sleep(DEFAULT_PAUSE_POLL_MS, signal);
  }
}

async function recordStep(prisma, {
  runId,
  userId,
  step,
  event = null,
  tokensEstimate = 0,
  costUsd = 0,
}) {
  const run = await getOwnedRun(prisma, { runId, userId });
  if (TERMINAL_STATUSES.has(run.status)) return run;
  await prisma.coworkRun.updateMany({
    where: {
      id: run.id,
      userId: String(userId),
      status: { in: ACTIVE_STATUSES },
    },
    data: {
      currentStep: Math.max(run.currentStep, Number(step) || 0),
      tokensEstimate: { increment: Math.max(0, Math.round(Number(tokensEstimate) || 0)) },
      costUsd: { increment: Math.max(0, Number(costUsd) || 0) },
      lastEvent: String(event || `Completed step ${step}`).slice(0, 4000),
    },
  });
  return getOwnedRun(prisma, { runId, userId });
}

async function saveCheckpoint(prisma, {
  runId,
  userId,
  checkpoint,
}) {
  if (!checkpoint || typeof checkpoint !== 'object') return null;
  const serialized = JSON.stringify(checkpoint);
  if (serialized.length > 2_000_000) {
    throw new CoworkControlError(
      'cowork_checkpoint_too_large',
      'The task checkpoint exceeds the 2 MB persistence limit.',
      413,
    );
  }
  const run = await getOwnedRun(prisma, { runId, userId });
  if (TERMINAL_STATUSES.has(run.status)) return run;
  await prisma.coworkRun.updateMany({
    where: {
      id: run.id,
      userId: String(userId),
      status: { in: ACTIVE_STATUSES },
    },
    data: {
      checkpoint,
      controlVersion: { increment: 1 },
    },
  });
  return getOwnedRun(prisma, { runId, userId });
}

function utcDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

async function rollupCost(prisma, run) {
  if (!run || !run.userId || (!run.costUsd && !run.tokensEstimate)) return null;
  const scopeKey = run.workspaceId
    ? `workspace:${run.workspaceId}`
    : (run.chatId ? `chat:${run.chatId}` : `run:${run.id}`);
  return prisma.coworkCostDaily.upsert({
    where: {
      userId_scopeKey_day: {
        userId: run.userId,
        scopeKey,
        day: utcDay(),
      },
    },
    create: {
      userId: run.userId,
      scopeKey,
      workspaceId: run.workspaceId,
      chatId: run.chatId,
      day: utcDay(),
      costUsd: run.costUsd,
      tokensEstimate: run.tokensEstimate,
      runCount: 1,
    },
    update: {
      costUsd: { increment: run.costUsd },
      tokensEstimate: { increment: run.tokensEstimate },
      runCount: { increment: 1 },
    },
  });
}

async function finishRun(prisma, {
  runId,
  userId,
  status = 'completed',
  lastEvent = null,
  costUsd = null,
  tokensEstimate = null,
}) {
  const run = await getOwnedRun(prisma, { runId, userId });
  if (TERMINAL_STATUSES.has(run.status)) return run;
  const terminal = TERMINAL_STATUSES.has(status) ? status : 'completed';
  // Provider-reported per-step usage is the authoritative value. The harness
  // estimates are accepted only when a provider returned no usage at all.
  const finalCost = costUsd == null || Number(run.costUsd) > 0
    ? run.costUsd
    : Math.max(0, Number(costUsd) || 0);
  const finalTokens = tokensEstimate == null || run.tokensEstimate > 0
    ? run.tokensEstimate
    : Math.max(0, Math.round(Number(tokensEstimate) || 0));
  const claimed = await prisma.coworkRun.updateMany({
    where: { id: run.id, status: { in: ACTIVE_STATUSES } },
    data: {
      status: terminal,
      finishedAt: new Date(),
      costUsd: finalCost,
      tokensEstimate: finalTokens,
      lastEvent: String(lastEvent || `Task ${terminal}`).slice(0, 4000),
    },
  });
  if (claimed.count !== 1) {
    return getOwnedRun(prisma, { runId, userId });
  }
  const updated = await prisma.coworkRun.findUnique({ where: { id: run.id } });
  await rollupCost(prisma, updated);
  await appendAudit(prisma, {
    userId,
    workspaceId: updated.workspaceId,
    runId: updated.id,
    action: `cowork.run.${terminal}`,
    targetType: 'cowork_run',
    targetId: updated.id,
    resultSummary: updated.lastEvent,
    metadata: { costUsd: updated.costUsd, tokensEstimate: updated.tokensEstimate },
  });
  if (terminal === 'failed' || (terminal === 'completed' && (updated.kind !== 'chat' || updated.currentStep > 1))) {
    try {
      const { notifyRunState } = require('./notify');
      Promise.resolve(notifyRunState(
        prisma,
        updated,
        terminal,
        updated.lastEvent,
      )).catch(() => {});
    } catch (_) { /* notifications are best effort */ }
  }
  return updated;
}

async function listAudit(prisma, { userId, workspaceId = null, runId = null, limit = 100 }) {
  return prisma.agentAuditLog.findMany({
    where: {
      userId: String(userId),
      ...(workspaceId ? { workspaceId: String(workspaceId) } : {}),
      ...(runId ? { runId: String(runId) } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(Number(limit) || 100, 1), 500),
  });
}

async function getCostSummary(prisma, { userId, workspaceId = null, days = 30 }) {
  const since = utcDay(new Date(Date.now() - Math.max(1, Number(days) || 30) * 86_400_000));
  const rows = await prisma.coworkCostDaily.findMany({
    where: {
      userId: String(userId),
      day: { gte: since },
      ...(workspaceId ? { workspaceId: String(workspaceId) } : {}),
    },
    orderBy: { day: 'asc' },
  });
  return {
    rows,
    totalCostUsd: Number(rows.reduce((sum, row) => sum + Number(row.costUsd || 0), 0).toFixed(6)),
    tokensEstimate: rows.reduce((sum, row) => sum + row.tokensEstimate, 0),
    runCount: rows.reduce((sum, row) => sum + row.runCount, 0),
  };
}

module.exports = {
  CoworkControlError,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  PLAN_LIMITS,
  limitsForPlan,
  loadUserLimits,
  normalizeChecklist,
  appendAudit,
  getOwnedRun,
  createRun,
  listRuns,
  enqueueSteering,
  consumeSteering,
  updateChecklist,
  transitionRun,
  beforeStep,
  recordStep,
  saveCheckpoint,
  finishRun,
  listAudit,
  getCostSummary,
  utcDay,
};

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promises: fsp } = fs;

const STORE_VERSION = 'siragpt-task-flow-2026-07';
const FLOW_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;
const MAX_STATE_CHARS = 200000;
const MAX_CHILD_TASKS = 100;
const MAX_EVENTS = 500;
const LOCK_TIMEOUT_MS = 2500;
const STALE_LOCK_MS = 30000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE_STATUSES = new Set(['running', 'waiting', 'blocked', 'cancel_requested']);
const ALL_STATUSES = new Set([...TERMINAL_STATUSES, ...ACTIVE_STATUSES]);

class TaskFlowError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TaskFlowError';
    this.code = code;
    this.details = details;
  }
}

function getTaskFlowStoreDir() {
  return process.env.SIRAGPT_TASK_FLOW_STORE_DIR
    || path.join(process.cwd(), 'uploads', 'task-flows');
}

function ensureDir() {
  const dir = getTaskFlowStoreDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function normalizeFlowId(value) {
  const id = String(value || '').trim();
  if (!FLOW_ID_PATTERN.test(id)) {
    throw new TaskFlowError('invalid_flow_id', 'task flow id is invalid');
  }
  return id;
}

function recordPathFor(flowId) {
  return path.join(ensureDir(), `${normalizeFlowId(flowId)}.json`);
}

function lockPathFor(flowId) {
  return path.join(ensureDir(), `${normalizeFlowId(flowId)}.lock`);
}

function nowIso() {
  return new Date().toISOString();
}

function boundedText(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

function safeJson(value, label, maxChars = MAX_STATE_CHARS) {
  if (value == null) return null;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TaskFlowError('invalid_state', `${label} must be JSON serializable`);
  }
  if (serialized.length > maxChars) {
    throw new TaskFlowError('state_too_large', `${label} exceeds ${maxChars} serialized characters`);
  }
  return JSON.parse(serialized);
}

function trimList(value, limit) {
  const list = Array.isArray(value) ? value : [];
  return list.length > limit ? list.slice(list.length - limit) : list;
}

function normalizeChildTask(child = {}) {
  const taskId = boundedText(child.taskId || child.id, 160);
  if (!taskId) throw new TaskFlowError('invalid_child_task', 'child taskId is required');
  return {
    taskId,
    status: boundedText(child.status || 'linked', 40),
    runtime: boundedText(child.runtime || 'siragpt-agent-task', 80),
    sessionId: boundedText(child.sessionId, 160) || null,
    runId: boundedText(child.runId, 160) || null,
    startedAt: child.startedAt || null,
    lastEventAt: child.lastEventAt || nowIso(),
    completedAt: child.completedAt || null,
  };
}

function normalizeEvent(event = {}, fallbackType = 'flow_updated') {
  return {
    type: boundedText(event.type || fallbackType, 80),
    ts: event.ts || nowIso(),
    status: boundedText(event.status, 40) || null,
    currentStep: boundedText(event.currentStep, 160) || null,
    taskId: boundedText(event.taskId, 160) || null,
    reason: boundedText(event.reason, 1000) || null,
  };
}

function sanitizeFlowRecord(record = {}) {
  const flowId = normalizeFlowId(record.flowId);
  const userId = boundedText(record.userId, 160);
  if (!userId) throw new TaskFlowError('invalid_owner', 'task flow owner is required');
  const status = boundedText(record.status || 'running', 40);
  if (!ALL_STATUSES.has(status)) {
    throw new TaskFlowError('invalid_status', `unsupported task flow status: ${status}`);
  }
  const revision = Number(record.revision);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new TaskFlowError('invalid_revision', 'task flow revision must be a positive integer');
  }
  const createdAt = record.createdAt || nowIso();
  const childTasks = (Array.isArray(record.childTasks) ? record.childTasks : [])
    .slice(0, MAX_CHILD_TASKS)
    .map(normalizeChildTask);

  return {
    version: STORE_VERSION,
    flowId,
    userId,
    chatId: boundedText(record.chatId, 160) || null,
    controllerId: boundedText(record.controllerId, 200) || 'siragpt/managed-flow',
    goal: boundedText(record.goal, 8000),
    status,
    currentStep: boundedText(record.currentStep, 200) || null,
    stateJson: safeJson(record.stateJson, 'stateJson'),
    waitJson: safeJson(record.waitJson, 'waitJson', 50000),
    blockedSummary: boundedText(record.blockedSummary, 2000) || null,
    revision,
    childTasks,
    events: trimList(record.events, MAX_EVENTS).map((event) => normalizeEvent(event)),
    createdAt,
    updatedAt: record.updatedAt || createdAt,
    completedAt: record.completedAt || null,
  };
}

function atomicWriteJson(filePath, payload) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
    try { fs.fsyncSync(fd); } catch { /* best effort */ }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

function atomicCreateJson(filePath, payload) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
      try { fs.fsyncSync(fd); } catch { /* best effort */ }
    } finally {
      fs.closeSync(fd);
    }
    // A hard link publishes the fully written record without replacing an
    // existing flow. This closes the check-then-create race across workers.
    fs.linkSync(tmp, filePath);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new TaskFlowError('flow_exists', 'task flow already exists');
    }
    throw error;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

function readTaskFlow(flowId) {
  try {
    const file = recordPathFor(flowId);
    if (!fs.existsSync(file)) return null;
    return sanitizeFlowRecord(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error instanceof TaskFlowError && error.code === 'invalid_flow_id') throw error;
    return null;
  }
}

function getTaskFlowForUser(flowId, userId) {
  const record = readTaskFlow(flowId);
  if (!record || String(record.userId) !== String(userId || '')) return null;
  return record;
}

function createManagedTaskFlow({
  flowId = `flow-${crypto.randomUUID()}`,
  userId,
  chatId = null,
  controllerId = 'siragpt/managed-flow',
  goal,
  currentStep = null,
  stateJson = {},
} = {}) {
  const id = normalizeFlowId(flowId);
  const cleanGoal = boundedText(goal, 8000);
  if (!cleanGoal) {
    throw new TaskFlowError('invalid_goal', 'task flow goal is required');
  }
  const file = recordPathFor(id);
  if (fs.existsSync(file)) {
    throw new TaskFlowError('flow_exists', 'task flow already exists');
  }
  const stamp = nowIso();
  const record = sanitizeFlowRecord({
    flowId: id,
    userId,
    chatId,
    controllerId,
    goal: cleanGoal,
    status: 'running',
    currentStep,
    stateJson,
    waitJson: null,
    revision: 1,
    childTasks: [],
    events: [{ type: 'flow_created', ts: stamp, status: 'running', currentStep }],
    createdAt: stamp,
    updatedAt: stamp,
  });
  atomicCreateJson(file, record);
  return record;
}

function listTaskFlowsForUser(userId, { limit = 25, status = null } = {}) {
  const owner = String(userId || '');
  if (!owner) return [];
  const allowedStatuses = Array.isArray(status)
    ? new Set(status.map(String))
    : status ? new Set([String(status)]) : null;
  const rows = [];
  for (const entry of fs.readdirSync(ensureDir())) {
    if (!entry.endsWith('.json')) continue;
    try {
      const record = sanitizeFlowRecord(JSON.parse(fs.readFileSync(path.join(ensureDir(), entry), 'utf8')));
      if (String(record.userId) !== owner) continue;
      if (allowedStatuses && !allowedStatuses.has(record.status)) continue;
      rows.push(record);
    } catch {
      // Corrupt or obsolete records are skipped from user listings.
    }
  }
  return rows
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
    .slice(0, Math.max(1, Math.min(Number(limit) || 25, 100)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withFlowLock(flowId, operation, { timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const lockPath = lockPathFor(flowId);
  const startedAt = Date.now();
  let handle;
  while (!handle) {
    try {
      handle = await fsp.open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: nowIso() }));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = await fsp.stat(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          await fsp.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new TaskFlowError('flow_locked', 'task flow is busy; retry the operation');
      }
      await sleep(20);
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await fsp.unlink(lockPath).catch(() => {});
  }
}

function assertExpectedRevision(record, expectedRevision) {
  const expected = Number(expectedRevision);
  if (!Number.isInteger(expected) || expected < 1) {
    throw new TaskFlowError('expected_revision_required', 'expectedRevision is required for task flow changes');
  }
  if (record.revision !== expected) {
    throw new TaskFlowError('revision_conflict', 'task flow changed before this update', {
      expectedRevision: expected,
      currentRevision: record.revision,
    });
  }
}

function assertMutable(record, allowed, action) {
  if (TERMINAL_STATUSES.has(record.status)) {
    throw new TaskFlowError('flow_terminal', `cannot ${action} a ${record.status} task flow`);
  }
  if (allowed && !allowed.has(record.status)) {
    throw new TaskFlowError('invalid_transition', `cannot ${action} a task flow in ${record.status}`);
  }
}

async function mutateTaskFlow({ flowId, userId, expectedRevision, action, mutate }) {
  const id = normalizeFlowId(flowId);
  return withFlowLock(id, async () => {
    const current = getTaskFlowForUser(id, userId);
    if (!current) throw new TaskFlowError('flow_not_found', 'task flow not found');
    assertExpectedRevision(current, expectedRevision);
    const change = await mutate(current);
    const stamp = nowIso();
    const patch = change?.patch || {};
    const nextStatus = patch.status || current.status;
    const next = sanitizeFlowRecord({
      ...current,
      ...patch,
      flowId: current.flowId,
      userId: current.userId,
      revision: current.revision + 1,
      updatedAt: stamp,
      completedAt: TERMINAL_STATUSES.has(nextStatus) ? (patch.completedAt || stamp) : null,
      events: [
        ...(current.events || []),
        normalizeEvent({
          ...(change?.event || {}),
          type: change?.event?.type || `flow_${action}`,
          ts: stamp,
          status: nextStatus,
          currentStep: patch.currentStep === undefined ? current.currentStep : patch.currentStep,
        }),
      ],
    });
    atomicWriteJson(recordPathFor(id), next);
    return next;
  });
}

async function setTaskFlowWaiting(args = {}) {
  return mutateTaskFlow({ ...args, action: 'waiting', mutate: (record) => {
    assertMutable(record, new Set(['running', 'blocked']), 'set waiting');
    return {
      patch: {
        status: 'waiting',
        currentStep: args.currentStep === undefined ? record.currentStep : args.currentStep,
        stateJson: args.stateJson === undefined ? record.stateJson : args.stateJson,
        waitJson: args.waitJson || {},
        blockedSummary: null,
      },
      event: { type: 'flow_waiting', reason: args.reason },
    };
  } });
}

async function blockTaskFlow(args = {}) {
  return mutateTaskFlow({ ...args, action: 'block', mutate: (record) => {
    assertMutable(record, new Set(['running', 'waiting']), 'block');
    return {
      patch: {
        status: 'blocked',
        currentStep: args.currentStep === undefined ? record.currentStep : args.currentStep,
        stateJson: args.stateJson === undefined ? record.stateJson : args.stateJson,
        waitJson: args.waitJson === undefined ? record.waitJson : args.waitJson,
        blockedSummary: args.blockedSummary || 'Task flow is blocked.',
      },
      event: { type: 'flow_blocked', reason: args.blockedSummary },
    };
  } });
}

async function resumeTaskFlow(args = {}) {
  return mutateTaskFlow({ ...args, action: 'resume', mutate: (record) => {
    assertMutable(record, new Set(['waiting', 'blocked']), 'resume');
    return {
      patch: {
        status: 'running',
        currentStep: args.currentStep === undefined ? record.currentStep : args.currentStep,
        stateJson: args.stateJson === undefined ? record.stateJson : args.stateJson,
        waitJson: null,
        blockedSummary: null,
      },
      event: { type: 'flow_resumed' },
    };
  } });
}

async function finishTaskFlow(args = {}) {
  return mutateTaskFlow({ ...args, action: 'finish', mutate: (record) => {
    assertMutable(record, new Set(['running', 'waiting', 'blocked']), 'finish');
    return {
      patch: {
        status: 'completed',
        currentStep: args.currentStep === undefined ? record.currentStep : args.currentStep,
        stateJson: args.stateJson === undefined ? record.stateJson : args.stateJson,
        waitJson: null,
        blockedSummary: null,
      },
      event: { type: 'flow_completed' },
    };
  } });
}

async function failTaskFlow(args = {}) {
  return mutateTaskFlow({ ...args, action: 'fail', mutate: (record) => {
    assertMutable(record, ACTIVE_STATUSES, 'fail');
    return {
      patch: {
        status: 'failed',
        stateJson: args.stateJson === undefined ? record.stateJson : args.stateJson,
        waitJson: null,
        blockedSummary: args.reason || record.blockedSummary,
      },
      event: { type: 'flow_failed', reason: args.reason },
    };
  } });
}

async function requestTaskFlowCancel(args = {}) {
  return mutateTaskFlow({ ...args, action: 'request_cancel', mutate: (record) => {
    assertMutable(record, ACTIVE_STATUSES, 'request cancellation for');
    return {
      patch: { status: 'cancel_requested', blockedSummary: args.reason || record.blockedSummary },
      event: { type: 'flow_cancel_requested', reason: args.reason },
    };
  } });
}

async function cancelTaskFlow(args = {}) {
  return mutateTaskFlow({ ...args, action: 'cancel', mutate: (record) => {
    assertMutable(record, ACTIVE_STATUSES, 'cancel');
    return {
      patch: { status: 'cancelled', waitJson: null, blockedSummary: args.reason || record.blockedSummary },
      event: { type: 'flow_cancelled', reason: args.reason },
    };
  } });
}

async function linkTaskFlowChild(args = {}) {
  return mutateTaskFlow({ ...args, action: 'link_task', mutate: (record) => {
    assertMutable(record, ACTIVE_STATUSES, 'link a task to');
    const child = normalizeChildTask(args.childTask);
    const children = [...record.childTasks];
    const existingIndex = children.findIndex((item) => item.taskId === child.taskId);
    if (existingIndex >= 0) children.splice(existingIndex, 1, { ...children[existingIndex], ...child });
    else {
      if (children.length >= MAX_CHILD_TASKS) {
        throw new TaskFlowError('child_limit', `task flow supports at most ${MAX_CHILD_TASKS} child tasks`);
      }
      children.push(child);
    }
    return {
      patch: { childTasks: children },
      event: { type: existingIndex >= 0 ? 'flow_child_updated' : 'flow_child_linked', taskId: child.taskId },
    };
  } });
}

function summarizeTaskFlow(record) {
  return {
    flowId: record.flowId,
    goal: record.goal,
    status: record.status,
    currentStep: record.currentStep,
    revision: record.revision,
    childTaskCount: record.childTasks.length,
    blockedSummary: record.blockedSummary,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
  };
}

module.exports = {
  ACTIVE_STATUSES,
  ALL_STATUSES,
  LOCK_TIMEOUT_MS,
  MAX_CHILD_TASKS,
  MAX_EVENTS,
  MAX_STATE_CHARS,
  STORE_VERSION,
  TERMINAL_STATUSES,
  TaskFlowError,
  blockTaskFlow,
  cancelTaskFlow,
  createManagedTaskFlow,
  finishTaskFlow,
  getTaskFlowForUser,
  getTaskFlowStoreDir,
  linkTaskFlowChild,
  listTaskFlowsForUser,
  mutateTaskFlow,
  normalizeFlowId,
  readTaskFlow,
  requestTaskFlowCancel,
  resumeTaskFlow,
  sanitizeFlowRecord,
  setTaskFlowWaiting,
  summarizeTaskFlow,
  failTaskFlow,
};

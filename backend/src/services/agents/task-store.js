/**
 * Durable task store for long-running agent tasks.
 *
 * The in-memory ACTIVE_AGENT_TASKS map is necessary for live cancellation,
 * but it is not enough for 2-5 hour work: browser reloads, SSE disconnects
 * and process restarts must still leave an inspectable task trace. This
 * store writes compact task snapshots atomically to disk. It deliberately
 * has no database dependency so it works in local/dev and CI without a
 * migration, while keeping a stable interface that can be backed by Postgres
 * later.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EVENT_LIMIT = 1000;

function getTaskStoreDir() {
  return process.env.AGENT_TASK_STORE_DIR
    || path.join(process.cwd(), 'uploads', 'agent-tasks');
}

function ensureDir() {
  const dir = getTaskStoreDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeTaskId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 120);
}

function snapshotPathFor(taskId) {
  const clean = safeTaskId(taskId);
  if (!clean) throw new Error('task-store: taskId is required');
  return path.join(ensureDir(), `${clean}.json`);
}

function nowIso() {
  return new Date().toISOString();
}

function trimEvents(events, limit = DEFAULT_EVENT_LIMIT) {
  const list = Array.isArray(events) ? events : [];
  if (list.length <= limit) return list;
  return list.slice(list.length - limit);
}

function sanitizeTaskRecord(record = {}) {
  const now = nowIso();
  return {
    taskId: String(record.taskId || ''),
    userId: String(record.userId || ''),
    chatId: record.chatId || null,
    assistantMessageId: record.assistantMessageId || null,
    displayGoal: String(record.displayGoal || '').slice(0, 4000),
    model: record.model || null,
    status: record.status || 'running',
    createdAt: record.createdAt || now,
    updatedAt: record.updatedAt || now,
    cancelledAt: record.cancelledAt || null,
    completedAt: record.completedAt || null,
    failedAt: record.failedAt || null,
    maxSteps: record.maxSteps || null,
    maxRuntimeMs: record.maxRuntimeMs || null,
    streamState: record.streamState || { steps: [], artifacts: [], finalText: '', done: false },
    executionProfile: record.executionProfile || null,
    intentAlignmentProfile: record.intentAlignmentProfile || null,
    taskPlan: record.taskPlan || null,
    universalTaskContract: record.universalTaskContract || null,
    enterpriseExecutionGraph: record.enterpriseExecutionGraph || null,
    enterpriseRuntimeProfile: record.enterpriseRuntimeProfile || null,
    enterpriseToolRuntimePlan: record.enterpriseToolRuntimePlan || null,
    enterpriseQaBoardReview: record.enterpriseQaBoardReview || null,
    durableExecution: record.durableExecution || null,
    events: trimEvents(record.events, record.eventLimit || DEFAULT_EVENT_LIMIT),
    stats: record.stats || null,
    artifacts: record.artifacts || [],
    checkpoints: trimEvents(record.checkpoints, 200),
  };
}

function atomicWriteJson(filePath, payload) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, filePath);
}

function writeTaskSnapshot(record) {
  const snapshot = sanitizeTaskRecord(record);
  if (!snapshot.taskId) throw new Error('task-store: taskId is required');
  if (!snapshot.userId) throw new Error('task-store: userId is required');
  snapshot.updatedAt = snapshot.updatedAt || nowIso();
  atomicWriteJson(snapshotPathFor(snapshot.taskId), snapshot);
  return snapshot;
}

function readTaskSnapshot(taskId) {
  try {
    const file = snapshotPathFor(taskId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function getTaskSnapshotForUser(taskId, userId) {
  const snapshot = readTaskSnapshot(taskId);
  if (!snapshot || String(snapshot.userId) !== String(userId || '')) return null;
  return snapshot;
}

function updateTaskSnapshot(taskId, userId, patch = {}) {
  const existing = getTaskSnapshotForUser(taskId, userId);
  if (!existing) return null;
  const next = sanitizeTaskRecord({
    ...existing,
    ...patch,
    updatedAt: patch.updatedAt || nowIso(),
    events: patch.events || existing.events,
    checkpoints: patch.checkpoints || existing.checkpoints,
  });
  atomicWriteJson(snapshotPathFor(taskId), next);
  return next;
}

function appendTaskEvent(snapshotLike, event, streamState, options = {}) {
  if (!snapshotLike?.taskId || !snapshotLike?.userId || !event) return null;
  const existing = getTaskSnapshotForUser(snapshotLike.taskId, snapshotLike.userId)
    || sanitizeTaskRecord(snapshotLike);
  const stamped = {
    ...event,
    ts: event.ts || nowIso(),
  };
  const events = trimEvents([...(existing.events || []), stamped], options.eventLimit || DEFAULT_EVENT_LIMIT);
  const checkpoints = [...(existing.checkpoints || [])];
  if (shouldCheckpoint(stamped)) {
    checkpoints.push({
      ts: stamped.ts,
      type: stamped.type,
      status: snapshotLike.status || existing.status,
      eventCount: events.length,
      stepCount: streamState?.steps?.length || existing.streamState?.steps?.length || 0,
      artifactCount: streamState?.artifacts?.length || existing.streamState?.artifacts?.length || 0,
    });
  }
  const next = {
    ...existing,
    status: snapshotLike.status || existing.status,
    assistantMessageId: snapshotLike.assistantMessageId || existing.assistantMessageId || null,
    streamState: streamState || existing.streamState,
    events,
    checkpoints: trimEvents(checkpoints, 200),
    updatedAt: nowIso(),
  };
  if (stamped.type === 'file_artifact' && stamped.artifact) {
    const current = Array.isArray(next.artifacts) ? next.artifacts : [];
    if (!current.some((artifact) => artifact.id === stamped.artifact.id)) {
      next.artifacts = [...current, stamped.artifact];
    }
  }
  return writeTaskSnapshot(next);
}

function shouldCheckpoint(event) {
  return ['meta', 'step_start', 'step_done', 'file_artifact', 'final_text', 'done', 'error'].includes(event.type);
}

function markTaskStatus(taskLike, status, patch = {}) {
  if (!taskLike?.taskId || !taskLike?.userId) return null;
  const stamp = nowIso();
  const statusPatch = { status, updatedAt: stamp, ...patch };
  if (status === 'completed') statusPatch.completedAt = patch.completedAt || stamp;
  if (status === 'cancelled') statusPatch.cancelledAt = patch.cancelledAt || stamp;
  if (status === 'error') statusPatch.failedAt = patch.failedAt || stamp;
  const existing = getTaskSnapshotForUser(taskLike.taskId, taskLike.userId);
  if (!existing) return writeTaskSnapshot({ ...taskLike, ...statusPatch });
  return updateTaskSnapshot(taskLike.taskId, taskLike.userId, statusPatch);
}

function listTaskSnapshotsForUser(userId, { limit = 50 } = {}) {
  const dir = ensureDir();
  const rows = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const snapshot = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8'));
      if (String(snapshot.userId) === String(userId || '')) rows.push(snapshot);
    } catch {
      // Ignore corrupt snapshots; individual reads will return null.
    }
  }
  return rows
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
    .slice(0, limit);
}

function pruneTaskSnapshots({ retentionMs = DEFAULT_RETENTION_MS } = {}) {
  const dir = ensureDir();
  const cutoff = Date.now() - retentionMs;
  let deleted = 0;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const full = path.join(dir, entry);
    try {
      const snapshot = JSON.parse(fs.readFileSync(full, 'utf8'));
      const updated = Date.parse(snapshot.updatedAt || snapshot.createdAt || 0);
      const running = snapshot.status === 'running';
      if (!running && Number.isFinite(updated) && updated < cutoff) {
        fs.unlinkSync(full);
        deleted++;
      }
    } catch {
      // Corrupt snapshots are unsafe to trust and safe to delete.
      fs.unlinkSync(full);
      deleted++;
    }
  }
  return { deleted };
}

module.exports = {
  DEFAULT_EVENT_LIMIT,
  DEFAULT_RETENTION_MS,
  appendTaskEvent,
  getTaskSnapshotForUser,
  getTaskStoreDir,
  listTaskSnapshotsForUser,
  markTaskStatus,
  pruneTaskSnapshots,
  readTaskSnapshot,
  safeTaskId,
  sanitizeTaskRecord,
  snapshotPathFor,
  updateTaskSnapshot,
  writeTaskSnapshot,
};

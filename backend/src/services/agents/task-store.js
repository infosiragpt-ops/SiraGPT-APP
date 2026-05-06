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
const MAX_SNAPSHOT_BYTES = 1024 * 1024; // 1 MB — compress beyond this
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_STALE_RUNNING_MS = 6 * 60 * 60 * 1000;

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
    jobId: record.jobId || null,
    queueName: record.queueName || record.queue || null,
    traceId: record.traceId || null,
    documentPolicy: record.documentPolicy || null,
    agentGoal: String(record.agentGoal || '').slice(0, 4000),
    systemContract: String(record.systemContract || '').slice(0, 4000),
    fileIds: Array.isArray(record.fileIds) ? record.fileIds.map(String).slice(0, 20) : [],
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
    agenticOperatingCore: record.agenticOperatingCore || null,
    durableExecution: record.durableExecution || null,
    events: trimEvents(record.events, record.eventLimit || DEFAULT_EVENT_LIMIT),
    lastEventSeq: Number.isFinite(Number(record.lastEventSeq)) ? Number(record.lastEventSeq) : 0,
    stats: record.stats || null,
    artifacts: record.artifacts || [],
    checkpoints: trimEvents(record.checkpoints, 200),
  };
}

function atomicWriteJson(filePath, payload) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(payload, null, 2));
    try { fs.fsyncSync(fd); } catch { /* fsync best-effort on platforms that disallow it */ }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

function writeTaskSnapshot(record) {
  const snapshot = sanitizeTaskRecord(record);
  if (!snapshot.taskId) throw new Error('task-store: taskId is required');
  if (!snapshot.userId) throw new Error('task-store: userId is required');
  snapshot.updatedAt = snapshot.updatedAt || nowIso();
  atomicWriteJson(snapshotPathFor(snapshot.taskId), snapshot);
  try { updateIndexForSnapshot(snapshot); } catch { /* index is best-effort */ }
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
  try { updateIndexForSnapshot(next); } catch { /* index is best-effort */ }
  return next;
}

function appendTaskEvent(snapshotLike, event, streamState, options = {}) {
  if (!snapshotLike?.taskId || !snapshotLike?.userId || !event) return null;
  const existing = getTaskSnapshotForUser(snapshotLike.taskId, snapshotLike.userId)
    || sanitizeTaskRecord(snapshotLike);
  const lastSeq = Number.isFinite(Number(existing.lastEventSeq))
    ? Number(existing.lastEventSeq)
    : Math.max(0, ...(existing.events || []).map((evt) => Number(evt.seq) || 0));
  const seq = Number.isFinite(Number(event.seq)) && Number(event.seq) > 0
    ? Number(event.seq)
    : lastSeq + 1;
  const stamped = {
    ...event,
    id: event.id || `${snapshotLike.taskId}:${seq}`,
    seq,
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
    lastEventSeq: seq,
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
  return ['meta', 'queue_status', 'document_policy', 'framework_status', 'human_approval_required', 'human_approval_resolved', 'checkpoint', 'quality_gate', 'repair_attempt', 'step_start', 'step_done', 'file_artifact', 'final_text', 'done', 'error'].includes(event.type);
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

// ── Fast user-index ─────────────────────────────────────────────
// Maintains _index.json so listTaskSnapshotsForUser avoids scanning
// and parsing every snapshot file. The index is a map of { taskId -> { userId, status, updatedAt, createdAt } }
// and is rebuilt on write/update to stay consistent.

const INDEX_FILE = '_index.json';

function indexPath() {
  return path.join(ensureDir(), INDEX_FILE);
}

function readIndex() {
  try {
    const p = indexPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function writeIndex(index) {
  atomicWriteJson(indexPath(), index);
}

function updateIndexForSnapshot(snapshot) {
  if (!snapshot?.taskId || !snapshot?.userId) return;
  const index = readIndex();
  index[snapshot.taskId] = {
    userId: snapshot.userId,
    status: snapshot.status || 'running',
    createdAt: snapshot.createdAt || snapshot.updatedAt || new Date().toISOString(),
    updatedAt: snapshot.updatedAt || snapshot.createdAt || new Date().toISOString(),
  };
  writeIndex(index);
}

function removeFromIndex(taskId) {
  const index = readIndex();
  delete index[taskId];
  writeIndex(index);
}

function rebuildIndex() {
  const dir = ensureDir();
  const index = {};
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json') || entry === INDEX_FILE) continue;
    try {
      const snapshot = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8'));
      if (snapshot.taskId && snapshot.userId) {
        index[snapshot.taskId] = {
          userId: snapshot.userId,
          status: snapshot.status || 'running',
          createdAt: snapshot.createdAt || snapshot.updatedAt || '',
          updatedAt: snapshot.updatedAt || snapshot.createdAt || '',
        };
      }
    } catch {
      // skip corrupt
    }
  }
  writeIndex(index);
  return index;
}

// ── List & prune ────────────────────────────────────────────────

function listTaskSnapshotsForUser(userId, { limit = 50, useIndex = true } = {}) {
  const dir = ensureDir();
  const rows = [];

  if (useIndex) {
    // Fast path: read the index, then load only matching snapshots
    const index = readIndex();
    const matching = Object.entries(index)
      .filter(([, meta]) => String(meta.userId) === String(userId || ''))
      .sort((a, b) => Date.parse(b[1].updatedAt || 0) - Date.parse(a[1].updatedAt || 0))
      .slice(0, limit);
    for (const [taskId] of matching) {
      const snapshot = readTaskSnapshot(taskId);
      if (snapshot) rows.push(snapshot);
    }
    return rows;
  }

  // Slow path: scan directory (fallback if index is missing/corrupt)
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json') || entry === INDEX_FILE) continue;
    try {
      const snapshot = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8'));
      if (String(snapshot.userId) === String(userId || '')) rows.push(snapshot);
    } catch {
      // Ignore corrupt snapshots
    }
  }
  return rows
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
    .slice(0, limit);
}

function pruneTaskSnapshots({
  retentionMs = DEFAULT_RETENTION_MS,
  maxFiles = DEFAULT_MAX_FILES,
} = {}) {
  const dir = ensureDir();
  const cutoff = Date.now() - retentionMs;
  let deleted = 0;
  let deletedCorrupt = 0;
  let deletedOverflow = 0;
  const survivors = [];

  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json') || entry === INDEX_FILE) continue;
    const full = path.join(dir, entry);
    try {
      const snapshot = JSON.parse(fs.readFileSync(full, 'utf8'));
      const updated = Date.parse(snapshot.updatedAt || snapshot.createdAt || 0);
      const running = snapshot.status === 'running' || snapshot.status === 'queued';
      if (!running && Number.isFinite(updated) && updated < cutoff) {
        fs.unlinkSync(full);
        removeFromIndex(snapshot.taskId);
        deleted++;
        continue;
      }
      survivors.push({ full, taskId: snapshot.taskId, updatedAt: Number.isFinite(updated) ? updated : 0, running });
    } catch {
      try { fs.unlinkSync(full); } catch { /* ignore */ }
      deleted++;
      deletedCorrupt++;
    }
  }

  // Size-cap: if too many snapshots remain, drop the oldest non-running
  // ones. Running/queued tasks are preserved even past the cap so live
  // work isn't destroyed; the cap is best-effort.
  if (Number.isFinite(maxFiles) && survivors.length > maxFiles) {
    const overflow = survivors
      .filter((row) => !row.running)
      .sort((a, b) => a.updatedAt - b.updatedAt);
    let toRemove = survivors.length - maxFiles;
    for (const row of overflow) {
      if (toRemove <= 0) break;
      try {
        fs.unlinkSync(row.full);
        removeFromIndex(row.taskId);
        deleted++;
        deletedOverflow++;
        toRemove--;
      } catch { /* ignore */ }
    }
  }

  return { deleted, deletedCorrupt, deletedOverflow };
}

function getTaskStoreStats() {
  const dir = ensureDir();
  const stats = {
    dir,
    totalFiles: 0,
    totalBytes: 0,
    byStatus: {},
    oldestUpdatedAt: null,
    newestUpdatedAt: null,
  };
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json') || entry === INDEX_FILE) continue;
    const full = path.join(dir, entry);
    try {
      const stat = fs.statSync(full);
      stats.totalFiles++;
      stats.totalBytes += stat.size;
      const snapshot = JSON.parse(fs.readFileSync(full, 'utf8'));
      const status = snapshot.status || 'unknown';
      stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
      const updatedAt = Date.parse(snapshot.updatedAt || snapshot.createdAt || 0);
      if (Number.isFinite(updatedAt)) {
        if (!stats.oldestUpdatedAt || updatedAt < stats.oldestUpdatedAt) stats.oldestUpdatedAt = updatedAt;
        if (!stats.newestUpdatedAt || updatedAt > stats.newestUpdatedAt) stats.newestUpdatedAt = updatedAt;
      }
    } catch {
      stats.byStatus.corrupt = (stats.byStatus.corrupt || 0) + 1;
    }
  }
  return stats;
}

function findStaleRunningTasks({ staleAfterMs = DEFAULT_STALE_RUNNING_MS } = {}) {
  const dir = ensureDir();
  const cutoff = Date.now() - staleAfterMs;
  const stale = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json') || entry === INDEX_FILE) continue;
    try {
      const snapshot = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8'));
      if (snapshot.status !== 'running' && snapshot.status !== 'queued') continue;
      const updatedAt = Date.parse(snapshot.updatedAt || snapshot.createdAt || 0);
      if (!Number.isFinite(updatedAt) || updatedAt < cutoff) {
        stale.push({
          taskId: snapshot.taskId,
          userId: snapshot.userId,
          status: snapshot.status,
          updatedAt: snapshot.updatedAt || snapshot.createdAt,
          jobId: snapshot.jobId || null,
        });
      }
    } catch {
      // Corrupt snapshots are reaped by pruneTaskSnapshots, not here.
    }
  }
  return stale;
}

function recoverStaleRunningTasks({
  staleAfterMs = DEFAULT_STALE_RUNNING_MS,
  markAs = 'error',
  reason = 'recovered_after_restart',
} = {}) {
  const stale = findStaleRunningTasks({ staleAfterMs });
  const recovered = [];
  for (const row of stale) {
    const snapshot = readTaskSnapshot(row.taskId);
    if (!snapshot) continue;
    const stamp = nowIso();
    const seq = (Number(snapshot.lastEventSeq) || 0) + 1;
    const recoveryEvent = {
      type: 'error',
      message: `Task ${reason}; was stuck in ${snapshot.status}`,
      ts: stamp,
      seq,
      id: `${snapshot.taskId}:${seq}`,
    };
    const events = trimEvents([...(snapshot.events || []), recoveryEvent]);
    const next = sanitizeTaskRecord({
      ...snapshot,
      status: markAs,
      failedAt: markAs === 'error' ? stamp : snapshot.failedAt,
      cancelledAt: markAs === 'cancelled' ? stamp : snapshot.cancelledAt,
      updatedAt: stamp,
      events,
      lastEventSeq: seq,
      streamState: { ...(snapshot.streamState || {}), done: true, error: reason },
    });
    atomicWriteJson(snapshotPathFor(snapshot.taskId), next);
    try { updateIndexForSnapshot(next); } catch { /* ignore */ }
    recovered.push({ taskId: snapshot.taskId, userId: snapshot.userId, previousStatus: snapshot.status });
  }
  return { recovered, count: recovered.length };
}

// ── Compression ─────────────────────────────────────────────────
// When a snapshot JSON exceeds MAX_SNAPSHOT_BYTES (1 MB),
// strip large arrays (events, checkpoints, artifacts) after retaining
// summary metadata, then compress with gzip.

function compressSnapshotBytes(rawBytes) {
  if (rawBytes.length <= MAX_SNAPSHOT_BYTES) return rawBytes;
  try {
    const parsed = JSON.parse(rawBytes.toString('utf8'));
    // Keep only essential fields + counts for large arrays
    const compressed = {
      _compressed: true,
      _originalBytes: rawBytes.length,
      taskId: parsed.taskId,
      userId: parsed.userId,
      chatId: parsed.chatId,
      status: parsed.status,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      completedAt: parsed.completedAt,
      failedAt: parsed.failedAt,
      cancelledAt: parsed.cancelledAt,
      displayGoal: parsed.displayGoal,
      model: parsed.model,
      eventCount: Array.isArray(parsed.events) ? parsed.events.length : 0,
      checkpointCount: Array.isArray(parsed.checkpoints) ? parsed.checkpoints.length : 0,
      artifactCount: Array.isArray(parsed.artifacts) ? parsed.artifacts.length : 0,
      lastEventSeq: parsed.lastEventSeq,
      stats: parsed.stats,
      // Keep last event as sample
      lastEvent: Array.isArray(parsed.events) && parsed.events.length > 0
        ? parsed.events[parsed.events.length - 1] : null,
      // Keep last checkpoint
      lastCheckpoint: Array.isArray(parsed.checkpoints) && parsed.checkpoints.length > 0
        ? parsed.checkpoints[parsed.checkpoints.length - 1] : null,
    };
    return Buffer.from(JSON.stringify(compressed));
  } catch {
    return rawBytes;
  }
}

module.exports = {
  DEFAULT_EVENT_LIMIT,
  DEFAULT_MAX_FILES,
  DEFAULT_RETENTION_MS,
  DEFAULT_STALE_RUNNING_MS,
  INDEX_FILE,
  MAX_SNAPSHOT_BYTES,
  appendTaskEvent,
  compressSnapshotBytes,
  findStaleRunningTasks,
  getTaskSnapshotForUser,
  getTaskStoreDir,
  getTaskStoreStats,
  indexPath,
  listTaskSnapshotsForUser,
  markTaskStatus,
  pruneTaskSnapshots,
  readIndex,
  readTaskSnapshot,
  rebuildIndex,
  recoverStaleRunningTasks,
  removeFromIndex,
  safeTaskId,
  sanitizeTaskRecord,
  snapshotPathFor,
  updateIndexForSnapshot,
  updateTaskSnapshot,
  writeIndex,
  writeTaskSnapshot,
};

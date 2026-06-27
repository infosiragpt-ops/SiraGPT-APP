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
const taskStorePrismaSync = require('./task-store-prisma-sync');
const {
  MAX_SIMULTANEOUS_DOCUMENTS,
} = require('../../config/document-batch-limits');

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
    fileIds: Array.isArray(record.fileIds) ? record.fileIds.map(String).slice(0, MAX_SIMULTANEOUS_DOCUMENTS) : [],
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
    openclawRuntimeProfile: record.openclawRuntimeProfile || null,
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
  try { updateIndexForSnapshot(snapshot); } catch (err) {
    // Snapshot is durable; a failed index update silently drops the task from
    // every index-backed listing/jobId lookup until a rebuild — surface it.
    console.warn('[task-store] index update failed for', snapshot.taskId, '-', err?.message || err);
  }
  taskStorePrismaSync.schedulePrismaSync(snapshot);
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
  try { updateIndexForSnapshot(next); } catch (err) {
    // A failed index update here leaves a stale index status (e.g. a task that
    // just went terminal still shows as running) — surface it.
    console.warn('[task-store] index update failed for', next.taskId, '-', err?.message || err);
  }
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
  const written = writeTaskSnapshot(next);
  taskStorePrismaSync.schedulePrismaSync(written, stamped);
  return written;
}

function shouldCheckpoint(event) {
  return ['meta', 'queue_status', 'document_policy', 'framework_status', 'human_approval_required', 'human_approval_resolved', 'checkpoint', 'quality_gate', 'repair_attempt', 'step_start', 'step_done', 'file_artifact', 'final_text', 'done', 'error'].includes(event.type);
}

const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'error', 'failed']);
const AUTO_COMPACT_EVENT_THRESHOLD = 400;
const AUTO_COMPACT_KEEP_RECENT = 150;

function markTaskStatus(taskLike, status, patch = {}) {
  if (!taskLike?.taskId || !taskLike?.userId) return null;
  const stamp = nowIso();
  const statusPatch = { status, updatedAt: stamp, ...patch };
  if (status === 'completed') statusPatch.completedAt = patch.completedAt || stamp;
  if (status === 'cancelled') statusPatch.cancelledAt = patch.cancelledAt || stamp;
  if (status === 'error') statusPatch.failedAt = patch.failedAt || stamp;
  const existing = getTaskSnapshotForUser(taskLike.taskId, taskLike.userId);
  let result;
  if (!existing) result = writeTaskSnapshot({ ...taskLike, ...statusPatch });
  else result = updateTaskSnapshot(taskLike.taskId, taskLike.userId, statusPatch);

  // Auto-compact long traces when the task reaches a terminal state.
  // The compaction runs after the status write so a crash mid-compact
  // can't lose the terminal status itself; the compaction is best-effort.
  if (result) {
    taskStorePrismaSync.schedulePrismaSync(result);
  }
  if (result && TERMINAL_STATUSES.has(status)) {
    const eventCount = Array.isArray(result.events) ? result.events.length : 0;
    if (eventCount > AUTO_COMPACT_EVENT_THRESHOLD) {
      try {
        compactSnapshotEvents(result.taskId, result.userId, { keepRecent: AUTO_COMPACT_KEEP_RECENT });
      } catch (err) {
        // Terminal status already persisted; a failed compaction just leaves the
        // snapshot growing toward MAX_SNAPSHOT_BYTES — surface why it didn't shrink.
        console.warn('[task-store] auto-compaction failed for', result.taskId, '-', err?.message || err);
      }
    }
  }
  return result;
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
    chatId: snapshot.chatId || null,
    jobId: snapshot.jobId || null,
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
          chatId: snapshot.chatId || null,
          jobId: snapshot.jobId || null,
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
      // Re-validate ownership after loading. The index is a cache that can drift
      // out of sync with the snapshot files; trusting its userId blindly would
      // leak another user's task if the index ever mapped a taskId to the wrong
      // owner. The slow path already does this check.
      if (snapshot && String(snapshot.userId) === String(userId || '')) rows.push(snapshot);
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

/**
 * Delete a task snapshot if it belongs to `userId`. Refuses to delete
 * a running/queued task unless `force` is set, so a panicked user
 * can't accidentally yank an in-flight job. Returns
 * { ok, reason? } so callers branch on stable codes.
 */
function deleteTaskSnapshot(taskId, userId, { force = false } = {}) {
  const snapshot = getTaskSnapshotForUser(taskId, userId);
  if (!snapshot) return { ok: false, reason: 'not_found_or_forbidden' };
  if (!force && (snapshot.status === 'running' || snapshot.status === 'queued')) {
    return { ok: false, reason: 'task_active' };
  }
  try {
    fs.unlinkSync(snapshotPathFor(taskId));
  } catch (err) {
    if (err.code !== 'ENOENT') return { ok: false, reason: 'unlink_failed' };
  }
  try { removeFromIndex(taskId); } catch { /* index is best-effort */ }
  return { ok: true };
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

function getTaskStoreStats({ useIndex = true } = {}) {
  const dir = ensureDir();
  const stats = {
    dir,
    totalFiles: 0,
    totalBytes: 0,
    byStatus: {},
    oldestUpdatedAt: null,
    newestUpdatedAt: null,
  };

  // Fast path: pull status + updatedAt from the index, sizes from stat().
  // Avoids parsing every snapshot JSON, which can be large after a long
  // task run. Falls back to the slow path if the index is missing.
  if (useIndex) {
    const index = readIndex();
    const indexedIds = Object.keys(index);
    if (indexedIds.length > 0) {
      for (const taskId of indexedIds) {
        const meta = index[taskId];
        const full = path.join(dir, `${safeTaskId(taskId)}.json`);
        try {
          const stat = fs.statSync(full);
          stats.totalFiles++;
          stats.totalBytes += stat.size;
        } catch {
          // Index references a snapshot that's gone — skip; rebuildIndex fixes this.
          continue;
        }
        const status = meta.status || 'unknown';
        stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
        const updatedAt = Date.parse(meta.updatedAt || meta.createdAt || 0);
        if (Number.isFinite(updatedAt)) {
          if (!stats.oldestUpdatedAt || updatedAt < stats.oldestUpdatedAt) stats.oldestUpdatedAt = updatedAt;
          if (!stats.newestUpdatedAt || updatedAt > stats.newestUpdatedAt) stats.newestUpdatedAt = updatedAt;
        }
      }
      return stats;
    }
  }

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

function listActiveTasksForChat(chatId, userId, { limit = 10 } = {}) {
  if (!chatId) return [];
  const index = readIndex();
  const active = new Set(['running', 'queued', 'planning', 'executing', 'verifying', 'shipping']);
  const matches = Object.entries(index)
    .filter(([, meta]) => String(meta.chatId || '') === String(chatId))
    .filter(([, meta]) => !userId || String(meta.userId) === String(userId))
    .filter(([, meta]) => active.has(String(meta.status || '')))
    .sort((a, b) => Date.parse(b[1].updatedAt || 0) - Date.parse(a[1].updatedAt || 0))
    .slice(0, limit);
  const rows = [];
  for (const [taskId] of matches) {
    const snapshot = readTaskSnapshot(taskId);
    if (snapshot) rows.push(snapshot);
  }
  return rows;
}

/**
 * task for the chat (a chat can host multiple sequential agent tasks).
 * Indexed lookup — no full directory scan.
 */
function getLatestTaskForChat(chatId, userId) {
  if (!chatId) return null;
  const index = readIndex();
  const candidates = Object.entries(index)
    .filter(([, meta]) => String(meta.chatId || '') === String(chatId))
    .filter(([, meta]) => !userId || String(meta.userId) === String(userId))
    .sort((a, b) => Date.parse(b[1].updatedAt || 0) - Date.parse(a[1].updatedAt || 0));
  if (!candidates.length) return null;
  return readTaskSnapshot(candidates[0][0]);
}

/**
 * Find a task snapshot by jobId (BullMQ / queue worker handle).
 * Used by queue retry logic to locate the durable trace after the
 * in-memory ACTIVE_AGENT_TASKS map is gone.
 */
function getTaskByJobId(jobId, userId) {
  if (!jobId) return null;
  const index = readIndex();
  const matches = Object.entries(index)
    .filter(([, meta]) => String(meta.jobId || '') === String(jobId)
      && (!userId || String(meta.userId) === String(userId)))
    .sort((a, b) => Date.parse(b[1].updatedAt || 0) - Date.parse(a[1].updatedAt || 0));
  if (!matches.length) return null;
  return readTaskSnapshot(matches[0][0]);
}

/**
 * Return only the running/queued tasks for a user, sorted newest-first.
 * Uses the index for an O(N_user) scan instead of reading every snapshot.
 */
function getRunningTasksForUser(userId, { limit = 50 } = {}) {
  const index = readIndex();
  const matches = Object.entries(index)
    .filter(([, meta]) => String(meta.userId) === String(userId || ''))
    .filter(([, meta]) => meta.status === 'running' || meta.status === 'queued')
    .sort((a, b) => Date.parse(b[1].updatedAt || 0) - Date.parse(a[1].updatedAt || 0))
    .slice(0, limit);
  const rows = [];
  for (const [taskId] of matches) {
    const snapshot = readTaskSnapshot(taskId);
    if (snapshot) rows.push(snapshot);
  }
  return rows;
}

/**
 * Per-user metrics: counts by status, total artifacts, recent activity.
 * Reads only the user's snapshots via the index so a single user's
 * dashboard call doesn't walk the entire store.
 */
function getUserTaskMetrics(userId, { lookbackMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  const index = readIndex();
  const userTaskIds = Object.entries(index)
    .filter(([, meta]) => String(meta.userId) === String(userId || ''))
    .map(([taskId]) => taskId);

  const since = Date.now() - lookbackMs;
  const metrics = {
    userId: String(userId || ''),
    totalTasks: 0,
    byStatus: {},
    artifactCount: 0,
    recent: { running: 0, queued: 0, completed: 0, failed: 0, cancelled: 0, error: 0 },
    avgDurationMs: null,
    lastTaskAt: null,
  };

  let totalDuration = 0;
  let durationSamples = 0;

  for (const taskId of userTaskIds) {
    const snapshot = readTaskSnapshot(taskId);
    if (!snapshot) continue;
    metrics.totalTasks++;
    const status = snapshot.status || 'unknown';
    metrics.byStatus[status] = (metrics.byStatus[status] || 0) + 1;
    metrics.artifactCount += Array.isArray(snapshot.artifacts) ? snapshot.artifacts.length : 0;

    const updated = Date.parse(snapshot.updatedAt || snapshot.createdAt || 0);
    if (Number.isFinite(updated)) {
      if (!metrics.lastTaskAt || updated > metrics.lastTaskAt) metrics.lastTaskAt = updated;
      if (updated >= since && Object.prototype.hasOwnProperty.call(metrics.recent, status)) {
        metrics.recent[status]++;
      }
    }

    const created = Date.parse(snapshot.createdAt || 0);
    const ended = Date.parse(snapshot.completedAt || snapshot.failedAt || snapshot.cancelledAt || 0);
    if (Number.isFinite(created) && Number.isFinite(ended) && ended >= created) {
      totalDuration += (ended - created);
      durationSamples++;
    }
  }

  if (durationSamples > 0) metrics.avgDurationMs = Math.round(totalDuration / durationSamples);
  return metrics;
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
  skipJobBacked = false,
  // Hard ceiling for job-backed tasks: with Redis configured, rows that
  // carry a jobId are normally left to the BullMQ worker — but a job that
  // has been "running" for this long is a zombie (no legitimate job lives
  // for a day; queue timeouts are minutes). Without a ceiling those rows
  // were skipped FOREVER: rescanned and logged on every boot while their
  // chats showed an eternal in-progress state.
  jobBackedStaleAfterMs = 24 * 60 * 60 * 1000,
} = {}) {
  const stale = findStaleRunningTasks({ staleAfterMs });
  const recovered = [];
  const skipped = [];
  const jobCutoff = Date.now() - Math.max(staleAfterMs, jobBackedStaleAfterMs);
  for (const row of stale) {
    if (skipJobBacked && row.jobId) {
      const rowUpdatedAt = Date.parse(row.updatedAt || 0);
      const withinJobGrace = Number.isFinite(rowUpdatedAt) && rowUpdatedAt >= jobCutoff;
      if (withinJobGrace) {
        skipped.push({ taskId: row.taskId, userId: row.userId, reason: 'job_backed' });
        continue;
      }
      // Beyond the hard ceiling: zombie job-backed task → recover below.
    }
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
  return { recovered, skipped, count: recovered.length, skippedCount: skipped.length };
}

/**
 * compactSnapshotEvents — drop the verbose body from old `tool_call`
 * and `tool_output` events while keeping checkpoints + the most recent
 * `keepRecent` events intact. Used post-completion to shrink long
 * traces (≥500 events of `python_exec` stdout dumps) without losing
 * the structural step timeline.
 *
 * Returns the new event count, or null if the task is missing.
 */
function compactSnapshotEvents(taskId, userId, { keepRecent = 200 } = {}) {
  const snapshot = userId
    ? getTaskSnapshotForUser(taskId, userId)
    : readTaskSnapshot(taskId);
  if (!snapshot) return null;
  if (snapshot.status === 'running' || snapshot.status === 'queued') {
    // Don't compact an active task — its event log is still being written.
    return { skipped: 'task_active', eventCount: (snapshot.events || []).length };
  }
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  if (events.length <= keepRecent) {
    return { compacted: 0, eventCount: events.length };
  }
  const cutoff = events.length - keepRecent;
  const head = events.slice(0, cutoff).map((evt) => {
    if (evt.type === 'tool_call' || evt.type === 'tool_output') {
      const { id, seq, ts, type, tool, ok } = evt;
      return { id, seq, ts, type, tool: tool || null, ok: ok ?? null, _compacted: true };
    }
    return evt;
  });
  const next = sanitizeTaskRecord({
    ...snapshot,
    events: [...head, ...events.slice(cutoff)],
    updatedAt: nowIso(),
  });
  atomicWriteJson(snapshotPathFor(snapshot.taskId), next);
  try { updateIndexForSnapshot(next); } catch { /* index is best-effort */ }
  return { compacted: cutoff, eventCount: next.events.length };
}

/**
 * Bulk-compact every terminal task whose event log has grown beyond
 * `eventThreshold`. Returns counts so a nightly cron job can log how
 * much it shrunk. Active (running/queued) tasks are skipped.
 */
function compactAllTerminalTasks({
  eventThreshold = AUTO_COMPACT_EVENT_THRESHOLD,
  keepRecent = AUTO_COMPACT_KEEP_RECENT,
} = {}) {
  const dir = ensureDir();
  const result = { scanned: 0, compacted: 0, skipped: 0, eventsDropped: 0 };
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json') || entry === INDEX_FILE) continue;
    let snapshot;
    try {
      snapshot = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8'));
    } catch {
      continue;
    }
    if (!snapshot?.taskId || !snapshot?.userId) continue;
    if (!TERMINAL_STATUSES.has(snapshot.status)) {
      result.skipped++;
      continue;
    }
    const eventCount = Array.isArray(snapshot.events) ? snapshot.events.length : 0;
    if (eventCount <= eventThreshold) {
      result.skipped++;
      continue;
    }
    result.scanned++;
    try {
      const out = compactSnapshotEvents(snapshot.taskId, snapshot.userId, { keepRecent });
      if (out && Number.isFinite(out.compacted) && out.compacted > 0) {
        result.compacted++;
        result.eventsDropped += out.compacted;
      }
    } catch { /* best effort */ }
  }
  return result;
}

/**
 * Return snapshots for any user matching one of the given statuses,
 * newest-first. Backed by the index so a bulk admin/dashboard query
 * does not parse every snapshot. `statuses` accepts a single string
 * or an array.
 */
function getTasksByStatus(statuses, { limit = 100 } = {}) {
  const set = new Set(Array.isArray(statuses) ? statuses : [statuses]);
  const index = readIndex();
  const matches = Object.entries(index)
    .filter(([, meta]) => set.has(meta.status))
    .sort((a, b) => Date.parse(b[1].updatedAt || 0) - Date.parse(a[1].updatedAt || 0))
    .slice(0, limit);
  const rows = [];
  for (const [taskId] of matches) {
    const snapshot = readTaskSnapshot(taskId);
    if (snapshot) rows.push(snapshot);
  }
  return rows;
}

// ── Orphan artifact cleanup ─────────────────────────────────────
// Artifacts saved by saveArtifact() (in task-tools.js) live in
// AGENT_ARTIFACT_DIR (uploads/agent-artifacts by default) as
// `{id}-{filename}` plus `{id}.json` metadata. When their owning
// task snapshot is pruned, those files become orphans on disk.
// This helper finds and removes them, but only after a grace
// period so an artifact that was just uploaded — and not yet
// linked into a snapshot — is not yanked from under the agent.

function getDefaultArtifactDir() {
  return process.env.AGENT_ARTIFACT_DIR
    || path.join(process.cwd(), 'uploads', 'agent-artifacts');
}

function collectReferencedArtifactIds() {
  const dir = ensureDir();
  const referenced = new Set();
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json') || entry === INDEX_FILE) continue;
    try {
      const snapshot = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8'));
      const artifacts = Array.isArray(snapshot.artifacts) ? snapshot.artifacts : [];
      for (const artifact of artifacts) {
        if (artifact && typeof artifact.id === 'string') referenced.add(artifact.id);
      }
      // file_artifact events also carry an artifact id; sweep those too.
      const events = Array.isArray(snapshot.events) ? snapshot.events : [];
      for (const evt of events) {
        if (evt?.type === 'file_artifact' && evt?.artifact?.id) referenced.add(evt.artifact.id);
      }
    } catch {
      // skip corrupt — pruneTaskSnapshots will reap it
    }
  }
  return referenced;
}

/**
 * Remove artifact files whose id is not referenced by any snapshot
 * and whose metadata createdAt is older than `graceMs`. Returns
 * { scanned, removed, freedBytes }. Best-effort: filesystem errors
 * on individual entries are swallowed so a bad permission on one
 * artifact does not abort the whole sweep.
 */
function cleanupOrphanedArtifacts({
  artifactDir = getDefaultArtifactDir(),
  graceMs = 60 * 60 * 1000,
} = {}) {
  const result = { scanned: 0, removed: 0, freedBytes: 0, missingDir: false };
  if (!fs.existsSync(artifactDir)) {
    result.missingDir = true;
    return result;
  }
  const referenced = collectReferencedArtifactIds();
  const cutoff = Date.now() - graceMs;
  const entries = fs.readdirSync(artifactDir);
  // Build id → [files] map so we can remove the metadata + payload together.
  const byId = new Map();
  for (const entry of entries) {
    // Two shapes: `{id}.json` metadata, and `{id}-{originalFilename}` payload.
    let id = null;
    if (entry.endsWith('.json') && /^[a-f0-9]{16}\.json$/.test(entry)) {
      id = entry.slice(0, 16);
    } else if (/^[a-f0-9]{16}-/.test(entry)) {
      id = entry.slice(0, 16);
    }
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(entry);
  }
  for (const [id, files] of byId) {
    result.scanned++;
    if (referenced.has(id)) continue;
    // Read metadata createdAt to honor the grace period.
    const metaName = files.find((f) => f === `${id}.json`);
    let createdAt = 0;
    if (metaName) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(artifactDir, metaName), 'utf8'));
        createdAt = Date.parse(meta.createdAt || 0) || 0;
      } catch { /* fall through, treat as unknown age */ }
    }
    // No metadata: fall back to the payload mtime so we still respect a grace window.
    if (!createdAt) {
      for (const file of files) {
        try {
          const stat = fs.statSync(path.join(artifactDir, file));
          createdAt = Math.max(createdAt, stat.mtimeMs || 0);
        } catch { /* ignore */ }
      }
    }
    if (createdAt && createdAt > cutoff) continue;
    for (const file of files) {
      const full = path.join(artifactDir, file);
      try {
        const stat = fs.statSync(full);
        fs.unlinkSync(full);
        result.removed++;
        result.freedBytes += stat.size || 0;
      } catch { /* best effort */ }
    }
  }
  return result;
}

/**
 * Verify a snapshot file is parseable and carries the minimum
 * structural fields. Useful for repair/health endpoints. Returns
 * { ok, taskId, problems[] } where problems is an array of stable
 * string codes ('missing_userId', 'invalid_status', ...).
 */
function verifySnapshotIntegrity(taskId, { index } = {}) {
  const problems = [];
  let snapshot = null;
  try {
    const p = snapshotPathFor(taskId);
    if (!fs.existsSync(p)) return { ok: false, taskId, problems: ['file_missing'] };
    const raw = fs.readFileSync(p, 'utf8');
    snapshot = JSON.parse(raw);
  } catch (err) {
    return { ok: false, taskId, problems: ['unreadable_or_corrupt'] };
  }
  if (!snapshot.taskId) problems.push('missing_taskId');
  if (!snapshot.userId) problems.push('missing_userId');
  if (snapshot.taskId && snapshot.taskId !== taskId) problems.push('taskId_mismatch');
  const validStatuses = new Set(['running', 'queued', 'completed', 'cancelled', 'error', 'failed']);
  if (!validStatuses.has(snapshot.status)) problems.push('invalid_status');
  if (snapshot.events && !Array.isArray(snapshot.events)) problems.push('events_not_array');
  if (snapshot.artifacts && !Array.isArray(snapshot.artifacts)) problems.push('artifacts_not_array');
  // Cross-check the index agrees on userId/status, when an index entry exists.
  try {
    const idx = index || readIndex();
    const idxEntry = idx[taskId];
    if (idxEntry) {
      if (String(idxEntry.userId) !== String(snapshot.userId)) problems.push('index_user_mismatch');
      if (String(idxEntry.status) !== String(snapshot.status)) problems.push('index_status_mismatch');
    }
  } catch { /* index missing/corrupt is its own concern */ }
  return { ok: problems.length === 0, taskId, problems };
}

/**
 * Run verifySnapshotIntegrity over every snapshot file. Returns
 * { total, healthy, broken: [{ taskId, problems[] }...] }. Used by
 * an admin health endpoint to surface drift between snapshots and
 * the index without reading every JSON twice from the caller side.
 */
function verifyAllSnapshots() {
  const dir = ensureDir();
  const broken = [];
  let total = 0;
  // Read the index once for the whole scan (it's stable for the duration) and
  // pass it down, instead of re-reading + re-parsing _index.json per snapshot.
  let index = {};
  try { index = readIndex(); } catch { index = {}; }
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json') || entry === INDEX_FILE) continue;
    const taskId = entry.slice(0, -5);
    total++;
    const result = verifySnapshotIntegrity(taskId, { index });
    if (!result.ok) broken.push({ taskId, problems: result.problems });
  }
  return { total, healthy: total - broken.length, broken };
}

/**
 * Run prune + orphan-artifact cleanup back-to-back. The two sweeps
 * are normally scheduled together (nightly cron); this wrapper saves
 * callers from having to coordinate the order (prune first, so newly
 * orphaned artifact ids are visible to the cleanup pass).
 */
function pruneAndCleanup({
  retentionMs = DEFAULT_RETENTION_MS,
  maxFiles = DEFAULT_MAX_FILES,
  artifactDir,
  graceMs = 60 * 60 * 1000,
} = {}) {
  const prune = pruneTaskSnapshots({ retentionMs, maxFiles });
  const cleanup = cleanupOrphanedArtifacts({
    ...(artifactDir ? { artifactDir } : {}),
    graceMs,
  });
  return { prune, cleanup };
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
  cleanupOrphanedArtifacts,
  collectReferencedArtifactIds,
  compactAllTerminalTasks,
  compactSnapshotEvents,
  compressSnapshotBytes,
  deleteTaskSnapshot,
  findStaleRunningTasks,
  getLatestTaskForChat,
  listActiveTasksForChat,
  getRunningTasksForUser,
  getTaskByJobId,
  getTaskSnapshotForUser,
  getTaskStoreDir,
  getTaskStoreStats,
  getTasksByStatus,
  getUserTaskMetrics,
  indexPath,
  listTaskSnapshotsForUser,
  markTaskStatus,
  pruneAndCleanup,
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
  verifyAllSnapshots,
  verifySnapshotIntegrity,
  writeIndex,
  writeTaskSnapshot,
};

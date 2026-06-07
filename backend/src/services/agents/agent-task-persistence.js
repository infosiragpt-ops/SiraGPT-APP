const prisma = (() => {
  try { return require('../../config/database'); } catch { return null; }
})();

function hasModel(name) {
  return Boolean(prisma && prisma[name]);
}

function safeJson(value, fallback = null) {
  if (value === undefined) return fallback;
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return fallback;
  }
}

function withoutImmutableFields(data = {}) {
  const clone = { ...data };
  delete clone.id;
  return clone;
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(String(status || ''));
}

function statusFromEvent(event = {}, fallback = 'running') {
  if (event.type === 'done') {
    return event.stoppedReason === 'aborted' ? 'cancelled' : 'completed';
  }
  if (event.type === 'error') {
    return String(fallback || '') === 'cancelled' ? 'cancelled' : 'failed';
  }
  return fallback || 'running';
}

function stateFromEvent(state, event = {}) {
  if (event.type === 'done') {
    return {
      ...(state || {}),
      done: true,
      stoppedReason: event.stoppedReason || state?.stoppedReason || 'done',
    };
  }
  if (event.type === 'error') {
    return {
      ...(state || {}),
      done: true,
      error: event.message || state?.error || 'Agent task failed',
    };
  }
  return state;
}

function withTerminalTimestamps(data = {}, task = {}) {
  const now = new Date();
  const next = { ...data };
  if (next.status === 'completed' && !next.completedAt) {
    next.completedAt = task.completedAt ? new Date(task.completedAt) : now;
  }
  if (next.status === 'cancelled' && !next.cancelledAt) {
    next.cancelledAt = task.cancelledAt ? new Date(task.cancelledAt) : now;
  }
  if (next.status === 'failed' && !next.failedAt) {
    next.failedAt = task.failedAt ? new Date(task.failedAt) : now;
  }
  return next;
}

async function updateExistingAgentTask(where, data) {
  const updateData = withoutImmutableFields(data);
  const guardedWhere = isTerminalStatus(data.status)
    ? where
    : { ...where, status: { notIn: Array.from(TERMINAL_STATUSES) } };

  const result = await prisma.agentTask.updateMany({
    where: guardedWhere,
    data: updateData,
  });
  if (result.count > 0) {
    return prisma.agentTask.findFirst({ where });
  }

  // A terminal row may already have been written by a later async
  // persistence call. Return it without downgrading it back to running.
  return prisma.agentTask.findFirst({ where });
}

function buildExistingTaskLookup(data = {}) {
  const id = data.id ? String(data.id) : '';
  const jobId = data.jobId ? String(data.jobId) : '';
  if (id && jobId && id !== jobId) {
    return { OR: [{ id }, { jobId }] };
  }
  if (id) return { id };
  if (jobId) return { jobId };
  return {};
}

async function upsertAgentTask(task = {}) {
  if (!hasModel('agentTask') || !task.taskId || !task.userId) return null;
  const data = withTerminalTimestamps({
    id: String(task.taskId),
    userId: String(task.userId),
    chatId: task.chatId || null,
    jobId: task.jobId ? String(task.jobId) : null,
    status: task.status || 'queued',
    goal: String(task.displayGoal || task.goal || '').slice(0, 4000),
    model: task.model || null,
    traceId: task.traceId || null,
    documentPolicy: safeJson(task.documentPolicy || task.streamState?.documentPolicy),
    state: safeJson(task.state || task.streamState),
    completedAt: task.completedAt ? new Date(task.completedAt) : null,
    cancelledAt: task.cancelledAt ? new Date(task.cancelledAt) : null,
    failedAt: task.failedAt ? new Date(task.failedAt) : null,
  }, task);
  try {
    // Avoid the classic find-then-create race. Several durable event
    // writers can persist the same freshly queued task concurrently; a
    // preflight findFirst() lets all of them observe "missing", then all
    // but one create() fail with P2002 and Prisma logs a noisy error. A
    // skip-duplicates insert is idempotent at the database boundary.
    if (typeof prisma.agentTask.createMany === 'function') {
      const created = await prisma.agentTask.createMany({
        data: [data],
        skipDuplicates: true,
      });
      if (created?.count > 0) {
        return await prisma.agentTask.findFirst({ where: { id: data.id } });
      }
    }

    const existing = await prisma.agentTask.findFirst({
      where: buildExistingTaskLookup(data),
      select: { id: true },
    });
    if (existing?.id) {
      return await updateExistingAgentTask({ id: existing.id }, data);
    }
    return await prisma.agentTask.create({ data });
  } catch (err) {
    if (err?.code === 'P2002') {
      try {
        const byId = await updateExistingAgentTask({ id: data.id }, data);
        if (byId) return byId;
        if (data.jobId) {
          return await updateExistingAgentTask({ jobId: data.jobId }, data);
        }
      } catch (fallbackErr) {
        if (process.env.NODE_ENV !== 'test') {
          console.warn('[agent-task-persistence] update existing skipped:', fallbackErr?.message || fallbackErr);
        }
        return null;
      }
    }
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[agent-task-persistence] upsert skipped:', err?.message || err);
    }
    return null;
  }
}

async function appendAgentTaskEvent(task = {}, event = {}) {
  if (!hasModel('agentTaskEvent') || !task.taskId || !event.type) return null;
  const seq = Number(event.seq) || Number(task.lastEventSeq) || 0;
  if (!seq) return null;
  try {
    const status = statusFromEvent(event, task.status || 'running');
    const state = stateFromEvent(task.state || task.streamState, event);
    const parent = await upsertAgentTask({
      ...task,
      status,
      state,
    });
    if (!parent) return null;
    const taskId = String(parent?.id || task.taskId);
    return await prisma.agentTaskEvent.upsert({
      where: { taskId_seq: { taskId, seq } },
      create: {
        taskId,
        seq,
        type: String(event.type),
        payload: safeJson(event, {}),
      },
      update: {
        type: String(event.type),
        payload: safeJson(event, {}),
      },
    });
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[agent-task-persistence] event skipped:', err?.message || err);
    }
    return null;
  }
}

async function persistGeneratedArtifact({
  artifact,
  task,
  messageId = null,
  previewHtml = null,
  validation = null,
} = {}) {
  if (!hasModel('generatedArtifact') || !artifact?.id || !task?.userId) return null;
  try {
    const filename = String(artifact.filename || 'artifact');
    const format = filename.includes('.') ? filename.split('.').pop().toLowerCase() : 'bin';
    return await prisma.generatedArtifact.upsert({
      where: { id: String(artifact.id) },
      create: {
        id: String(artifact.id),
        userId: String(task.userId),
        taskId: task.taskId || null,
        chatId: task.chatId || null,
        messageId,
        filename,
        mime: artifact.mime || 'application/octet-stream',
        format,
        path: artifact.path || null,
        sizeBytes: Number(artifact.sizeBytes) || 0,
        previewHtml,
        validation: safeJson(validation || artifact.validation),
      },
      update: {
        messageId,
        previewHtml,
        validation: safeJson(validation || artifact.validation),
      },
    });
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[agent-task-persistence] artifact skipped:', err?.message || err);
    }
    return null;
  }
}

/**
 * recoverOrphanedAgentTasks — find tasks left in non-terminal status
 * (running/queued) whose updatedAt is older than `staleAfterMs`, and
 * mark them as failed (or cancelled) with a recovery reason. Safe to
 * call at process startup; no-ops cleanly when prisma is unavailable.
 */
async function recoverOrphanedAgentTasks({
  staleAfterMs = 6 * 60 * 60 * 1000,
  markAs = 'failed',
  reason = 'recovered_after_restart',
  limit = 200,
} = {}) {
  if (!hasModel('agentTask')) return { recovered: 0, scanned: 0 };
  const cutoff = new Date(Date.now() - staleAfterMs);
  try {
    const stale = await prisma.agentTask.findMany({
      where: {
        status: { in: ['running', 'queued'] },
        updatedAt: { lt: cutoff },
      },
      take: Math.max(1, Math.min(Number(limit) || 200, 1000)),
      select: { id: true, userId: true, status: true, updatedAt: true, state: true },
    });
    if (!stale.length) return { recovered: 0, scanned: 0 };

    const now = new Date();
    const data = withTerminalTimestamps({
      status: markAs,
      updatedAt: now,
    }, { failedAt: now, cancelledAt: now, completedAt: now });

    const ids = stale.map((row) => row.id);
    const result = await prisma.agentTask.updateMany({
      where: { id: { in: ids }, status: { in: ['running', 'queued'] } },
      data: { ...data, state: safeJson({ recovered: true, reason }) },
    });
    return {
      recovered: result.count,
      scanned: stale.length,
      ids,
      reason,
    };
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[agent-task-persistence] orphan recovery skipped:', err?.message || err);
    }
    return { recovered: 0, scanned: 0, error: err?.message || String(err) };
  }
}

/**
 * archiveCompletedAgentTasks — strip the verbose `state` blob from
 * tasks completed/failed/cancelled longer than `olderThanMs` ago.
 * Keeps the row (status, timestamps, goal, traceId) for audit while
 * reclaiming the JSON column. No-ops cleanly when prisma is missing.
 */
async function archiveCompletedAgentTasks({
  olderThanMs = 7 * 24 * 60 * 60 * 1000,
  limit = 500,
} = {}) {
  if (!hasModel('agentTask')) return { archived: 0, scanned: 0 };
  const cutoff = new Date(Date.now() - olderThanMs);
  try {
    const stale = await prisma.agentTask.findMany({
      where: {
        status: { in: Array.from(TERMINAL_STATUSES) },
        updatedAt: { lt: cutoff },
        NOT: { state: { equals: null } },
      },
      take: Math.max(1, Math.min(Number(limit) || 500, 5000)),
      select: { id: true },
    });
    if (!stale.length) return { archived: 0, scanned: 0 };

    const ids = stale.map((row) => row.id);
    const result = await prisma.agentTask.updateMany({
      where: { id: { in: ids } },
      data: { state: safeJson({ archived: true, archivedAt: new Date().toISOString() }) },
    });
    return { archived: result.count, scanned: stale.length };
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[agent-task-persistence] archive skipped:', err?.message || err);
    }
    return { archived: 0, scanned: 0, error: err?.message || String(err) };
  }
}

/**
 * purgeOrphanedArtifacts — remove generatedArtifact rows whose
 * parent agentTask no longer exists. Catches the "task pruned but
 * artifact rows lingered" leak that accumulates after months of
 * archive runs. `dryRun` returns the would-purge ids without
 * deleting; defaults to a non-destructive run so an operator can
 * inspect first.
 */
async function purgeOrphanedArtifacts({
  limit = 500,
  dryRun = true,
} = {}) {
  if (!hasModel('generatedArtifact')) return { purged: 0, candidates: [] };
  try {
    const rows = await prisma.generatedArtifact.findMany({
      where: { taskId: { not: null } },
      take: Math.max(1, Math.min(Number(limit) || 500, 5000)),
      select: { id: true, taskId: true },
    });
    if (!rows.length) return { purged: 0, candidates: [] };

    const taskIds = Array.from(new Set(rows.map((row) => row.taskId).filter(Boolean)));
    const livingTasks = hasModel('agentTask')
      ? await prisma.agentTask.findMany({
          where: { id: { in: taskIds } },
          select: { id: true },
        })
      : [];
    const livingIds = new Set(livingTasks.map((row) => row.id));
    const orphans = rows.filter((row) => row.taskId && !livingIds.has(row.taskId));

    if (dryRun || orphans.length === 0) {
      return { purged: 0, dryRun, candidates: orphans.map((row) => row.id) };
    }

    const result = await prisma.generatedArtifact.deleteMany({
      where: { id: { in: orphans.map((row) => row.id) } },
    });
    return { purged: result.count, dryRun: false, candidates: orphans.map((row) => row.id) };
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[agent-task-persistence] artifact purge skipped:', err?.message || err);
    }
    return { purged: 0, candidates: [], error: err?.message || String(err) };
  }
}

module.exports = {
  appendAgentTaskEvent,
  archiveCompletedAgentTasks,
  purgeOrphanedArtifacts,
  persistGeneratedArtifact,
  recoverOrphanedAgentTasks,
  upsertAgentTask,
  INTERNAL: {
    buildExistingTaskLookup,
    isTerminalStatus,
    stateFromEvent,
    statusFromEvent,
    withTerminalTimestamps,
  },
};

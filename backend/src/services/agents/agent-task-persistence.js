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

module.exports = {
  appendAgentTaskEvent,
  persistGeneratedArtifact,
  recoverOrphanedAgentTasks,
  upsertAgentTask,
  INTERNAL: {
    isTerminalStatus,
    stateFromEvent,
    statusFromEvent,
    withTerminalTimestamps,
  },
};

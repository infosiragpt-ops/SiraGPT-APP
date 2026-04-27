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

async function upsertAgentTask(task = {}) {
  if (!hasModel('agentTask') || !task.taskId || !task.userId) return null;
  const data = {
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
  };
  try {
    return await prisma.agentTask.upsert({
      where: { id: data.id },
      create: data,
      update: data,
    });
  } catch (err) {
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
    return await prisma.agentTaskEvent.upsert({
      where: { taskId_seq: { taskId: String(task.taskId), seq } },
      create: {
        taskId: String(task.taskId),
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

module.exports = {
  appendAgentTaskEvent,
  persistGeneratedArtifact,
  upsertAgentTask,
};

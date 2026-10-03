'use strict';

const { buildAgentHistoryBlock } = require('./conversation-history');

const MAX_HISTORY_MESSAGES = 80;

function unavailable() {
  const error = new Error('No pude recuperar el contexto de esta conversación. Reintenta antes de generar el archivo.');
  error.code = 'E_HISTORY_UNAVAILABLE';
  return error;
}

/** Owner-scoped source for both inline and durable /agent/task consumers. */
async function loadTaskConversationHistory(prisma, { userId, chatId, taskId, before } = {}) {
  if (!chatId) return '';
  if (!userId || !prisma?.chat?.findFirst || !prisma?.message?.findMany
    || (taskId && !prisma?.message?.findFirst)) throw unavailable();
  const beforeTime = before == null ? Infinity : new Date(before).getTime();
  if (!Number.isFinite(beforeTime) && before != null) throw unavailable();
  let chat, anchor, rows;
  try {
    chat = await prisma.chat.findFirst({
      where: { id: String(chatId), userId: String(userId), deletedAt: null },
      select: {
        id: true,
        contextSummary: true,
        contextSummaryUntil: true,
      },
    });
    if (!chat) throw unavailable();
    const owner = { userId: String(userId), deletedAt: null };
    // Locate the anchor independently of the bounded history. A durable task
    // can wait behind more than 80 later messages; the latest rows cannot
    // tell us where its original request began.
    if (taskId) {
      anchor = await prisma.message.findFirst({
        where: {
          chatId: String(chatId), chat: owner, role: 'USER', deletedAt: null,
          metadata: { path: ['taskId'], equals: String(taskId) },
        },
        orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
        select: { id: true, timestamp: true },
      });
      if (!anchor?.id || !Number.isFinite(new Date(anchor.timestamp).getTime())) throw unavailable();
    }
    const summaryTime = chat.contextSummary && chat.contextSummaryUntil
      ? new Date(chat.contextSummaryUntil).getTime() : -Infinity;
    const cutoff = Math.min(beforeTime, anchor ? new Date(anchor.timestamp).getTime() : Infinity);
    if (summaryTime >= cutoff) throw unavailable();
    rows = await prisma.message.findMany({
      where: {
        chatId: String(chatId), chat: owner, deletedAt: null,
        role: { in: ['USER', 'ASSISTANT'] },
        ...(Number.isFinite(summaryTime) ? { timestamp: { gt: chat.contextSummaryUntil } } : {}),
        ...(Number.isFinite(beforeTime) ? { AND: [{ timestamp: { lt: new Date(beforeTime) } }] } : {}),
        ...(anchor ? { OR: [
          { timestamp: { lt: anchor.timestamp } },
          { timestamp: anchor.timestamp, id: { lt: anchor.id } },
        ] } : {}),
      },
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      take: MAX_HISTORY_MESSAGES,
      select: { id: true, role: true, content: true, metadata: true, timestamp: true },
    });
  } catch (_) {
    // DB errors can contain connection details. Never put them in task output.
    throw unavailable();
  }
  const isCurrentTask = row => Boolean(taskId && row?.metadata?.taskId === String(taskId));
  const currentTime = anchor ? new Date(anchor.timestamp).getTime() : Infinity;
  const summary = typeof chat.contextSummary === 'string' ? chat.contextSummary.trim() : '';
  const summaryTime = summary && chat.contextSummaryUntil
    ? new Date(chat.contextSummaryUntil).getTime() : -Infinity;
  const history = (Array.isArray(rows) ? rows : []).filter(row => row && !row.deletedAt && !isCurrentTask(row)
    && ['USER', 'ASSISTANT'].includes(row.role)
    && new Date(row.timestamp).getTime() < beforeTime
    && (!Number.isFinite(summaryTime) || new Date(row.timestamp).getTime() > summaryTime)
    && (!anchor || new Date(row.timestamp).getTime() < currentTime
      || new Date(row.timestamp).getTime() === currentTime && row.id < anchor.id))
    .reverse().map(row => ({ role: row.role.toLowerCase(), content: row.content }));
  if (summary) history.unshift({ role: 'system', content: `## Memoria del hilo (contexto comprimido)\n${summary}` });
  return buildAgentHistoryBlock(history);
}

module.exports = { loadTaskConversationHistory, MAX_HISTORY_MESSAGES };

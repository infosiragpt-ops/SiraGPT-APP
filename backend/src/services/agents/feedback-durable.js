'use strict';

/**
 * Durable preference rows for RLHF-lite.
 *
 * Message.feedback in Postgres is the source of truth (liked/disliked).
 * The in-memory ledger hydrates from these rows after a restart.
 * No new table and no training job.
 */

const { preferenceAgent } = require('../document-analysis-rlhf');

async function loadPreferenceRows(prisma, userId, { limit = 80 } = {}) {
  if (!prisma || !userId) return [];
  const take = Math.max(1, Math.min(200, Number(limit) || 80));
  const assistants = await prisma.message.findMany({
    where: {
      role: 'ASSISTANT',
      feedback: { in: ['liked', 'disliked'] },
      deletedAt: null,
      chat: { userId: String(userId), deletedAt: null },
    },
    orderBy: { timestamp: 'desc' },
    take,
    select: {
      id: true,
      chatId: true,
      content: true,
      feedback: true,
      timestamp: true,
      metadata: true,
    },
  });
  if (!assistants.length) return [];
  const chatIds = [...new Set(assistants.map((row) => row.chatId))];
  const users = await prisma.message.findMany({
    where: {
      chatId: { in: chatIds },
      role: 'USER',
      deletedAt: null,
    },
    orderBy: { timestamp: 'asc' },
    select: { chatId: true, content: true, timestamp: true, files: true },
  });
  return assistants.map((asst) => {
    let prior = null;
    for (const user of users) {
      if (user.chatId !== asst.chatId) continue;
      if (user.timestamp < asst.timestamp) prior = user;
    }
    return {
      runId: asst.id,
      chatId: asst.chatId,
      timestamp: asst.timestamp,
      agent: preferenceAgent({
        files: prior && prior.files,
        prompt: prior ? prior.content : '',
      }),
      request: prior ? String(prior.content || '') : '',
      response: asst.content,
      helpful: asst.feedback === 'liked',
      reason: asst.metadata && asst.metadata.rlhf ? asst.metadata.rlhf.reason : null,
    };
  });
}

module.exports = { loadPreferenceRows };

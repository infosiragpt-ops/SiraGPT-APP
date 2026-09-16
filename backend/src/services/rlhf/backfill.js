'use strict';

/**
 * Copy durable Message.feedback rows into preference_events.
 *
 * Thumbs that landed before the flywheel (or while Prisma persist was
 * cold) live only on Message. This job is idempotent on runId=messageId.
 */

const store = require('./preference-store');

const DEFAULT_LIMIT = 500;

function listUserIdsFromChats(chats) {
  const ids = [];
  const seen = new Set();
  for (const chat of Array.isArray(chats) ? chats : []) {
    const id = chat && chat.userId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

async function loadUserIds(prisma, { userId, limit }) {
  if (userId) return [userId];
  if (!prisma || typeof prisma.chat?.findMany !== 'function') return [];
  const chats = await prisma.chat.findMany({
    where: {
      deletedAt: null,
      messages: {
        some: {
          role: 'ASSISTANT',
          feedback: { in: ['liked', 'disliked'] },
          deletedAt: null,
        },
      },
    },
    select: { userId: true },
    take: Math.max(1, Math.min(1000, limit)),
  });
  return listUserIdsFromChats(chats);
}

async function backfill({ prisma, embedder, userId = null, limit = DEFAULT_LIMIT } = {}) {
  if (!store.isCollectionEnabled()) {
    return { ok: false, reason: 'disabled', ingested: 0, users: 0 };
  }
  if (!prisma) throw new Error('rlhf.backfill: prisma required');

  const { loadPreferenceRows } = require('../agents/feedback-durable');
  const userIds = await loadUserIds(prisma, { userId, limit });
  let ingested = 0;
  let skipped = 0;
  for (const uid of userIds) {
    const rows = await loadPreferenceRows(prisma, uid, { limit });
    for (const row of rows) {
      const out = await store.ingestThumb({
        userId: uid,
        runId: row.runId,
        messageId: row.runId,
        chatId: row.chatId,
        agent: row.agent || 'chat',
        request: row.request,
        response: row.response,
        helpful: row.helpful === true,
        notes: row.reason || null,
        embedder,
        source: 'explicit',
      });
      if (out && out.stored) ingested += 1;
      else skipped += 1;
    }
  }
  return {
    ok: true,
    ingested,
    skipped,
    users: userIds.length,
  };
}

module.exports = {
  backfill,
  listUserIdsFromChats,
  DEFAULT_LIMIT,
};

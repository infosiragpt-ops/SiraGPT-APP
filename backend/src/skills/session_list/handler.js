const prisma = require('../../config/database');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

async function execute(args, ctx) {
  if (!ctx?.userId) throw new Error('session_list: ctx.userId required');
  const take = Math.max(1, Math.min(Number(args?.limit) || DEFAULT_LIMIT, MAX_LIMIT));

  const where = {
    userId: ctx.userId,
    // Soft-deleted chats are always excluded; archived ones are
    // opt-in because the usual "what was I doing" intent should
    // surface only live chats.
    deletedAt: null,
  };
  if (!args?.includeArchived) where.isArchived = false;

  const chats = await prisma.chat.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take,
    select: {
      id: true, title: true, model: true, createdAt: true, updatedAt: true,
      isArchived: true, isShared: true,
      _count: { select: { messages: true } },
    },
  });

  return {
    sessions: chats.map(c => ({
      id: c.id,
      title: c.title,
      model: c.model,
      messages: c._count?.messages ?? 0,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      archived: c.isArchived,
      shared: c.isShared,
    })),
  };
}

module.exports = { execute };

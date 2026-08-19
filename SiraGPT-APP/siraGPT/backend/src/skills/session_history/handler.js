const prisma = require('../../config/database');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const CONTENT_PREVIEW_CHARS = 1200;

async function execute(args, ctx) {
  if (!ctx?.userId) throw new Error('session_history: ctx.userId required');
  if (!args?.sessionId) return { error: 'missing sessionId' };
  const take = Math.max(1, Math.min(Number(args?.limit) || DEFAULT_LIMIT, MAX_LIMIT));

  // Ownership check up front — agents must not read other users'
  // chats even via direct id guessing. We select just userId +
  // title so we don't fetch the full chat row if ownership fails.
  const chat = await prisma.chat.findUnique({
    where: { id: args.sessionId },
    select: { userId: true, title: true },
  });
  if (!chat) return { error: 'session not found' };
  if (chat.userId !== ctx.userId) return { error: 'not your session' };

  const messages = await prisma.message.findMany({
    where: { chatId: args.sessionId },
    orderBy: { timestamp: 'desc' },
    take,
    select: { id: true, role: true, content: true, timestamp: true },
  });

  return {
    sessionId: args.sessionId,
    title: chat.title,
    messages: messages
      .slice()
      .reverse() // caller expects chronological order
      .map(m => ({
        id: m.id,
        role: m.role,
        content: (m.content || '').slice(0, CONTENT_PREVIEW_CHARS),
        truncated: (m.content || '').length > CONTENT_PREVIEW_CHARS,
        at: m.timestamp,
      })),
  };
}

module.exports = { execute };

'use strict';

/**
 * session-recall — SiraGPT-native adaptation of OpenClaw's session
 * continuity tools (`sessions_list` / `sessions_history`).
 *
 * OpenClaw exposes a personal assistant that remembers and can resume
 * prior conversations. We reproduce the read-only half of that model on
 * top of SiraGPT's own Prisma `Chat` / `Message` tables, strictly scoped
 * to the requesting user. No upstream code is imported — only the
 * capability intent (browse recent sessions, then open a thread to
 * resume work) is re-implemented natively.
 *
 * Both the bundled skills (`backend/src/skills/session_list`,
 * `backend/src/skills/session_history`) and the live agentic-chat tools
 * (`agent-tools.js`) delegate here, so the behaviour is identical no
 * matter which path reaches it. `deps.prisma` is injectable for
 * deterministic tests and resolved lazily so the singleton can be
 * monkey-patched by the existing skill tests.
 */

const LIST_DEFAULT_LIMIT = 10;
const LIST_MAX_LIMIT = 50;
const HISTORY_DEFAULT_LIMIT = 20;
const HISTORY_MAX_LIMIT = 50;
const CONTENT_PREVIEW_CHARS = 1200;

function resolvePrisma(deps) {
  if (deps && deps.prisma) return deps.prisma;
  // eslint-disable-next-line global-require
  return require('../config/database');
}

function clampLimit(value, fallback, max) {
  return Math.max(1, Math.min(Number(value) || fallback, max));
}

/**
 * List the user's chat sessions, most-recently-updated first.
 * Mirrors OpenClaw `sessions_list`.
 */
async function listSessions(args = {}, ctx = {}, deps = {}) {
  if (!ctx || !ctx.userId) throw new Error('session_list: ctx.userId required');
  const prisma = resolvePrisma(deps);
  const take = clampLimit(args && args.limit, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);

  const where = {
    userId: ctx.userId,
    // Soft-deleted chats are always excluded; archived ones are opt-in
    // because the usual "what was I doing" intent should surface only
    // live chats.
    deletedAt: null,
  };
  if (!(args && args.includeArchived)) where.isArchived = false;

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
    sessions: chats.map((c) => ({
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

/**
 * Fetch the most recent messages from a specific session the user owns,
 * returned in chronological order. Mirrors OpenClaw `sessions_history`.
 */
async function fetchSessionHistory(args = {}, ctx = {}, deps = {}) {
  if (!ctx || !ctx.userId) throw new Error('session_history: ctx.userId required');
  if (!args || !args.sessionId) return { error: 'missing sessionId' };
  const prisma = resolvePrisma(deps);
  const take = clampLimit(args.limit, HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT);

  // Ownership check up front — agents must not read other users' chats
  // even via direct id guessing. Select just userId + title so we don't
  // fetch the full chat row if ownership fails.
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
      .map((m) => ({
        id: m.id,
        role: m.role,
        content: (m.content || '').slice(0, CONTENT_PREVIEW_CHARS),
        truncated: (m.content || '').length > CONTENT_PREVIEW_CHARS,
        at: m.timestamp,
      })),
  };
}

module.exports = {
  listSessions,
  fetchSessionHistory,
  _internal: {
    clampLimit,
    LIST_DEFAULT_LIMIT,
    LIST_MAX_LIMIT,
    HISTORY_DEFAULT_LIMIT,
    HISTORY_MAX_LIMIT,
    CONTENT_PREVIEW_CHARS,
  },
};

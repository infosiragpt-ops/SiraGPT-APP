'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  listSessions,
  fetchSessionHistory,
  _internal,
} = require('../src/services/session-recall');

// ─── listSessions (OpenClaw sessions_list parity) ──────────────────────────

test('listSessions scopes to the current user and excludes deleted/archived by default', async () => {
  let captured = null;
  const now = new Date('2026-06-01T10:00:00Z');
  const prisma = {
    chat: {
      findMany: async (q) => {
        captured = q;
        return [
          {
            id: 'c1', title: 'Tesis RSN', model: 'gpt-4o',
            createdAt: now, updatedAt: now, isArchived: false, isShared: true,
            _count: { messages: 12 },
          },
        ];
      },
    },
  };

  const out = await listSessions({}, { userId: 'u1' }, { prisma });

  assert.equal(captured.where.userId, 'u1');
  assert.equal(captured.where.deletedAt, null);
  assert.equal(captured.where.isArchived, false);
  assert.deepEqual(captured.orderBy, { updatedAt: 'desc' });
  assert.equal(captured.take, 10, 'default limit is 10');
  assert.equal(out.sessions.length, 1);
  assert.deepEqual(out.sessions[0], {
    id: 'c1', title: 'Tesis RSN', model: 'gpt-4o',
    messages: 12, createdAt: now, updatedAt: now, archived: false, shared: true,
  });
});

test('listSessions honours includeArchived and clamps the limit to [1,50]', async () => {
  let captured = null;
  const prisma = { chat: { findMany: async (q) => { captured = q; return []; } } };

  await listSessions({ includeArchived: true, limit: 999 }, { userId: 'u1' }, { prisma });
  assert.equal(Object.hasOwn(captured.where, 'isArchived'), false, 'includeArchived drops the filter');
  assert.equal(captured.take, 50, 'over-cap clamps to MAX_LIMIT');

  await listSessions({ limit: 0 }, { userId: 'u1' }, { prisma });
  assert.equal(captured.take, 10, 'falsy limit falls back to default');
});

test('listSessions defaults message count to 0 and requires a user', async () => {
  const prisma = {
    chat: {
      findMany: async () => [
        { id: 'c1', title: 't', model: 'm', createdAt: new Date(), updatedAt: new Date(), isArchived: false, isShared: false },
      ],
    },
  };
  const out = await listSessions({}, { userId: 'u1' }, { prisma });
  assert.equal(out.sessions[0].messages, 0);

  await assert.rejects(
    () => listSessions({}, {}, { prisma }),
    /session_list: ctx\.userId required/,
  );
});

// ─── fetchSessionHistory (OpenClaw sessions_history parity) ─────────────────

test('fetchSessionHistory enforces ownership and validates input', async () => {
  const prisma = {
    chat: { findUnique: async () => ({ userId: 'someone-else', title: 'x' }) },
    message: { findMany: async () => { throw new Error('should not query messages'); } },
  };

  await assert.rejects(
    () => fetchSessionHistory({ sessionId: 'c1' }, {}, { prisma }),
    /session_history: ctx\.userId required/,
  );

  const missing = await fetchSessionHistory({}, { userId: 'u1' }, { prisma });
  assert.equal(missing.error, 'missing sessionId');

  const notMine = await fetchSessionHistory({ sessionId: 'c1' }, { userId: 'u1' }, { prisma });
  assert.equal(notMine.error, 'not your session');

  const notFound = await fetchSessionHistory(
    { sessionId: 'cX' },
    { userId: 'u1' },
    { prisma: { chat: { findUnique: async () => null }, message: { findMany: async () => [] } } },
  );
  assert.equal(notFound.error, 'session not found');
});

test('fetchSessionHistory returns chronological messages with a content cap', async () => {
  let captured = null;
  const huge = 'x'.repeat(2000);
  const prisma = {
    chat: { findUnique: async () => ({ userId: 'u1', title: 'My chat' }) },
    message: {
      findMany: async (q) => {
        captured = q;
        // Prisma returns DESC; the service must reverse to ASC.
        return [
          { id: 'm3', role: 'assistant', content: 'reply', timestamp: new Date('2026-05-21T03:00:00Z') },
          { id: 'm2', role: 'user', content: huge, timestamp: new Date('2026-05-21T02:00:00Z') },
          { id: 'm1', role: 'user', content: null, timestamp: new Date('2026-05-21T01:00:00Z') },
        ];
      },
    },
  };

  const out = await fetchSessionHistory({ sessionId: 'c1', limit: 999 }, { userId: 'u1' }, { prisma });

  assert.equal(captured.where.chatId, 'c1');
  assert.deepEqual(captured.orderBy, { timestamp: 'desc' });
  assert.equal(captured.take, 50, 'limit clamps to MAX_LIMIT');
  assert.equal(out.sessionId, 'c1');
  assert.equal(out.title, 'My chat');
  // Chronological order: m1 (oldest) first, m3 (newest) last.
  assert.deepEqual(out.messages.map((m) => m.id), ['m1', 'm2', 'm3']);
  const big = out.messages.find((m) => m.id === 'm2');
  assert.equal(big.content.length, _internal.CONTENT_PREVIEW_CHARS);
  assert.equal(big.truncated, true);
  const nul = out.messages.find((m) => m.id === 'm1');
  assert.equal(nul.content, '');
  assert.equal(nul.truncated, false);
});

test('fetchSessionHistory default limit is 20', async () => {
  let captured = null;
  const prisma = {
    chat: { findUnique: async () => ({ userId: 'u1', title: 't' }) },
    message: { findMany: async (q) => { captured = q; return []; } },
  };
  await fetchSessionHistory({ sessionId: 'c1' }, { userId: 'u1' }, { prisma });
  assert.equal(captured.take, 20);
});

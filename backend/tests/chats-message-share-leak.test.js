'use strict';

// Regression — POST /chats/:chatId/messages/:messageId/share must pair the
// correct adjacent message and must never expose a soft-deleted one.
//
// The handler loaded `include: { messages: true }` (no orderBy, no deletedAt
// filter) and then paired messages[index-1] / [index+1]. Prisma does not
// guarantee relation order without orderBy, so the adjacency could pick the
// wrong message; worse, a soft-deleted (deletedAt) message adjacent in the
// returned array got pulled into the public share. The fix loads
// `{ where: { deletedAt: null }, orderBy: { timestamp: 'asc' } }`.
//
// The fake prisma.chat.findFirst HONORS whatever `include` the route passes, so
// the old `messages: true` shape returns the soft-deleted row (leak) while the
// fixed shape filters + orders it out.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { buildRouteTestApp, installAuthSessionMock, reloadModule } = require('./http-test-utils');
const prisma = require('../src/config/database');

describe('POST /chats/:chatId/messages/:messageId/share · no soft-deleted leak', () => {
  let auth;
  let saved;
  let created;

  // A=USER(t1), B=ASSISTANT deleted(t2), C=ASSISTANT real(t3). Array (insertion)
  // order deliberately places the deleted B right before C, so an unordered
  // include pairs C with B.
  const CHAT_ID = 'chat-share-1';
  function buildMessages() {
    return [
      { id: 'mA', role: 'USER', content: 'real question', timestamp: new Date('2026-06-01T00:00:01Z'), deletedAt: null },
      { id: 'mB', role: 'ASSISTANT', content: 'DELETED SECRET ANSWER', timestamp: new Date('2026-06-01T00:00:02Z'), deletedAt: new Date('2026-06-02T00:00:00Z') },
      { id: 'mC', role: 'ASSISTANT', content: 'real answer', timestamp: new Date('2026-06-01T00:00:03Z'), deletedAt: null },
    ];
  }

  beforeEach(() => {
    auth = installAuthSessionMock();
    created = null;
    saved = {
      chatFindFirst: prisma.chat.findFirst,
      msgShare: prisma.messageShare,
    };

    prisma.chat.findFirst = async ({ where, include } = {}) => {
      if (where?.id !== CHAT_ID || where?.userId !== auth.user.id) return null;
      let msgs = buildMessages();
      const mi = include && include.messages;
      // Faithfully apply the include the route passes (object form only).
      if (mi && typeof mi === 'object') {
        if (mi.where && mi.where.deletedAt === null) msgs = msgs.filter((m) => m.deletedAt == null);
        if (mi.orderBy && mi.orderBy.timestamp === 'asc') {
          msgs = msgs.slice().sort((a, c) => a.timestamp - c.timestamp);
        }
      }
      return { id: CHAT_ID, userId: auth.user.id, messages: msgs };
    };

    prisma.messageShare = {
      findFirst: async () => null,
      create: async ({ data }) => { created = data; return { id: 'share-1', ...data }; },
    };

    delete require.cache[require.resolve('../src/routes/chats')];
  });

  afterEach(() => {
    prisma.chat.findFirst = saved.chatFindFirst;
    prisma.messageShare = saved.msgShare;
    auth.restore();
    delete require.cache[require.resolve('../src/routes/chats')];
  });

  function app() {
    return buildRouteTestApp('/chats', reloadModule('../src/routes/chats'));
  }

  test('sharing the assistant message pairs the real USER msg, not the deleted one', async () => {
    const res = await request(app())
      .post(`/chats/${CHAT_ID}/messages/mC/share`)
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 200);
    assert.ok(created, 'a message share was created');
    assert.equal(created.assistantMessageId, 'mC');
    // The paired user message MUST be the real one (mA), never the soft-deleted
    // assistant (mB) that was adjacent in insertion order.
    assert.equal(created.userMessageId, 'mA', 'must pair the real preceding USER message');
    assert.notEqual(created.userMessageId, 'mB', 'must never expose the soft-deleted message');
  });

  test('the soft-deleted message itself cannot be shared (404)', async () => {
    const res = await request(app())
      .post(`/chats/${CHAT_ID}/messages/mB/share`)
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 404);
  });
});

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const prisma = require('../src/config/database');
const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');

describe('DELETE /chats/:id', () => {
  let auth;
  let originals;

  beforeEach(() => {
    auth = installAuthSessionMock();
    originals = {
      chatFindFirst: prisma.chat.findFirst,
      chatUpdate: prisma.chat.update,
      messageUpdateMany: prisma.message.updateMany,
      transaction: prisma.$transaction,
    };
    delete require.cache[require.resolve('../src/routes/chats')];
  });

  afterEach(() => {
    prisma.chat.findFirst = originals.chatFindFirst;
    prisma.chat.update = originals.chatUpdate;
    prisma.message.updateMany = originals.messageUpdateMany;
    prisma.$transaction = originals.transaction;
    auth.restore();
    delete require.cache[require.resolve('../src/routes/chats')];
  });

  function buildApp() {
    return buildRouteTestApp('/chats', reloadModule('../src/routes/chats'));
  }

  test('soft deletes the chat and its active messages', async () => {
    const calls = [];
    prisma.chat.findFirst = async (args) => {
      calls.push(['chat.findFirst', args]);
      return { id: 'chat-1' };
    };
    prisma.message.updateMany = async (args) => {
      calls.push(['message.updateMany', args]);
      return { count: 2 };
    };
    prisma.chat.update = async (args) => {
      calls.push(['chat.update', args]);
      return {
        id: args.where.id,
        deletedAt: args.data.deletedAt,
        isArchived: args.data.isArchived,
      };
    };
    prisma.$transaction = async (callback) => callback(prisma);

    const res = await request(buildApp())
      .delete('/chats/chat-1')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.chat.id, 'chat-1');
    assert.equal(res.body.chat.isArchived, true);
    assert.match(res.body.chat.deletedAt, /^\d{4}-\d{2}-\d{2}T/);

    assert.deepEqual(calls[0], [
      'chat.findFirst',
      {
        where: { id: 'chat-1', userId: auth.user.id, deletedAt: null },
        select: { id: true },
      },
    ]);
    assert.equal(calls[1][0], 'message.updateMany');
    assert.deepEqual(calls[1][1].where, { chatId: 'chat-1', deletedAt: null });
    assert.ok(calls[1][1].data.deletedAt instanceof Date);
    assert.equal(calls[2][0], 'chat.update');
    assert.deepEqual(calls[2][1].where, { id: 'chat-1' });
    assert.equal(calls[2][1].data.isArchived, true);
    assert.ok(calls[2][1].data.deletedAt instanceof Date);
    assert.ok(calls[2][1].data.updatedAt instanceof Date);
  });

  test('returns 404 without writes when the chat is missing or already deleted', async () => {
    let writeCount = 0;
    prisma.chat.findFirst = async () => null;
    prisma.message.updateMany = async () => { writeCount += 1; };
    prisma.chat.update = async () => { writeCount += 1; };
    prisma.$transaction = async (callback) => callback(prisma);

    const res = await request(buildApp())
      .delete('/chats/deleted-chat')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Chat not found');
    assert.equal(writeCount, 0);
  });
});

'use strict';

/**
 * /api/public/share/* — a soft-deleted chat (or one of its messages) must be
 * unreachable through its share link. Before 2026-10-08 a deleted chat kept
 * its shareId until the 30-day hard purge and anyone with the link kept
 * reading the transcript, files and metadata.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const prisma = require('../src/config/database');
const { buildRouteTestApp, reloadModule } = require('./http-test-utils');

describe('public share routes honour soft delete', () => {
  let originals;

  beforeEach(() => {
    originals = {
      chatFindUnique: prisma.chat.findUnique,
      messageShareFindUnique: prisma.messageShare && prisma.messageShare.findUnique,
      messageFindFirst: prisma.message.findFirst,
      messageFindUnique: prisma.message.findUnique,
    };
    delete require.cache[require.resolve('../src/routes/public')];
  });

  afterEach(() => {
    prisma.chat.findUnique = originals.chatFindUnique;
    if (prisma.messageShare) prisma.messageShare.findUnique = originals.messageShareFindUnique;
    prisma.message.findFirst = originals.messageFindFirst;
    prisma.message.findUnique = originals.messageFindUnique;
    delete require.cache[require.resolve('../src/routes/public')];
  });

  function app() {
    return buildRouteTestApp('/api/public', reloadModule('../src/routes/public'));
  }

  test('GET /share/:shareId filters deleted chats and deleted messages at the query', async () => {
    let args = null;
    prisma.chat.findUnique = async (query) => {
      args = query;
      return {
        id: 'chat-1', title: 'Compartido', model: 'm', createdAt: new Date(),
        messages: [{ id: 'm1', role: 'user', content: 'hola', files: null, metadata: null, timestamp: new Date() }],
      };
    };
    const res = await request(app()).get('/api/public/share/abc123');
    assert.equal(res.status, 200);
    assert.deepEqual(args.where, { shareId: 'abc123', isShared: true, deletedAt: null });
    assert.deepEqual(args.include.messages.where, { deletedAt: null });
    assert.equal(res.body.chat.messages.length, 1);
  });

  test('GET /share/:shareId → 404 when the filtered lookup finds nothing (deleted chat)', async () => {
    prisma.chat.findUnique = async () => null;
    const res = await request(app()).get('/api/public/share/gone');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Shared chat not found.');
  });

  test('GET /share/message/:shareId → 404 when the parent chat is soft-deleted', async () => {
    let messageReads = 0;
    prisma.messageShare = prisma.messageShare || {};
    prisma.messageShare.findUnique = async (query) => {
      assert.equal(query.include.chat.select.deletedAt, true, 'the parent chat tombstone is read');
      return {
        id: 'share-1', userMessageId: 'u1', assistantMessageId: 'a1',
        chat: { title: 'T', model: 'm', deletedAt: new Date('2026-10-01T00:00:00Z') },
      };
    };
    prisma.message.findFirst = async () => { messageReads++; return null; };
    prisma.message.findUnique = async () => { messageReads++; return null; };

    const res = await request(app()).get('/api/public/share/message/share-1');
    assert.equal(res.status, 404);
    assert.equal(messageReads, 0, 'no message is read once the chat is known to be deleted');
  });

  test('GET /share/message/:shareId reads messages with deletedAt: null and 404s on a deleted row', async () => {
    const whereSeen = [];
    prisma.messageShare = prisma.messageShare || {};
    prisma.messageShare.findUnique = async () => ({
      id: 'share-2', userMessageId: 'u1', assistantMessageId: 'a1',
      chat: { title: 'T', model: 'm', deletedAt: null },
    });
    prisma.message.findUnique = async () => { throw new Error('findUnique cannot filter by deletedAt'); };
    prisma.message.findFirst = async ({ where }) => {
      whereSeen.push(where);
      if (where.id === 'u1') return { id: 'u1', role: 'user', content: 'q', files: null, metadata: null, timestamp: new Date() };
      return null; // the assistant row was soft-deleted
    };

    const res = await request(app()).get('/api/public/share/message/share-2');
    assert.equal(res.status, 404);
    assert.deepEqual(whereSeen, [
      { id: 'u1', deletedAt: null },
      { id: 'a1', deletedAt: null },
    ]);
  });

  test('GET /share/message/:shareId still serves a live pair', async () => {
    prisma.messageShare = prisma.messageShare || {};
    prisma.messageShare.findUnique = async () => ({
      id: 'share-3', userMessageId: 'u1', assistantMessageId: 'a1',
      chat: { title: 'T', model: 'm', deletedAt: null },
    });
    prisma.message.findFirst = async ({ where }) => ({
      id: where.id, role: where.id === 'u1' ? 'user' : 'assistant', content: `c-${where.id}`,
      files: null, metadata: null, timestamp: new Date(),
    });
    const res = await request(app()).get('/api/public/share/message/share-3');
    assert.equal(res.status, 200);
    const body = JSON.stringify(res.body);
    assert.ok(body.includes('c-u1') && body.includes('c-a1'));
  });
});

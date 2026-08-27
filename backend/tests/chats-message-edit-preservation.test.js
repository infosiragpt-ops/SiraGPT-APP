'use strict';

const { afterEach, beforeEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const prisma = require('../src/config/database');
const triggers = require('../src/services/trigger-registry');
const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');

describe('PUT /chats/messages/:messageId preserves attachments', () => {
  let auth;
  let app;
  let router;
  let originals;
  let captured;
  let existingMessage;

  beforeEach(() => {
    auth = installAuthSessionMock();
    router = reloadModule('../src/routes/chats');
    app = buildRouteTestApp('/chats', router);

    existingMessage = {
      id: 'msg-edit-1',
      chatId: 'chat-1',
      role: 'USER',
      content: 'texto original',
      files: [{ name: 'informe.pdf', mimeType: 'application/pdf' }],
      metadata: { model: 'deepseek-v4-pro' },
      timestamp: new Date('2026-01-01T10:00:00Z'),
    };

    captured = { updateData: null, deleteWhere: null, chatUpdateCalled: false };

    originals = {
      transaction: prisma.$transaction,
      chatUpdate: prisma.chat.update,
      publishDebounced: triggers.publishDebounced,
    };

    prisma.$transaction = async (fn) => fn({
      message: {
        findFirst: async ({ where } = {}) => {
          if (
            where?.id === existingMessage.id
            && where?.role === 'USER'
            && where?.chat?.userId === auth.user.id
          ) return { ...existingMessage };
          return null;
        },
        deleteMany: async ({ where } = {}) => {
          captured.deleteWhere = where;
          return { count: 2 };
        },
        update: async ({ data } = {}) => {
          captured.updateData = data;
          return { ...existingMessage, ...data };
        },
      },
      chat: {
        update: async () => {
          captured.chatUpdateCalled = true;
          return {};
        },
      },
    });

    prisma.chat.update = async (args) => ({ kind: 'chat.update', args });
    triggers.publishDebounced = async () => {};
  });

  afterEach(() => {
    prisma.$transaction = originals.transaction;
    prisma.chat.update = originals.chatUpdate;
    triggers.publishDebounced = originals.publishDebounced;
    auth.restore();
  });

  test('text-only edit keeps existing files and metadata intact', async () => {
    const res = await request(app)
      .put('/chats/messages/msg-edit-1')
      .set('Authorization', auth.authHeader)
      .send({ content: 'solo cambio el texto' });

    assert.equal(res.status, 200);
    assert.ok(captured.updateData);
    // The regression: a text-only edit must NOT touch files/metadata.
    assert.equal('files' in captured.updateData, false);
    assert.equal('metadata' in captured.updateData, false);
    assert.equal(captured.updateData.content, 'solo cambio el texto');
    assert.equal(existingMessage.files.length, 1);
    assert.equal(existingMessage.metadata.model, 'deepseek-v4-pro');
    assert.equal(captured.chatUpdateCalled, true);
  });

  test('edit with files persists the provided attachment list', async () => {
    const files = [{ name: 'nuevo.csv', mimeType: 'text/csv' }];
    const res = await request(app)
      .put('/chats/messages/msg-edit-1')
      .set('Authorization', auth.authHeader)
      .send({ content: 'ahora con adjunto', files });

    assert.equal(res.status, 200);
    assert.deepEqual(captured.updateData.files, files);
    assert.equal(res.body.message.content, 'ahora con adjunto');
    assert.deepEqual(res.body.message.files, files);
  });

  test('edit with string metadata parses it before persisting', async () => {
    const res = await request(app)
      .put('/chats/messages/msg-edit-1')
      .set('Authorization', auth.authHeader)
      .send({
        content: 'con metadata',
        metadata: JSON.stringify({ branchedFrom: 'chat-0', turnFingerprint: null }),
      });

    assert.equal(res.status, 200);
    assert.deepEqual(captured.updateData.metadata, {
      branchedFrom: 'chat-0',
      turnFingerprint: null,
    });
  });

  test('invalid metadata payload is rejected with 400', async () => {
    const res = await request(app)
      .put('/chats/messages/msg-edit-1')
      .set('Authorization', auth.authHeader)
      .send({ content: 'x', metadata: [1, 2, 3] });

    assert.equal(res.status, 400);
    assert.match(res.text, /Metadata must be a plain object/);
    assert.equal(captured.updateData, null);
  });

  test('message owned by another user returns 404 without deleting anything', async () => {
    const res = await request(app)
      .put('/chats/messages/msg-other-user')
      .set('Authorization', auth.authHeader)
      .send({ content: 'intento ajeno' });

    assert.equal(res.status, 404);
    assert.equal(captured.deleteWhere, null);
    assert.equal(captured.updateData, null);
  });
});

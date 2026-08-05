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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('POST /chats concurrent idempotency', () => {
  let auth;
  let originals;
  let chats;
  let creates;
  let activeCreates;
  let maxActiveCreates;

  beforeEach(() => {
    auth = installAuthSessionMock();
    chats = [];
    creates = 0;
    activeCreates = 0;
    maxActiveCreates = 0;
    originals = {
      chatFindFirst: prisma.chat.findFirst,
      chatCreate: prisma.chat.create,
      publish: triggers.publish,
    };

    prisma.chat.findFirst = async ({ where } = {}) => chats.find((chat) => (
      chat.id === where?.id
      && chat.userId === where?.userId
      && where?.deletedAt === null
    )) || null;
    prisma.chat.create = async ({ data }) => {
      creates += 1;
      const createNumber = creates;
      activeCreates += 1;
      maxActiveCreates = Math.max(maxActiveCreates, activeCreates);
      await delay(25);
      activeCreates -= 1;
      const chat = {
        id: `created-chat-${createNumber}`,
        ...data,
        messages: [],
        project: null,
        deletedAt: null,
      };
      chats.push(chat);
      return chat;
    };
    triggers.publish = async () => {};
    delete require.cache[require.resolve('../src/routes/chats')];
  });

  afterEach(() => {
    prisma.chat.findFirst = originals.chatFindFirst;
    prisma.chat.create = originals.chatCreate;
    triggers.publish = originals.publish;
    auth.restore();
    delete require.cache[require.resolve('../src/routes/chats')];
  });

  function buildApp() {
    return buildRouteTestApp('/chats', reloadModule('../src/routes/chats'));
  }

  function createChat(app, { title = 'Empresa nueva', idempotencyKey } = {}) {
    const payload = { title, model: 'test-model' };
    if (idempotencyKey) payload.idempotencyKey = idempotencyKey;
    return request(app)
      .post('/chats')
      .set('Authorization', auth.authHeader)
      .send(payload);
  }

  function createChatWithHeader(app, { title = 'Empresa nueva', idempotencyKey }) {
    return request(app)
      .post('/chats')
      .set('Authorization', auth.authHeader)
      .set('Idempotency-Key', idempotencyKey)
      .send({ title, model: 'test-model' });
  }

  test('two simultaneous requests with the same key create one chat', async () => {
    const app = buildApp();
    const responses = await Promise.all([
      createChat(app, { idempotencyKey: 'chat-turn-1' }),
      createChat(app, { idempotencyKey: 'chat-turn-1' }),
    ]);

    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]);
    assert.equal(creates, 1);
    assert.equal(chats.length, 1);
    assert.equal(responses.filter((response) => response.body.duplicate === true).length, 1);
    assert.equal(responses[0].body.chat.id, responses[1].body.chat.id);
  });

  test('same key with a different create payload gets 409', async () => {
    const app = buildApp();
    const responses = await Promise.all([
      createChat(app, { title: 'Empresa A', idempotencyKey: 'chat-turn-mismatch' }),
      createChat(app, { title: 'Empresa B', idempotencyKey: 'chat-turn-mismatch' }),
    ]);
    const conflict = responses.find((response) => response.status === 409);

    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
    assert.equal(creates, 1);
    assert.equal(chats.length, 1);
    assert.equal(conflict.body.code, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
  });

  test('header-only concurrent retries create one chat', async () => {
    const app = buildApp();
    const responses = await Promise.all([
      createChatWithHeader(app, { idempotencyKey: 'header-chat-1' }),
      createChatWithHeader(app, { idempotencyKey: 'header-chat-1' }),
    ]);

    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]);
    assert.equal(creates, 1);
    assert.equal(responses[0].body.chat.id, responses[1].body.chat.id);
  });

  test('invalid or divergent headers fail closed instead of disabling dedupe', async () => {
    const app = buildApp();
    const tooLong = await createChatWithHeader(app, {
      idempotencyKey: 'x'.repeat(201),
    });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.code, 'INVALID_IDEMPOTENCY_KEY');

    const divergent = await request(app)
      .post('/chats')
      .set('Authorization', auth.authHeader)
      .set('Idempotency-Key', 'header-chat')
      .send({ title: 'Empresa', model: 'test-model', idempotencyKey: 'body-chat' });
    assert.equal(divergent.status, 400);
    assert.equal(divergent.body.code, 'INVALID_IDEMPOTENCY_KEY');
    assert.equal(creates, 0);
  });

  test('different keys and missing keys do not share the create queue', async () => {
    const app = buildApp();
    const responses = await Promise.all([
      createChat(app, { idempotencyKey: 'chat-turn-a' }),
      createChat(app, { idempotencyKey: 'chat-turn-b' }),
      createChat(app),
    ]);

    assert.deepEqual(responses.map((response) => response.status), [201, 201, 201]);
    assert.equal(creates, 3);
    assert.equal(maxActiveCreates, 3);
  });
});

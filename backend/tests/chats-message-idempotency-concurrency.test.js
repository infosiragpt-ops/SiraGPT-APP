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

describe('POST /chats/:id/messages concurrent idempotency', () => {
  let auth;
  let originals;
  let rows;
  let transactionCount;

  beforeEach(() => {
    auth = installAuthSessionMock();
    rows = [];
    transactionCount = 0;
    originals = {
      chatFindFirst: prisma.chat.findFirst,
      chatUpdate: prisma.chat.update,
      messageFindFirst: prisma.message.findFirst,
      messageCreate: prisma.message.create,
      transaction: prisma.$transaction,
      publishDebounced: triggers.publishDebounced,
    };

    prisma.chat.findFirst = async ({ where } = {}) => {
      if (where?.id !== 'chat-1' || where?.userId !== auth.user.id) return null;
      return { id: 'chat-1', userId: auth.user.id, model: 'test-model' };
    };
    prisma.message.findFirst = async ({ where } = {}) => rows.find((message) => (
      message.chatId === where?.chatId
      && message.deletedAt === where?.deletedAt
      && message.metadata?.idempotencyKey === where?.metadata?.equals
    )) || null;
    prisma.message.create = (args) => ({ kind: 'message.create', args });
    prisma.chat.update = (args) => ({ kind: 'chat.update', args });
    prisma.$transaction = async (writes) => {
      transactionCount += 1;
      await delay(25);
      const create = writes.find((write) => write.kind === 'message.create');
      const message = {
        id: `message-${transactionCount}`,
        ...create.args.data,
        timestamp: new Date(),
        deletedAt: null,
      };
      rows.push(message);
      return [message, { id: 'chat-1' }];
    };
    triggers.publishDebounced = async () => {};
    delete require.cache[require.resolve('../src/routes/chats')];
  });

  afterEach(() => {
    prisma.chat.findFirst = originals.chatFindFirst;
    prisma.chat.update = originals.chatUpdate;
    prisma.message.findFirst = originals.messageFindFirst;
    prisma.message.create = originals.messageCreate;
    prisma.$transaction = originals.transaction;
    triggers.publishDebounced = originals.publishDebounced;
    auth.restore();
    delete require.cache[require.resolve('../src/routes/chats')];
  });

  function buildApp() {
    return buildRouteTestApp('/chats', reloadModule('../src/routes/chats'));
  }

  function sendMessage(app, content, idempotencyKey = 'turn-concurrent') {
    return request(app)
      .post('/chats/chat-1/messages')
      .set('Authorization', auth.authHeader)
      .send({ role: 'USER', content, idempotencyKey });
  }

  function sendMessageWithHeader(app, content, idempotencyKey) {
    return request(app)
      .post('/chats/chat-1/messages')
      .set('Authorization', auth.authHeader)
      .set('Idempotency-Key', idempotencyKey)
      .send({ role: 'USER', content });
  }

  function sendMessageWithRole(app, role, content, idempotencyKey) {
    return request(app)
      .post('/chats/chat-1/messages')
      .set('Authorization', auth.authHeader)
      .send({ role, content, idempotencyKey });
  }

  test('two simultaneous requests with the same key and body create one row', async () => {
    const app = buildApp();
    const responses = await Promise.all([
      sendMessage(app, 'construye la aplicación'),
      sendMessage(app, 'construye la aplicación'),
    ]);

    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]);
    assert.equal(transactionCount, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].metadata.idempotencyKey, 'turn-concurrent');
    assert.match(rows[0].metadata.idempotencyRequestHash, /^[a-f0-9]{64}$/);
    assert.equal(responses.filter((response) => response.body.duplicate === true).length, 1);
    assert.equal(responses[0].body.message.id, responses[1].body.message.id);
  });

  test('a simultaneous request with the same key but different body gets 409', async () => {
    const app = buildApp();
    const responses = await Promise.all([
      sendMessage(app, 'primera instrucción', 'turn-mismatch'),
      sendMessage(app, 'payload mutado', 'turn-mismatch'),
    ]);
    const conflict = responses.find((response) => response.status === 409);

    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
    assert.equal(transactionCount, 1);
    assert.equal(rows.length, 1);
    assert.equal(conflict.body.code, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
  });

  test('same key cannot cross from USER to ASSISTANT sequentially', async () => {
    const app = buildApp();
    const first = await sendMessageWithRole(app, 'USER', 'same content', 'turn-role-sequential');
    const conflict = await sendMessageWithRole(app, 'ASSISTANT', 'same content', 'turn-role-sequential');

    assert.equal(first.status, 201);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
    assert.equal(transactionCount, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].role, 'USER');
  });

  test('same key cannot cross from USER to ASSISTANT concurrently', async () => {
    const app = buildApp();
    const responses = await Promise.all([
      sendMessageWithRole(app, 'USER', 'same content', 'turn-role-concurrent'),
      sendMessageWithRole(app, 'ASSISTANT', 'same content', 'turn-role-concurrent'),
    ]);

    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
    assert.equal(responses.find((response) => response.status === 409).body.code,
      'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
    assert.equal(transactionCount, 1);
    assert.equal(rows.length, 1);
  });

  test('header-only concurrent retries create one row and reject a changed payload', async () => {
    const app = buildApp();
    const same = await Promise.all([
      sendMessageWithHeader(app, 'header payload', 'header-turn-1'),
      sendMessageWithHeader(app, 'header payload', 'header-turn-1'),
    ]);
    assert.deepEqual(same.map((response) => response.status).sort(), [200, 201]);
    assert.equal(transactionCount, 1);
    assert.equal(rows[0].metadata.idempotencyKey, 'header-turn-1');

    const conflict = await sendMessageWithHeader(app, 'changed payload', 'header-turn-1');
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
    assert.equal(transactionCount, 1);
  });

  test('accepts direct object metadata and JSON strings containing an object', async () => {
    const app = buildApp();
    const direct = await request(app)
      .post('/chats/chat-1/messages')
      .set('Authorization', auth.authHeader)
      .send({
        role: 'USER',
        content: 'metadata directo',
        metadata: { source: 'typed-client', nested: { enabled: true } },
      });
    const encoded = await request(app)
      .post('/chats/chat-1/messages')
      .set('Authorization', auth.authHeader)
      .send({
        role: 'USER',
        content: 'metadata codificado',
        metadata: JSON.stringify({ source: 'legacy-client', nested: { enabled: true } }),
      });

    assert.equal(direct.status, 201);
    assert.equal(encoded.status, 201);
    assert.deepEqual(rows[0].metadata, { source: 'typed-client', nested: { enabled: true } });
    assert.deepEqual(rows[1].metadata, { source: 'legacy-client', nested: { enabled: true } });
  });

  test('rejects malformed JSON, arrays, null, and primitive metadata values', async () => {
    const app = buildApp();
    const invalidValues = [
      '{"source":',
      [],
      42,
      true,
      null,
      '[]',
      '42',
      'true',
      'null',
      '"metadata"',
    ];

    for (const metadata of invalidValues) {
      const response = await request(app)
        .post('/chats/chat-1/messages')
        .set('Authorization', auth.authHeader)
        .send({ role: 'USER', content: 'metadata inválido', metadata });

      assert.equal(response.status, 400, `metadata=${JSON.stringify(metadata)}`);
      assert.equal(response.body.errors[0].path, 'metadata');
    }
    assert.equal(transactionCount, 0);
  });

  test('rejects divergent body, header, and metadata identities', async () => {
    const app = buildApp();
    const response = await request(app)
      .post('/chats/chat-1/messages')
      .set('Authorization', auth.authHeader)
      .set('Idempotency-Key', 'header-key')
      .send({
        role: 'USER',
        content: 'mensaje válido',
        idempotencyKey: 'body-key',
        metadata: { idempotencyKey: 'metadata-key' },
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'INVALID_IDEMPOTENCY_KEY');
    assert.equal(transactionCount, 0);
  });

  test('metadata cannot bypass idempotency-key type and length validation', async () => {
    const app = buildApp();
    const invalidValues = [42, 'x'.repeat(201)];

    for (const invalidKey of invalidValues) {
      const response = await request(app)
        .post('/chats/chat-1/messages')
        .set('Authorization', auth.authHeader)
        .send({
          role: 'USER',
          content: 'mensaje válido',
          metadata: { idempotencyKey: invalidKey },
        });
      assert.equal(response.status, 400);
      assert.equal(response.body.errors[0].path, 'metadata.idempotencyKey');
    }
    assert.equal(transactionCount, 0);
  });
});

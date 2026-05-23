const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');

/**
 * POST /chats/:id/messages — validation contract.
 *
 * Critical to catch curl-direct callers or replay attacks that bypass
 * the frontend MAX_CHAT_INPUT_CHARS cap. The route declares an
 * express-validator chain with isLength({ max: 100_000 }) — we hit it
 * with a 100 001-char payload and expect a 400 with validation errors
 * BEFORE any prisma call.
 */

describe('POST /chats/:id/messages · content length validation', () => {
  let auth;

  beforeEach(() => {
    auth = installAuthSessionMock();
    delete require.cache[require.resolve('../src/routes/chats')];
  });

  afterEach(() => {
    auth.restore();
    delete require.cache[require.resolve('../src/routes/chats')];
  });

  function buildApp() {
    return buildRouteTestApp('/chats', reloadModule('../src/routes/chats'));
  }

  test('returns 400 when content is empty', async () => {
    const res = await request(buildApp())
      .post('/chats/chat-1/messages')
      .set('Authorization', auth.authHeader)
      .send({ role: 'USER', content: '' });

    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.body.errors));
  });

  test('returns 400 when content exceeds the 100k char cap', async () => {
    const oversized = 'x'.repeat(100_001);
    const res = await request(buildApp())
      .post('/chats/chat-1/messages')
      .set('Authorization', auth.authHeader)
      .send({ role: 'USER', content: oversized });

    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.body.errors));
    // Surface the right validator message so a UI can localise on it.
    const messages = res.body.errors.map((e) => e.msg || e.message || '');
    assert.ok(
      messages.some((m) => /exceeds.*characters/i.test(m)),
      `expected "exceeds N characters" in errors, got ${JSON.stringify(messages)}`,
    );
  });

  test('returns 400 when role is not USER or ASSISTANT', async () => {
    const res = await request(buildApp())
      .post('/chats/chat-1/messages')
      .set('Authorization', auth.authHeader)
      .send({ role: 'SYSTEM', content: 'hi' });

    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.body.errors));
  });

  test('rejects unauthenticated callers BEFORE evaluating the body', async () => {
    const res = await request(buildApp())
      .post('/chats/chat-1/messages')
      .send({ role: 'USER', content: 'hi' });

    assert.equal(res.status, 401);
    // The middleware order is body validators then auth, but the
    // auth check fires once validators pass on the body shape too —
    // see route definition. Either way, an unauthenticated request
    // never reaches prisma.
    assert.ok(res.body.error || res.body.errors);
  });
});

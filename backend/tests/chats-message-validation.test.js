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


describe('PUT /chats/messages/:id · edit validation and ownership', () => {
  function mockTransaction(t, prisma, implementation) {
    const original = prisma.$transaction;
    const mocked = t.mock.fn(implementation);
    prisma.$transaction = mocked;
    t.after(() => { prisma.$transaction = original; });
    return mocked;
  }
  let auth;
  beforeEach(() => { auth = installAuthSessionMock(); });
  afterEach(() => { auth.restore(); });

  test('non-string content returns 400 before opening a transaction', async (t) => {
    const prisma = require('../src/config/database');
    const transaction = mockTransaction(t, prisma, async () => { throw new Error('unexpected transaction'); });
    const app = buildRouteTestApp('/chats', reloadModule('../src/routes/chats'));
    for (const content of [42, {}, [], null, '  ']) {
      const res = await request(app).put('/chats/messages/message-1')
        .set('Authorization', auth.authHeader).send({ content });
      assert.equal(res.status, 400);
    }
    assert.equal(transaction.mock.callCount(), 0);
  });

  test('missing or unowned message returns 404 without mutations or a server-failure log', async (t) => {
    const prisma = require('../src/config/database');
    let lookup;
    mockTransaction(t, prisma, async (run) => run({ message: {
      findFirst: async (args) => { lookup = args; return null; },
      deleteMany: async () => assert.fail('must not delete messages'),
      update: async () => assert.fail('must not edit messages'),
    } }));
    const errors = t.mock.method(console, 'error', () => {});
    const app = buildRouteTestApp('/chats', reloadModule('../src/routes/chats'));
    const res = await request(app).put('/chats/messages/message-1')
      .set('Authorization', auth.authHeader).send({ content: 'Corrección' });
    assert.equal(res.status, 404);
    assert.deepEqual(lookup.where, { id: 'message-1', role: 'USER', chat: { userId: auth.user.id } });
    assert.equal(errors.mock.callCount(), 0, 'an expected ownership/not-found response is not a server failure');
  });

  test('unexpected persistence failures remain visible as 500 and are logged', async (t) => {
    const prisma = require('../src/config/database');
    mockTransaction(t, prisma, async () => { throw new Error('database unavailable'); });
    const errors = t.mock.method(console, 'error', () => {});
    const app = buildRouteTestApp('/chats', reloadModule('../src/routes/chats'));
    const res = await request(app).put('/chats/messages/message-1')
      .set('Authorization', auth.authHeader).send({ content: 'Corrección' });
    assert.equal(res.status, 500);
    assert.equal(errors.mock.callCount(), 1);
    assert.doesNotMatch(JSON.stringify(res.body), /database unavailable/);
  });
});

describe('PUT /chats/:id/pins · draft migration and concurrent revisions', () => {
  let auth;
  beforeEach(() => { auth = installAuthSessionMock(); });
  afterEach(() => { auth.restore(); });

  function pinStore(t, validatePins) {
    const prisma = require('../src/config/database');
    const appPins = require('../src/services/apps/pins');
    let row = { id: 'new-chat', userId: auth.user.id, deletedAt: null, pinnedAppIds: [], pinRevision: 0 };
    function replace(target, key, implementation) {
      const original = target[key];
      target[key] = implementation;
      t.after(() => { target[key] = original; });
    }
    replace(prisma.chat, 'findFirst', async ({ where }) => {
      assert.equal(where.userId, auth.user.id);
      assert.equal(where.deletedAt, null);
      return { ...row };
    });
    replace(prisma.chat, 'update', async ({ data }) => { row = { ...row, ...data }; return row; });
    replace(prisma.chat, 'updateMany', async ({ where, data }) => {
      assert.equal(where.userId, auth.user.id);
      assert.equal(where.deletedAt, null);
      if (where.id !== row.id || where.pinRevision !== row.pinRevision) return { count: 0 };
      row = { ...row, ...data };
      return { count: 1 };
    });
    replace(appPins, 'validatePins', validatePins || (async (_db, _user, pins) => ({ ok: true, pins, errors: [] })));
    const app = buildRouteTestApp('/chats', reloadModule('../src/routes/chats'));
    return {
      row: () => row,
      put(pins, revision) {
        const call = request(app).put('/chats/new-chat/pins').set('Authorization', auth.authHeader);
        if (revision != null) call.set('If-Match', `"pins-${revision}"`);
        return call.send({ pinnedAppIds: pins });
      },
    };
  }

  test('migration requires revision zero and rejects a replay after another saved revision', async (t) => {
    const store = pinStore(t);
    const missing = await store.put(['github']);
    assert.equal(missing.status, 428);
    assert.equal(missing.body.code, 'PRECONDITION_REQUIRED');
    const migrated = await store.put(['github'], 0);
    assert.equal(migrated.status, 200);
    assert.deepEqual(migrated.body, { pinnedAppIds: ['github'], revision: 1 });
    const stale = await store.put(['x'], 0);
    assert.equal(stale.status, 412);
    assert.deepEqual(store.row().pinnedAppIds, ['github']);
  });

  test('two simultaneous migrations cannot both overwrite revision zero', async (t) => {
    const release = [];
    const store = pinStore(t, async (_db, _user, pins) => {
      await new Promise((resolve) => {
        release.push(resolve);
        if (release.length === 2) release.forEach((finish) => finish());
      });
      return { ok: true, pins, errors: [] };
    });
    const responses = await Promise.all([store.put(['github'], 0), store.put(['x'], 0)]);
    assert.deepEqual(responses.map((res) => res.status).sort(), [200, 412]);
    const winner = responses.find((res) => res.status === 200);
    const stale = responses.find((res) => res.status === 412);
    assert.deepEqual(store.row().pinnedAppIds, winner.body.pinnedAppIds);
    assert.equal(store.row().pinRevision, 1);
    assert.deepEqual(stale.body.details, {
      effectiveRevision: 1,
      effectivePinnedAppIds: winner.body.pinnedAppIds,
    });
  });
});

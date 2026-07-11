const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const prisma = require('../src/config/database');
const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');
const {
  emitUserSessionsRevoked,
} = require('../src/services/auth/user-session-revocation-events');

const COMPUTER_WS_SECRET = 'computer-use-ws-session-secret-at-least-32-characters';

function waitWsMessage(client, predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('message', onMessage);
      reject(new Error('timeout waiting for websocket message'));
    }, timeoutMs);
    timer.unref?.();
    function onMessage(raw) {
      let parsed;
      try { parsed = JSON.parse(String(raw)); } catch { return; }
      if (!predicate || predicate(parsed)) {
        clearTimeout(timer);
        client.off('message', onMessage);
        resolve(parsed);
      }
    }
    client.on('message', onMessage);
  });
}

function waitWsClose(client, timeoutMs = 750) {
  return Promise.race([
    new Promise((resolve) => {
      client.once('close', (code, reason) => {
        resolve({ code, reason: String(reason || '') });
      });
    }),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for websocket close')), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

describe('Computer Use HTTP route auth boundaries', () => {
  let auth;
  let previousOpenAiKey;
  let previousBaseUrl;
  let previousFetch;
  let computerUseModule;
  let originalChatFindFirst;
  let originalChatCreate;
  let originalMessageCreate;

  beforeEach(() => {
    previousOpenAiKey = process.env.OPENAI_API_KEY;
    previousBaseUrl = process.env.BASE_URL;
    previousFetch = global.fetch;
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
    process.env.BASE_URL = 'http://computer-use-test.local';
    auth = installAuthSessionMock();
    originalChatFindFirst = prisma.chat.findFirst;
    originalChatCreate = prisma.chat.create;
    originalMessageCreate = prisma.message.create;
    computerUseModule = reloadModule('../src/routes/computer-use');
    computerUseModule.activeSessions.clear();
  });

  afterEach(() => {
    computerUseModule?.activeSessions?.clear();
    prisma.chat.findFirst = originalChatFindFirst;
    prisma.chat.create = originalChatCreate;
    prisma.message.create = originalMessageCreate;
    auth.restore();
    global.fetch = previousFetch;
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
    if (previousBaseUrl === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = previousBaseUrl;
  });

  function buildApp() {
    return buildRouteTestApp('/api/computer-use', computerUseModule.router);
  }

  test('requires auth for browser-control and report endpoints', async () => {
    const app = buildApp();

    const cases = [
      request(app).post('/api/computer-use/start').send({ task: 'open docs', sessionId: 's1' }),
      request(app).post('/api/computer-use/resume').send({ sessionId: 's1' }),
      request(app).post('/api/computer-use/stop').send({ sessionId: 's1' }),
      request(app).post('/api/computer-use/chat-integration').send({ message: 'go', chatId: 'c1', userId: 'other-user' }),
      request(app).post('/api/computer-use/acknowledge-safety').send({ sessionId: 's1', callId: 'call-1' }),
      request(app).post('/api/computer-use/generate-html').send({ extractedData: { title: 'x' } }),
      request(app).get('/api/computer-use/capabilities'),
      request(app).get('/api/computer-use/status/s1'),
    ];

    for (const pending of cases) {
      const res = await pending;
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'Access token required');
    }
  });

  test('capabilities endpoint is authenticated and advertises browser controls', async () => {
    const res = await request(buildApp())
      .get('/api/computer-use/capabilities')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.capabilities.mode, 'openclaw_style_browser');
    assert.equal(res.body.capabilities.safety.requiresAuth, true);
    assert.ok(res.body.capabilities.actions.includes('navigate'));
    assert.ok(res.body.capabilities.actions.includes('screenshot'));
  });

  test('does not expose another user session status', async () => {
    computerUseModule.activeSessions.set('session-owned-elsewhere', {
      userId: 'another-user',
      status: 'running',
      task: 'private task',
    });

    const res = await request(buildApp())
      .get('/api/computer-use/status/session-owned-elsewhere')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Session not found');
  });

  test('chat integration uses the authenticated user instead of client supplied userId', async () => {
    let createdChatData = null;
    let createdMessageData = null;
    let forwardedStartRequest = null;

    prisma.chat.findFirst = async () => null;
    prisma.chat.create = async ({ data }) => {
      createdChatData = data;
      return { id: data.id, ...data };
    };
    prisma.message.create = async ({ data }) => {
      createdMessageData = data;
      return { id: 'message-1', ...data };
    };
    global.fetch = async (url, options) => {
      forwardedStartRequest = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, sessionId: 'session-from-start' }),
      };
    };

    const res = await request(buildApp())
      .post('/api/computer-use/chat-integration')
      .set('Authorization', auth.authHeader)
      .send({
        message: 'search for public docs',
        chatId: 'chat-1',
        userId: 'attacker-controlled-user-id',
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(createdChatData.userId, auth.user.id);
    assert.equal(createdMessageData.chatId, 'chat-1');
    assert.equal(forwardedStartRequest.url, 'http://computer-use-test.local/api/computer-use/start');
    assert.equal(forwardedStartRequest.options.headers.Authorization, `Bearer ${auth.token}`);
    assert.equal(JSON.parse(forwardedStartRequest.options.body).userId, undefined);
  });
});

test('computer-use websocket shutdown terminates clients, awaits close, and is idempotent', async (t) => {
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
  const modulePath = require.resolve('../src/routes/computer-use');
  delete require.cache[modulePath];
  const computerUse = require(modulePath);
  const server = http.createServer();
  let client;

  t.after(async () => {
    try { client?.terminate(); } catch {}
    try { await computerUse.closeComputerUseWebSocketServer?.(); } catch {}
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    delete require.cache[modulePath];
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
  });

  computerUse.initializeWebSocketServer(server);
  const port = await new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });
  client = new WebSocket(`ws://127.0.0.1:${port}/ws/computer-use`);
  await new Promise((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
  assert.equal(server.listenerCount('upgrade'), 1);
  const clientClosed = new Promise((resolve) => {
    client.once('close', (code) => resolve(code));
  });

  const first = computerUse.closeComputerUseWebSocketServer();
  const second = computerUse.closeComputerUseWebSocketServer();

  assert.ok(first instanceof Promise);
  assert.strictEqual(second, first);
  await Promise.all([first, clientClosed]);
  assert.equal(server.listenerCount('upgrade'), 0);
  assert.strictEqual(computerUse.closeComputerUseWebSocketServer(), first);
});

describe('Computer Use WebSocket active-session authentication', { concurrency: false }, () => {
  async function startSocketHarness({ sessionRow }) {
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousSecret = process.env.JWT_SECRET;
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
    process.env.JWT_SECRET = COMPUTER_WS_SECRET;
    const computerUse = reloadModule('../src/routes/computer-use');
    const token = jwt.sign({ userId: 'computer-user' }, COMPUTER_WS_SECRET, { expiresIn: '1h' });
    let lookups = 0;
    const deletes = [];
    const prismaClient = {
      session: {
        async findUnique() {
          lookups += 1;
          return typeof sessionRow === 'function' ? sessionRow(token) : sessionRow;
        },
        async deleteMany({ where }) {
          deletes.push(where);
          return { count: 1 };
        },
      },
    };
    const server = http.createServer();
    const socketServer = computerUse.initializeWebSocketServer(server, {
      prismaClient,
      jwtSecret: COMPUTER_WS_SECRET,
    });
    const port = await new Promise((resolve) => {
      server.listen(0, () => resolve(server.address().port));
    });
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/computer-use`);
    await new Promise((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });
    return {
      computerUse,
      token,
      client,
      server,
      socketServer,
      deletes,
      get lookups() { return lookups; },
      async close() {
        try { client.terminate(); } catch {}
        try { await computerUse.closeComputerUseWebSocketServer(); } catch {}
        if (server.listening) await new Promise((resolve) => server.close(resolve));
        if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previousOpenAiKey;
        if (previousSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = previousSecret;
      },
    };
  }

  test('rejects a signed JWT when its persisted session is missing or revoked', async (t) => {
    const harness = await startSocketHarness({ sessionRow: null });
    t.after(() => harness.close());

    harness.client.send(JSON.stringify({
      type: 'join-session',
      sessionId: 'computer-session',
      token: harness.token,
    }));
    const closed = await waitWsClose(harness.client);

    assert.equal(closed.code, 1008);
    assert.equal(harness.lookups, 1);
  });

  test('rejects a user deleted after JWT issuance and revokes the session family', async (t) => {
    const harness = await startSocketHarness({
      sessionRow: (token) => ({
        id: 'deleted-session',
        token,
        userId: 'computer-user',
        expiresAt: new Date(Date.now() + 60_000),
        fingerprint: null,
        user: { id: 'computer-user', deletedAt: new Date() },
      }),
    });
    t.after(() => harness.close());

    harness.client.send(JSON.stringify({
      type: 'join-session',
      sessionId: 'computer-session',
      token: harness.token,
    }));
    const closed = await waitWsClose(harness.client);

    assert.equal(closed.code, 1008);
    assert.equal(harness.lookups, 1);
    assert.deepEqual(harness.deletes, [{ userId: 'computer-user' }]);
  });

  test('post-index validation closes a join that raced persisted-session revocation', async (t) => {
    let reads = 0;
    const harness = await startSocketHarness({
      sessionRow: (token) => {
        reads += 1;
        if (reads > 1) return null;
        return {
          id: 'racing-session',
          token,
          userId: 'computer-user',
          expiresAt: new Date(Date.now() + 60_000),
          fingerprint: null,
          user: { id: 'computer-user', deletedAt: null },
        };
      },
    });
    t.after(() => harness.close());

    const closing = waitWsClose(harness.client);
    harness.client.send(JSON.stringify({
      type: 'join-session',
      sessionId: 'computer-session',
      token: harness.token,
    }));
    const closed = await closing;

    assert.equal(closed.code, 1008);
    assert.equal(harness.lookups, 2);
    assert.equal(harness.socketServer.userIndex?.has('computer-user'), false);
  });

  test('validates an active session once and reuses socket auth for later commands', async (t) => {
    const harness = await startSocketHarness({
      sessionRow: (token) => ({
        id: 'active-session',
        token,
        userId: 'computer-user',
        expiresAt: new Date(Date.now() + 60_000),
        fingerprint: null,
        user: { id: 'computer-user', deletedAt: null },
      }),
    });
    t.after(() => harness.close());
    harness.computerUse.activeSessions.set('computer-session', {
      userId: 'computer-user',
      status: 'running',
      events: [{ type: 'session-started', data: { sessionId: 'computer-session' } }],
    });

    const replay = waitWsMessage(harness.client, (message) => message.type === 'session-started');
    harness.client.send(JSON.stringify({
      type: 'join-session',
      sessionId: 'computer-session',
      token: harness.token,
    }));
    await replay;

    const paused = waitWsMessage(harness.client, (message) => message.type === 'takeover-state');
    harness.client.send(JSON.stringify({ type: 'pause-session' }));
    await paused;
    assert.equal(harness.lookups, 2);
  });

  test('periodic revalidation closes an authenticated socket after a missed revocation event', async (t) => {
    let persisted = true;
    const harness = await startSocketHarness({
      sessionRow: (token) => (persisted ? {
        id: 'active-session',
        token,
        userId: 'computer-user',
        expiresAt: new Date(Date.now() + 60_000),
        fingerprint: null,
        user: { id: 'computer-user', deletedAt: null },
      } : null),
    });
    t.after(() => harness.close());
    harness.computerUse.activeSessions.set('computer-session', {
      userId: 'computer-user',
      status: 'running',
      events: [{ type: 'session-started', data: { sessionId: 'computer-session' } }],
    });

    const replay = waitWsMessage(harness.client, (message) => message.type === 'session-started');
    harness.client.send(JSON.stringify({
      type: 'join-session',
      sessionId: 'computer-session',
      token: harness.token,
    }));
    await replay;
    assert.equal(harness.lookups, 2);

    persisted = false;
    const closing = waitWsClose(harness.client);
    assert.equal(typeof harness.socketServer.revalidateAuthenticatedSockets, 'function');
    await harness.socketServer.revalidateAuthenticatedSockets();
    const closed = await closing;

    assert.equal(closed.code, 1008);
    assert.equal(harness.lookups, 3);
  });

  test('user-deletion broadcast closes an authenticated computer-use socket', async (t) => {
    const harness = await startSocketHarness({
      sessionRow: (token) => ({
        id: 'active-session',
        token,
        userId: 'computer-user',
        expiresAt: new Date(Date.now() + 60_000),
        fingerprint: null,
        user: { id: 'computer-user', deletedAt: null },
      }),
    });
    t.after(() => harness.close());
    harness.computerUse.activeSessions.set('computer-session', {
      userId: 'computer-user',
      status: 'running',
      events: [{ type: 'session-started', data: { sessionId: 'computer-session' } }],
    });

    const replay = waitWsMessage(harness.client, (message) => message.type === 'session-started');
    harness.client.send(JSON.stringify({
      type: 'join-session',
      sessionId: 'computer-session',
      token: harness.token,
    }));
    await replay;

    const closing = waitWsClose(harness.client);
    emitUserSessionsRevoked({
      userId: 'computer-user',
      reason: 'account_deleted',
    });
    const closed = await closing;
    assert.equal(closed.code, 1008);
    assert.equal(closed.reason, 'account_deleted');
  });
});

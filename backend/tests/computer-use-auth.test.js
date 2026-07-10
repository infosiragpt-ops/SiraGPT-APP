const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const request = require('supertest');

const prisma = require('../src/config/database');
const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');

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

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
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

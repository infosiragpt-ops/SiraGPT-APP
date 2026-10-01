'use strict';

// Run the registered media handlers with offline DB/HTTP boundaries. This
// keeps the actual route control flow, without booting unrelated AI services.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { checkPaidTokenCap } = require('../src/services/plan-quota');
const { buildFalVideoInputPayload, validateFalVideoSettings, resolveFalVideoModelRequest } = require('../src/services/fal-video-model-catalog');

const aiFile = path.resolve(__dirname, '../src/routes/ai.js');
const aiSource = fs.readFileSync(aiFile, 'utf8');
const videoFile = path.resolve(__dirname, '../src/routes/video.js');
const videoSource = fs.readFileSync(videoFile, 'utf8');
const resolveVeoFastDuration = vm.runInNewContext(`(${videoSource.slice(
  videoSource.indexOf('function resolveVeoFastDuration('),
  videoSource.indexOf('// Enhanced video generation with Fal.ai', videoSource.indexOf('function resolveVeoFastDuration(')),
).trim()})`);
const schema = fs.readFileSync(path.resolve(__dirname, '../prisma/schema.prisma'), 'utf8');
const messageFields = new Set([...schema.match(/model Message \{([\s\S]*?)\n\}/)[1].matchAll(/^\s+(\w+)\s+\w/gm)].map((match) => match[1]));
const chain = new Proxy(() => {}, { get: () => () => chain });
const plain = (value) => JSON.parse(JSON.stringify(value));
const silentConsole = { log() {}, warn() {}, error() {} };
function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function aiHarness({ chatUserId = 'owner', chatDeleted = false, serviceError = null } = {}) {
  const handlers = new Map();
  const calls = { http: [], history: [], chat: [], saved: [], usage: [], failures: [] };
  const recentMessages = [
    { timestamp: 3, deletedAt: null, files: JSON.stringify([{ type: 'video', prompt: 'tercer clip', model: 'selected-video' }]) },
    { timestamp: 2, deletedAt: new Date(), files: JSON.stringify([{ type: 'video', prompt: 'clip eliminado' }]) },
    { timestamp: 1, deletedAt: null, files: JSON.stringify([{ type: 'video', prompt: 'primer clip' }]) },
  ];
  const prisma = {
    aiModel: { findUnique: async () => ({ displayName: 'Selected video', type: 'VIDEO', isActive: true }) },
    chat: {
      findFirst: async ({ where }) => {
        calls.chat.push(plain(where));
        if (where.id !== 'chat' || where.userId !== chatUserId || (where.deletedAt === null && chatDeleted)) return null;
        return { id: 'chat', title: 'Videos' };
      },
      update: async () => ({}),
    },
    message: {
      findMany: async (query) => {
        calls.history.push(plain(query));
        // Model-derived validation reproduces Prisma's rejection of invented
        // timestamp fields instead of allowing any query shape in the stub.
        for (const field of Object.keys(query.orderBy || {})) {
          if (!messageFields.has(field)) throw new Error(`Unknown argument ${field}`);
        }
        if (!query.where.chatId) return [];
        return recentMessages.filter((row) => query.where.deletedAt !== null || row.deletedAt === null);
      },
      create: async ({ data }) => { calls.saved.push(data); return { id: `msg-${calls.saved.length}` }; },
      update: async () => ({}),
    },
  };
  async function internal(method, url, body, options) {
    calls.http.push({ method, url, body, options });
    // The real inner routes authenticate independently. Cookie auth on the
    // outer route must become a Bearer token on this loopback request.
    if (options.headers.Authorization !== 'Bearer authenticated-test-session') {
      throw { response: { status: 401, data: { code: 'access_token_required', error: 'Access token required' } } };
    }
    if (serviceError) throw { response: serviceError };
    return { data: { operationId: 'op', filename: 'video.mp4', status: method === 'get' ? 'processing' : 'cancelled' } };
  }
  const nativeRequire = createRequire(aiFile);
  vm.runInNewContext(aiSource.slice(
    aiSource.indexOf("router.post(\n  '/generate-video',"),
    aiSource.indexOf('// ADD helper (place above router.post'),
  ), {
    router: {
      post: (url, ...args) => handlers.set(`POST ${url}`, args.at(-1)),
      get: (url, ...args) => handlers.set(`GET ${url}`, args.at(-1)),
    },
    body: () => chain, authenticateToken() {}, requirePaidPlan: () => () => {},
    validationResult: () => ({ isEmpty: () => true }),
    require: (name) => name === 'axios' ? {
      post: (url, body, options) => internal('post', url, body, options),
      get: (url, options) => internal('get', url, null, options),
    } : nativeRequire(name),
    process: { env: { PORT: '5000' } }, console: silentConsole,
    modelSyncService: { ensureStaticCatalogModels: async () => {} }, prisma, checkPaidTokenCap,
    recordApiUsage: async (args) => { calls.usage.push(args); return {}; }, usagePayloadFor: () => ({}),
    turnFailures: { recordGenerationFailure: async (_req, failure) => { calls.failures.push(failure); } },
  }, { filename: aiFile });
  return {
    calls,
    async request(route = 'POST /generate-video', { body = {}, transport = 'cookie', user = {} } = {}) {
      const res = response();
      await handlers.get(route)({
        body: { prompt: 'continúa el clip', chatId: 'chat', model: 'selected-video', ...body },
        params: { operationId: 'op' },
        user: { id: 'owner', plan: 'PRO', apiUsage: 10, monthlyLimit: 1000, ...user },
        // authenticateToken has already validated and populated this token.
        token: 'authenticated-test-session',
        cookies: transport === 'cookie' ? { token: 'authenticated-test-session' } : {},
        headers: { 'user-agent': 'Synthetic browser', ...(transport === 'bearer' ? { authorization: 'Bearer authenticated-test-session' } : {}) },
        ip: '203.0.113.10',
      }, res);
      return res;
    },
  };
}

test('cookie and Bearer sessions survive video generate, status and cancel loopback', async () => {
  for (const transport of ['cookie', 'bearer']) {
    for (const route of ['POST /generate-video', 'GET /video-status/:operationId', 'POST /video-cancel/:operationId']) {
      const { request, calls } = aiHarness();
      const res = await request(route, { transport, body: { chatId: null } });
      assert.equal(res.statusCode, 200, `${transport} ${route}: ${JSON.stringify(res.body)}`);
      assert.equal(calls.http.length, 1);
      const { url, options } = calls.http[0];
      assert.ok(url.startsWith('http://127.0.0.1:5000/api/video/'));
      assert.equal(options.headers.Authorization, 'Bearer authenticated-test-session');
      assert.equal(options.headers['User-Agent'], 'Synthetic browser');
      assert.equal(options.headers['X-Forwarded-For'], '203.0.113.10');
      assert.equal(options.headers.Cookie, undefined);
    }
  }
});

test('continuity queries real timestamp and sends only nondeleted clips in order', async () => {
  const { request, calls } = aiHarness();
  const res = await request('POST /generate-video', { transport: 'bearer' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(plain(calls.http[0].body.history?.map((clip) => clip.prompt) || []), ['primer clip', 'tercer clip']);
  assert.equal(calls.history[0].orderBy.timestamp, 'desc');
  assert.equal(calls.history[0].where.deletedAt, null);
  assert.equal(calls.saved.length, 2);
  assert.equal(calls.usage.length, 1);
});

test('foreign and deleted chats fail before history, internal generation or writes', async () => {
  for (const setup of [{ chatUserId: 'other' }, { chatDeleted: true }]) {
    const { request, calls } = aiHarness(setup);
    const res = await request('POST /generate-video', { transport: 'bearer' });
    assert.equal(res.statusCode, 404);
    assert.equal(calls.history.length, 0);
    assert.equal(calls.http.length, 0);
    assert.equal(calls.saved.length, 0);
    assert.equal(calls.usage.length, 0);
  }
});

test('provider rejection remains a failure without saved processing message or usage', async () => {
  const { request, calls } = aiHarness({ serviceError: { status: 403, data: { code: 'provider_auth_failed', error: 'Provider rejected credentials' } } });
  const res = await request('POST /generate-video', { transport: 'bearer' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'provider_auth_failed');
  assert.equal(calls.saved.length, 0);
  assert.equal(calls.usage.length, 0);
  assert.equal(calls.failures.length, 1);
});

function serviceHarness({ user = {}, usage = 1000 } = {}) {
  let handler;
  let validators = [];
  const inputValidation = require('express-validator');
  const calls = { generated: 0, usage: 0, operations: new Map(), requests: [] };
  vm.runInNewContext(videoSource.slice(
    videoSource.indexOf("\nrouter.post('/generate', ["),
    videoSource.indexOf('\nfunction normalizeVideoImageUrls'),
  ), {
    router: { post: (_url, ...args) => { handler = args.at(-1); validators = args.flat().filter((item) => typeof item.run === 'function'); } },
    body: inputValidation.body, authenticateToken() {}, requirePaidPlan: () => () => {},
    validationResult: inputValidation.validationResult, console: silentConsole,
    resolveFalApiKey: async () => ({ apiKey: 'synthetic-provider-key', source: 'test' }), fal: { config() {} },
    resolveFalVideoModelRequest: (model) => model === 'selected-video' ? ({ ok: true, endpoint: model }) : resolveFalVideoModelRequest(model),
    buildFalVideoInputPayload, validateFalVideoSettings,
    resolveVeoFastDuration, getRecentVideoHistoryForUser: () => [],
    videoPromptDirector: { directVideoPrompt: () => null }, checkPaidTokenCap,
    prisma: { apiUsage: { aggregate: async () => ({ _sum: { tokens: usage } }), create: async () => { calls.usage++; } } },
    generateOperationId: () => 'op', randomUUID: () => 'fixture-uuid', activeOperations: calls.operations,
    generateVideoAsync: async (...args) => { calls.generated++; calls.requests.push(args); },
  }, { filename: videoFile });
  return {
    calls,
    async request(body = {}) {
      const res = response();
      const req = { body: { prompt: 'synthetic video', model: 'selected-video', ...body }, user: { id: 'owner', plan: 'PRO', monthlyLimit: 500, ...user } };
      for (const validator of validators) await validator.run(req);
      await handler(req, res);
      return res;
    },
  };
}

test('inner video gate preserves paid cap and honors canonical unlimited exemptions', async () => {
  for (const { user, expected } of [
    { user: {}, expected: 429 },
    { user: { isAdmin: true }, expected: 429 },
    { user: { isSuperAdmin: true }, expected: 200 },
    { user: { monthlyLimit: 0 }, expected: 200 },
  ]) {
    const { request, calls } = serviceHarness({ user });
    const res = await request();
    assert.equal(res.statusCode, expected, JSON.stringify(user));
    assert.equal(calls.generated, expected === 200 ? 1 : 0);
    assert.equal(calls.usage, expected === 200 ? 1 : 0);
  }
});

const omniModel = 'google/gemini-omni-flash/v1.1/text-to-video';

test('unsupported selected video settings fail before operation, provider and usage', async () => {
  for (const settings of [{ resolution: '480p' }, { audio: false }, { audio: 'false' }, { audio: '0' }, { aspect_ratio: '1:1' }, { duration: 11 }]) {
    const { request, calls } = serviceHarness({ user: { isSuperAdmin: true } });
    const res = await request({ model: omniModel, resolution: '720p', duration: 8, audio: true, ...settings });
    assert.equal(res.statusCode, 422, JSON.stringify(settings));
    assert.equal(res.body.code, 'E_PARAMS');
    assert.ok(typeof res.body.message === 'string' && res.body.message.length > 20);
    assert.doesNotMatch(res.body.message, /fal\.ai|google\/|gemini|Bearer|api.?key/i);
    assert.equal(calls.generated, 0);
    assert.equal(calls.usage, 0);
    assert.equal(calls.operations.size, 0);
  }
});

test('valid selected video settings reach generation without silent duration clamp', async () => {
  const { request, calls } = serviceHarness({ user: { isSuperAdmin: true } });
  const res = await request({ model: omniModel, resolution: '360p', duration: 3, audio: true, aspect_ratio: '9:16' });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.generated, 1);
  assert.equal(calls.usage, 1);
  const args = calls.requests[0];
  assert.equal(args[2], '9:16');
  assert.equal(args[3], '3s');
  assert.equal(args[8], omniModel);
  assert.equal(args[9], '360p');
  assert.equal(args[10], true);
  const payload = buildFalVideoInputPayload({ endpoint: args[8], prompt: args[1], aspectRatio: args[2], duration: args[3], resolution: args[9], audio: args[10] });
  assert.deepEqual(payload, { prompt: 'synthetic video', aspect_ratio: '9:16', duration: 3, resolution: '360p' });
});

test('outer video request preserves actionable parameter errors and makes no writes', async () => {
  const message = 'El modelo seleccionado no admite 480p. Elige 360p, 720p, 1080p o 4k.';
  const { request, calls } = aiHarness({ serviceError: { status: 422, data: { code: 'E_PARAMS', message, error: message } } });
  const res = await request('POST /generate-video', { body: { model: omniModel, resolution: '480p' } });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.code, 'E_PARAMS');
  assert.equal(res.body.message || res.body.error, message);
  assert.equal(calls.saved.length, 0);
  assert.equal(calls.usage.length, 0);
});

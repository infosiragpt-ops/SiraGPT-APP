'use strict';

/**
 * Tests for /api/opencode/* — the bridge to the OpenCode engine.
 * Auth is stubbed via the require cache; the upstream engine is simulated by
 * stubbing global fetch. No network, no Bun, no running server.
 */

const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { mockResolvedModule } = require('./http-test-utils');

const authPath = require.resolve('../src/middleware/auth');
const restoreAuth = mockResolvedModule(authPath, {
  authenticateToken(req, _res, next) { req.user = { id: 'u-1' }; next(); },
});

const opencodeRoutes = require('../src/routes/opencode');
after(() => restoreAuth());

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/opencode', opencodeRoutes);
  return app;
}

const URL_ENV = 'OPENCODE_SERVER_URL';
let savedUrl;
let savedFetch;

beforeEach(() => { savedUrl = process.env[URL_ENV]; savedFetch = globalThis.fetch; });
afterEach(() => {
  if (savedUrl === undefined) delete process.env[URL_ENV];
  else process.env[URL_ENV] = savedUrl;
  globalThis.fetch = savedFetch;
});

function stubFetch(body = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => body };
  };
  return calls;
}

test('GET /health reports unconfigured without a server URL', async () => {
  delete process.env[URL_ENV];
  const res = await request(buildApp()).get('/api/opencode/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.configured, false);
  assert.equal(res.body.baseUrl, null);
});

test('GET /health reports the baseUrl when configured', async () => {
  process.env[URL_ENV] = 'http://127.0.0.1:4096';
  const res = await request(buildApp()).get('/api/opencode/health');
  assert.equal(res.body.configured, true);
  assert.equal(res.body.baseUrl, 'http://127.0.0.1:4096');
});

test('POST /session returns 503 when the engine is not configured', async () => {
  delete process.env[URL_ENV];
  const res = await request(buildApp()).post('/api/opencode/session').send({});
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'opencode_not_configured');
});

test('POST /session forwards to the engine when configured', async () => {
  process.env[URL_ENV] = 'http://127.0.0.1:4096';
  const calls = stubFetch({ id: 'sess-1' });
  const res = await request(buildApp()).post('/api/opencode/session').send({});
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.session, { id: 'sess-1' });
  assert.equal(calls[0].url, 'http://127.0.0.1:4096/session');
  assert.equal(calls[0].init.method, 'POST');
});

test('POST /session/:id/prompt validates that text is present', async () => {
  process.env[URL_ENV] = 'http://127.0.0.1:4096';
  const res = await request(buildApp()).post('/api/opencode/session/s1/prompt').send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'validation_failed');
});

test('POST /session/:id/prompt forwards the prompt to the engine', async () => {
  process.env[URL_ENV] = 'http://127.0.0.1:4096';
  const calls = stubFetch({ id: 'msg-1' });
  const res = await request(buildApp()).post('/api/opencode/session/s1/prompt').send({ text: 'hola' });
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, 'http://127.0.0.1:4096/session/s1/message');
  assert.deepEqual(JSON.parse(calls[0].init.body).parts, [{ type: 'text', text: 'hola' }]);
});

test('upstreamFail returns a generic 502 and never leaks the raw upstream message', () => {
  const realErr = console.error;
  console.error = () => {};
  try {
    const calls = {};
    const res = { status(c) { calls.status = c; return res; }, json(b) { calls.body = b; return res; } };
    const ret = opencodeRoutes.upstreamFail(res, new Error('opencode POST /session/secret-abc123 → HTTP 502'));
    assert.equal(ret, res);
    assert.equal(calls.status, 502);
    assert.equal(calls.body.error, 'opencode_upstream');
    assert.equal(calls.body.message, 'Upstream service error');
    assert.ok(!JSON.stringify(calls.body).includes('secret-abc123'), 'internal endpoint path must not leak to the client');
    opencodeRoutes.upstreamFail(res, new Error('boom'), 'runner_unreachable');
    assert.equal(calls.body.error, 'runner_unreachable');
  } finally {
    console.error = realErr;
  }
});

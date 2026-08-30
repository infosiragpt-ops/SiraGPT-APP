'use strict';

/**
 * Tests for /api/opencode/* — native SiraCode engine.
 * Auth is stubbed via the require cache. No network, no Bun, no sidecar.
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { mockResolvedModule } = require('./http-test-utils');
const siraCode = require('../src/services/sira-code');

const authPath = require.resolve('../src/middleware/auth');
const restoreAuth = mockResolvedModule(authPath, {
  authenticateToken(req, _res, next) { req.user = { id: 'u-1' }; next(); },
});

const opencodeRoutes = require('../src/routes/opencode');
after(() => {
  restoreAuth();
  siraCode._resetForTests();
});

function buildApp(llmTurn) {
  const app = express();
  app.use(express.json());
  if (llmTurn) app.set('siraCodeLlmTurn', llmTurn);
  app.use('/api/opencode', opencodeRoutes);
  return app;
}

beforeEach(() => {
  siraCode._resetForTests();
});

test('GET /health reports the native SiraCode engine without a sidecar URL', async () => {
  delete process.env.OPENCODE_SERVER_URL;
  const res = await request(buildApp()).get('/api/opencode/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.configured, true);
  assert.equal(res.body.native, true);
  assert.equal(res.body.engine, 'sira-code');
  assert.equal(res.body.baseUrl, null);
  assert.equal(res.body.sidecar, false);
});

test('GET /health ignores OPENCODE_SERVER_URL by default', async () => {
  process.env.OPENCODE_SERVER_URL = 'http://127.0.0.1:4096';
  const res = await request(buildApp()).get('/api/opencode/health');
  assert.equal(res.body.configured, true);
  assert.equal(res.body.baseUrl, null);
  assert.ok(!JSON.stringify(res.body).includes('4096'));
});

test('POST /session creates a native construir session', async () => {
  const res = await request(buildApp()).post('/api/opencode/session').send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.session.agent, 'construir');
  assert.equal(res.body.session.agentLabel, 'Construir');
  assert.match(res.body.session.id, /^sc_/);
});

test('POST /session accepts planificar', async () => {
  const res = await request(buildApp()).post('/api/opencode/session').send({ agent: 'planificar' });
  assert.equal(res.status, 200);
  assert.equal(res.body.session.agent, 'planificar');
});

test('POST /session/:id/prompt validates that text is present', async () => {
  const created = await request(buildApp()).post('/api/opencode/session').send({});
  const res = await request(buildApp()).post(`/api/opencode/session/${created.body.session.id}/prompt`).send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'validation_failed');
});

test('POST /session/:id/prompt runs the native loop', async () => {
  const app = buildApp(async () => ({ text: 'Listo.', toolCalls: [] }));
  const created = await request(app).post('/api/opencode/session').send({});
  const res = await request(app)
    .post(`/api/opencode/session/${created.body.session.id}/prompt`)
    .send({ text: 'hola' });
  assert.equal(res.status, 200);
  assert.equal(res.body.result.text, 'Listo.');
  assert.ok(!JSON.stringify(res.body).includes('DeepSeek'));
  assert.ok(!JSON.stringify(res.body).includes('OpenRouter'));
  assert.ok(!JSON.stringify(res.body).includes('model_id'));
});

test('POST /session/:id/agent switches to planificar', async () => {
  const created = await request(buildApp()).post('/api/opencode/session').send({});
  const res = await request(buildApp())
    .post(`/api/opencode/session/${created.body.session.id}/agent`)
    .send({ agent: 'planificar' });
  assert.equal(res.status, 200);
  assert.equal(res.body.session.agent, 'planificar');
});

test('POST /session/:id/abort cancels the session', async () => {
  const created = await request(buildApp()).post('/api/opencode/session').send({});
  const res = await request(buildApp()).post(`/api/opencode/session/${created.body.session.id}/abort`).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('planificar prompt cannot write via the HTTP API', async () => {
  let calls = 0;
  const app = buildApp(async () => {
    calls += 1;
    if (calls === 1) {
      return { text: '', toolCalls: [{ name: 'write', arguments: { path: 'x.txt', content: 'nope' } }] };
    }
    return { text: 'Plan.', toolCalls: [] };
  });
  const created = await request(app).post('/api/opencode/session').send({ agent: 'planificar' });
  const res = await request(app)
    .post(`/api/opencode/session/${created.body.session.id}/prompt`)
    .send({ text: 'escribe' });
  assert.equal(res.status, 200);
  const write = res.body.result.toolResults.find((t) => t.tool === 'write');
  assert.equal(write.ok, false);
  assert.equal(write.code, 'permission_denied');
});

test('GET /events streams SSE and abort emits Cancelado', async () => {
  const app = buildApp();
  const created = await request(app).post('/api/opencode/session').send({});
  const id = created.body.session.id;
  const stream = request(app)
    .get(`/api/opencode/events?sessionId=${id}`)
    .set('Accept', 'text/event-stream')
    .buffer(true)
    .parse((res, cb) => {
      let data = '';
      res.on('data', (c) => { data += c.toString(); });
      res.on('end', () => cb(null, data));
    });

  await new Promise((r) => setTimeout(r, 40));
  await request(app).post(`/api/opencode/session/${id}/abort`).send({});
  setTimeout(() => stream.abort(), 80);
  try {
    const res = await stream;
    const body = String(res.body || res.text || '');
    assert.match(body, /Cancelado|cancelled/);
  } catch (err) {
    if (err.code !== 'ECONNRESET' && err.code !== 'ABORTED') throw err;
  }
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

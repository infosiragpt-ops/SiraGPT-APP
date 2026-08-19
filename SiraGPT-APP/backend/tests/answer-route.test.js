'use strict';

/**
 * Route tests for /api/answer/* — in-process Express harness, no network/DB.
 * auth + response-cache are stubbed via require.cache, and the web-search
 * adapter's searchMany is stubbed so the engine answers from fixtures.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

// stub auth + response-cache before requiring the route
const authPath = require.resolve('../src/middleware/auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: { authenticateToken: (req, _res, next) => { req.user = { id: 'test-user' }; next(); } },
};
const rcPath = require.resolve('../src/middleware/response-cache');
require.cache[rcPath] = {
  id: rcPath, filename: rcPath, loaded: true,
  exports: { responseCache: () => (req, _res, next) => next() },
};

// stub the web-search adapter so the engine retrieves fixtures, no network
const wsPath = require.resolve('../src/services/agents/web-search');
require.cache[wsPath] = {
  id: wsPath, filename: wsPath, loaded: true,
  exports: {
    searchMany: async () => ({
      results: [
        { title: 'Solar energy basics', url: 'https://a.example/solar', snippet: 'Solar energy reduces electricity bills and cuts emissions.' },
        { title: 'Photovoltaics', url: 'https://b.example/pv', snippet: 'Photovoltaic panels convert sunlight into solar electricity.' },
        { title: 'Cooking', url: 'https://c.example/food', snippet: 'Pasta recipe with cheese.' },
      ],
      providers: ['duckduckgo', 'wikipedia'],
    }),
  },
};

const answerRoutes = require('../src/routes/answer');

let server; let baseURL;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/answer', answerRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

after(async () => { if (server) await new Promise((r) => server.close(r)); });

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(baseURL + path);
    const r = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => { let buf = ''; res.on('data', (c) => { buf += c; }); res.on('end', () => resolve({ status: res.statusCode, body: buf })); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test('POST /api/answer returns a cited answer from fixtures', async () => {
  const res = await req('POST', '/api/answer', { query: 'ventajas de la energía solar' });
  assert.equal(res.status, 200);
  const json = JSON.parse(res.body);
  assert.ok(json.answer.length > 0);
  assert.match(json.answer, /\[\d+\]/);
  assert.ok(Array.isArray(json.citations) && json.citations.length >= 1);
  assert.ok(json.sources.length >= 1);
  assert.equal(json.mode, 'fast');
  assert.ok(json.stats.candidates >= 3);
  assert.ok(json.relatedQuestions.length >= 1);
});

test('POST /api/answer rejects a missing query (400)', async () => {
  const res = await req('POST', '/api/answer', {});
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error, 'validation_failed');
});

test('GET /api/answer/health is ok with metrics', async () => {
  const res = await req('GET', '/api/answer/health');
  assert.equal(res.status, 200);
  const json = JSON.parse(res.body);
  assert.equal(json.ok, true);
  assert.ok(json.metrics && typeof json.metrics.requests === 'number');
});

test('GET /api/answer/metrics.prom exposes Prometheus text', async () => {
  const res = await req('GET', '/api/answer/metrics.prom');
  assert.equal(res.status, 200);
  assert.match(res.body, /sira_answer_requests_total/);
});

test('POST /api/answer/stream emits SSE phase + result + done events', async () => {
  const res = await req('POST', '/api/answer/stream', { query: 'energía solar electricidad' });
  assert.equal(res.status, 200);
  assert.match(res.body, /event: phase/);
  assert.match(res.body, /event: result/);
  assert.match(res.body, /event: done/);
});

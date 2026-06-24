'use strict';

/**
 * Route tests for /api/x-search/* — minimal in-process Express harness, no
 * network, no DB, no real auth. The auth + response-cache middlewares are
 * stubbed via require.cache BEFORE the route is loaded so we exercise the
 * validation + service delegation in isolation. XAI_API_KEY is left unset,
 * so the service takes its graceful configured:false path (no fetch).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

// --- stub auth + response-cache before requiring the route --------------
const authPath = require.resolve('../src/middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: { authenticateToken: (req, _res, next) => { req.user = { id: 'test-user' }; next(); } },
};
const rcPath = require.resolve('../src/middleware/response-cache');
require.cache[rcPath] = {
  id: rcPath,
  filename: rcPath,
  loaded: true,
  exports: { responseCache: () => (req, _res, next) => next() },
};

const xMetrics = require('../src/services/x-search-metrics');
const xSearchRoutes = require('../src/routes/x-search');

let server;
let baseURL;
let savedKey;

before(async () => {
  savedKey = process.env.XAI_API_KEY;
  delete process.env.XAI_API_KEY;
  const app = express();
  app.use(express.json());
  app.use('/api/x-search', xSearchRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseURL = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (savedKey === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = savedKey;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => xMetrics.reset());

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`${baseURL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, text, contentType: res.headers['content-type'] });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('GET /health reports configured:false with no key and includes metrics', async () => {
  const { status, text } = await request('GET', '/api/x-search/health');
  assert.equal(status, 200);
  const body = JSON.parse(text);
  assert.equal(body.ok, true);
  assert.equal(body.configured, false);
  assert.equal(typeof body.model, 'string');
  assert.equal(typeof body.metrics, 'object');
  // baseURL / apiKey must never leak
  assert.equal(body.baseURL, undefined);
  assert.equal(body.apiKey, undefined);
});

test('GET /metrics.prom returns Prometheus text exposition', async () => {
  const { status, text, contentType } = await request('GET', '/api/x-search/metrics.prom');
  assert.equal(status, 200);
  assert.match(contentType || '', /text\/plain/);
  assert.match(text, /sira_x_search_total/);
});

test('POST / with a valid body but no key returns 200 configured:false (no throw)', async () => {
  const { status, text } = await request('POST', '/api/x-search/', { query: 'breaking news' });
  assert.equal(status, 200);
  const body = JSON.parse(text);
  assert.equal(body.configured, false);
  assert.equal(body.query, 'breaking news');
  assert.equal(typeof body.note, 'string');
});

test('POST / with an empty query fails validation with 400', async () => {
  const { status, text } = await request('POST', '/api/x-search/', { query: '' });
  assert.equal(status, 400);
  assert.equal(JSON.parse(text).error, 'validation_failed');
});

test('POST / with a malformed fromDate fails validation with 400', async () => {
  const { status, text } = await request('POST', '/api/x-search/', { query: 'ok', fromDate: '01/01/2024' });
  assert.equal(status, 400);
  assert.equal(JSON.parse(text).error, 'validation_failed');
});

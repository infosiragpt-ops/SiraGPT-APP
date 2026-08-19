'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createIndexStore, sha256 } = require('../src/services/rag/index-store');

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, { method = 'GET', path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({
      host: '127.0.0.1', port, method, path, headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* ignore */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (body != null) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      req.write(payload);
    }
    req.end();
  });
}

async function buildApp({ store } = {}) {
  delete require.cache[require.resolve('../src/routes/document-index-internal')];
  const fresh = require('../src/routes/document-index-internal');
  if (store !== undefined) fresh.attachStore(store);
  const app = express();
  app.use('/internal/document-index', fresh.router);
  const server = await startServer(app);
  return { server, fresh };
}

test('GET /stats returns 503 when store not attached', async () => {
  const prev = process.env.DOC_INDEX_INTERNAL_TOKEN;
  delete process.env.DOC_INDEX_INTERNAL_TOKEN;
  const { server } = await buildApp({});
  try {
    const res = await request(server, { path: '/internal/document-index/stats' });
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'document_index_not_attached');
  } finally {
    server.close();
    if (prev !== undefined) process.env.DOC_INDEX_INTERNAL_TOKEN = prev;
  }
});

test('GET /stats returns metrics on loopback when no token set', async () => {
  const prev = process.env.DOC_INDEX_INTERNAL_TOKEN;
  delete process.env.DOC_INDEX_INTERNAL_TOKEN;
  const store = createIndexStore();
  await store.getOrCompute('h1', async () => ({
    chunks: [{ ord: 0 }], embeddings: [[1, 2, 3]], embedTokens: 5,
  }));
  const { server } = await buildApp({ store });
  try {
    const res = await request(server, { path: '/internal/document-index/stats' });
    assert.equal(res.status, 200);
    assert.equal(res.json.entries, 1);
    assert.equal(res.json.metrics.cacheMisses, 1);
    assert.equal(res.json.metrics.cacheHits, 0);
    assert.ok(Array.isArray(res.json.recent));
  } finally {
    server.close();
    if (prev !== undefined) process.env.DOC_INDEX_INTERNAL_TOKEN = prev;
  }
});

test('GET /stats requires bearer token when configured', async () => {
  process.env.DOC_INDEX_INTERNAL_TOKEN = 'secret-token';
  const store = createIndexStore();
  const { server } = await buildApp({ store });
  try {
    const noAuth = await request(server, { path: '/internal/document-index/stats' });
    assert.equal(noAuth.status, 401);

    const ok = await request(server, {
      path: '/internal/document-index/stats',
      headers: { authorization: 'Bearer secret-token' },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.entries, 0);
  } finally {
    server.close();
    delete process.env.DOC_INDEX_INTERNAL_TOKEN;
  }
});

test('POST /gc removes stale entries', async () => {
  const prev = process.env.DOC_INDEX_INTERNAL_TOKEN;
  delete process.env.DOC_INDEX_INTERNAL_TOKEN;
  let clock = Date.now();
  const store = createIndexStore({
    ttlMs: 60 * 1000,
    now: () => new Date(clock),
  });
  await store.getOrCompute(sha256(Buffer.from('A')), async () => ({
    chunks: [{ ord: 0 }], embeddings: [[1]], embedTokens: 0,
  }));
  clock += 5 * 60 * 1000; // advance 5 min

  const { server } = await buildApp({ store });
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/internal/document-index/gc',
      headers: { 'content-type': 'application/json' },
      body: {},
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.removed, 1);
  } finally {
    server.close();
    if (prev !== undefined) process.env.DOC_INDEX_INTERNAL_TOKEN = prev;
  }
});

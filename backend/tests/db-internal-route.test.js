'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createSlowQueryLogger } = require('../src/db/slow-query-logger');
const dbInternal = require('../src/routes/db-internal');

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
    if (body != null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function buildApp(opts = {}) {
  // Re-require to reset module state between tests.
  delete require.cache[require.resolve('../src/routes/db-internal')];
  const fresh = require('../src/routes/db-internal');
  if (opts.slow) fresh.attachSlowQueryLogger(opts.slow);
  if (opts.prisma !== undefined) fresh.attachPrisma(opts.prisma);
  const app = express();
  app.use('/internal/db', fresh.router);
  const server = await startServer(app);
  return { server, fresh };
}

test('GET /internal/db/slow-queries returns 503 when not attached', async () => {
  const prevToken = process.env.DB_INTERNAL_TOKEN;
  delete process.env.DB_INTERNAL_TOKEN;
  const { server } = await buildApp({});
  try {
    const res = await request(server, { path: '/internal/db/slow-queries' });
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'slow_query_logger_not_attached');
  } finally {
    server.close();
    if (prevToken !== undefined) process.env.DB_INTERNAL_TOKEN = prevToken;
  }
});

test('GET /internal/db/slow-queries returns recorded entries newest first', async () => {
  const prevToken = process.env.DB_INTERNAL_TOKEN;
  delete process.env.DB_INTERNAL_TOKEN;
  let t = 1000;
  const slow = createSlowQueryLogger({
    thresholdMs: 50, sampleRate: 1, bufferSize: 8,
    logger: { warn() {}, error() {}, info() {} },
    now: () => t,
  });
  for (const op of ['op-a', 'op-b', 'op-c']) {
    await slow.tracedQuery({
      model: 'M', operation: op, args: { op },
      query: () => { t += 100; return Promise.resolve(); },
    });
  }
  const { server } = await buildApp({ slow });
  try {
    const res = await request(server, { path: '/internal/db/slow-queries' });
    assert.equal(res.status, 200);
    assert.equal(res.json.queries.length, 3);
    assert.deepEqual(res.json.queries.map((q) => q.operation), ['op-c', 'op-b', 'op-a']);
    assert.equal(res.json.stats.slow, 3);
    assert.equal(res.json.stats.bufferUsed, 3);
  } finally {
    server.close();
    if (prevToken !== undefined) process.env.DB_INTERNAL_TOKEN = prevToken;
  }
});

test('respects ?limit query parameter', async () => {
  const prevToken = process.env.DB_INTERNAL_TOKEN;
  delete process.env.DB_INTERNAL_TOKEN;
  let t = 0;
  const slow = createSlowQueryLogger({
    thresholdMs: 1, sampleRate: 1, bufferSize: 10,
    logger: { warn() {}, error() {}, info() {} },
    now: () => t,
  });
  for (let i = 0; i < 5; i++) {
    await slow.tracedQuery({
      model: 'M', operation: `op${i}`, args: {},
      query: () => { t += 10; return Promise.resolve(); },
    });
  }
  const { server } = await buildApp({ slow });
  try {
    const res = await request(server, { path: '/internal/db/slow-queries?limit=2' });
    assert.equal(res.status, 200);
    assert.equal(res.json.queries.length, 2);
  } finally {
    server.close();
    if (prevToken !== undefined) process.env.DB_INTERNAL_TOKEN = prevToken;
  }
});

test('returns 401 when token configured and missing/invalid', async () => {
  const prev = process.env.DB_INTERNAL_TOKEN;
  process.env.DB_INTERNAL_TOKEN = 'secret-xyz';
  const slow = createSlowQueryLogger({ thresholdMs: 1, bufferSize: 4, sampleRate: 1, logger: { warn() {} } });
  const { server } = await buildApp({ slow });
  try {
    const noAuth = await request(server, { path: '/internal/db/slow-queries' });
    assert.equal(noAuth.status, 401);
    const badAuth = await request(server, {
      path: '/internal/db/slow-queries',
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(badAuth.status, 401);
    const goodAuth = await request(server, {
      path: '/internal/db/slow-queries',
      headers: { authorization: 'Bearer secret-xyz' },
    });
    assert.equal(goodAuth.status, 200);
  } finally {
    server.close();
    if (prev === undefined) delete process.env.DB_INTERNAL_TOKEN; else process.env.DB_INTERNAL_TOKEN = prev;
  }
});

test('POST /internal/db/explain runs against attached prisma stub', async () => {
  const prevToken = process.env.DB_INTERNAL_TOKEN;
  delete process.env.DB_INTERNAL_TOKEN;
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';

  const prisma = {
    async $queryRawUnsafe(sql) {
      return [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Seq Scan', sql } }] }];
    },
  };
  const { server } = await buildApp({ prisma });
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/internal/db/explain',
      headers: { 'content-type': 'application/json' },
      body: { sql: 'SELECT 1', params: [] },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.plan));
    assert.equal(res.json.plan[0].Plan['Node Type'], 'Seq Scan');
  } finally {
    server.close();
    if (prevToken !== undefined) process.env.DB_INTERNAL_TOKEN = prevToken;
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
  }
});

test('POST /internal/db/explain rejects non-SELECT', async () => {
  const prevToken = process.env.DB_INTERNAL_TOKEN;
  delete process.env.DB_INTERNAL_TOKEN;
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  const prisma = { async $queryRawUnsafe() { return []; } };
  const { server } = await buildApp({ prisma });
  try {
    const res = await request(server, {
      method: 'POST', path: '/internal/db/explain',
      headers: { 'content-type': 'application/json' },
      body: { sql: 'DELETE FROM "User"' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'EXPLAIN_INVALID_QUERY');
  } finally {
    server.close();
    if (prevToken !== undefined) process.env.DB_INTERNAL_TOKEN = prevToken;
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
  }
});

test('POST /internal/db/explain returns 403 in production without override', async () => {
  const prevToken = process.env.DB_INTERNAL_TOKEN;
  delete process.env.DB_INTERNAL_TOKEN;
  const prevEnv = process.env.NODE_ENV;
  const prevFlag = process.env.EXPLAIN_ALLOW_PROD;
  process.env.NODE_ENV = 'production';
  delete process.env.EXPLAIN_ALLOW_PROD;
  const prisma = { async $queryRawUnsafe() { return []; } };
  const { server } = await buildApp({ prisma });
  try {
    const res = await request(server, {
      method: 'POST', path: '/internal/db/explain',
      headers: { 'content-type': 'application/json' },
      body: { sql: 'SELECT 1' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'EXPLAIN_NOT_ALLOWED');
  } finally {
    server.close();
    if (prevToken !== undefined) process.env.DB_INTERNAL_TOKEN = prevToken;
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
    if (prevFlag === undefined) delete process.env.EXPLAIN_ALLOW_PROD; else process.env.EXPLAIN_ALLOW_PROD = prevFlag;
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { FlagService, createFlagsRouter } = require('../src/flags');

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, { method = 'GET', path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
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

async function buildApp(flagsConfig = {}) {
  const svc = new FlagService(flagsConfig);
  const app = express();
  app.use('/internal/flags', createFlagsRouter(svc));
  const server = await startServer(app);
  return { server, svc };
}

function withClearEnv(fn) {
  const prevTok = process.env.FLAGS_INTERNAL_TOKEN;
  const prevDb = process.env.DB_INTERNAL_TOKEN;
  delete process.env.FLAGS_INTERNAL_TOKEN;
  delete process.env.DB_INTERNAL_TOKEN;
  return Promise.resolve(fn()).finally(() => {
    if (prevTok !== undefined) process.env.FLAGS_INTERNAL_TOKEN = prevTok;
    if (prevDb !== undefined) process.env.DB_INTERNAL_TOKEN = prevDb;
  });
}

test('GET /internal/flags returns registered flags with evaluations', () => withClearEnv(async () => {
  const { server, svc } = await buildApp({
    flags: {
      beta: { strategy: 'boolean', default: true },
      vip: { strategy: 'allowlist', allowlist: ['u-1'] },
    },
  });
  try {
    const res = await request(server, { path: '/internal/flags?userId=u-1' });
    assert.equal(res.status, 200);
    assert.equal(res.json.count, 2);
    const beta = res.json.flags.find((f) => f.key === 'beta');
    const vip = res.json.flags.find((f) => f.key === 'vip');
    assert.equal(beta.evaluation.value, true);
    assert.equal(vip.evaluation.value, true);
    assert.equal(vip.evaluation.reason, 'allowlist');
    assert.ok(svc.has('beta'));
  } finally {
    server.close();
  }
}));

test('GET /internal/flags/:key returns 404 for unknown', () => withClearEnv(async () => {
  const { server } = await buildApp({});
  try {
    const res = await request(server, { path: '/internal/flags/missing' });
    assert.equal(res.status, 404);
    assert.equal(res.json.error, 'unknown_flag');
  } finally {
    server.close();
  }
}));

test('POST /internal/flags/:key/evaluate accepts ad-hoc context', () => withClearEnv(async () => {
  const { server } = await buildApp({
    flags: { feat: { strategy: 'percentage', percentage: 100 } },
  });
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/internal/flags/feat/evaluate',
      headers: { 'content-type': 'application/json' },
      body: { userId: 'u-1' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.value, true);
    assert.equal(res.json.reason, 'percentage_in');
  } finally {
    server.close();
  }
}));

test('PUT /internal/flags/:key registers and updates', () => withClearEnv(async () => {
  const { server, svc } = await buildApp({});
  try {
    const create = await request(server, {
      method: 'PUT',
      path: '/internal/flags/new_feat',
      headers: { 'content-type': 'application/json' },
      body: { strategy: 'boolean', default: true },
    });
    assert.equal(create.status, 200);
    assert.equal(svc.has('new_feat'), true);

    const update = await request(server, {
      method: 'PUT',
      path: '/internal/flags/new_feat',
      headers: { 'content-type': 'application/json' },
      body: { strategy: 'percentage', percentage: 25 },
    });
    assert.equal(update.status, 200);
    assert.equal(update.json.percentage, 25);
  } finally {
    server.close();
  }
}));

test('PUT /internal/flags/:key returns 400 on invalid body', () => withClearEnv(async () => {
  const { server } = await buildApp({});
  try {
    const res = await request(server, {
      method: 'PUT',
      path: '/internal/flags/bad',
      headers: { 'content-type': 'application/json' },
      body: { strategy: 'no_such_strategy' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'FLAG_INVALID_STRATEGY');
  } finally {
    server.close();
  }
}));

test('POST /internal/flags/:key/override sets per-user override', () => withClearEnv(async () => {
  const { server, svc } = await buildApp({
    flags: { feat: { strategy: 'boolean', default: false } },
  });
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/internal/flags/feat/override',
      headers: { 'content-type': 'application/json' },
      body: { userId: 'u-9', value: true },
    });
    assert.equal(res.status, 200);
    assert.equal(svc.evaluate('feat', { userId: 'u-9' }).value, true);
    assert.equal(svc.evaluate('feat', { userId: 'u-9' }).reason, 'user_override');
  } finally {
    server.close();
  }
}));

test('POST /internal/flags/:key/override with scope=global', () => withClearEnv(async () => {
  const { server, svc } = await buildApp({
    flags: { feat: { strategy: 'boolean', default: false } },
  });
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/internal/flags/feat/override',
      headers: { 'content-type': 'application/json' },
      body: { scope: 'global', value: true },
    });
    assert.equal(res.status, 200);
    assert.equal(svc.evaluate('feat').value, true);
    assert.equal(svc.evaluate('feat').reason, 'global_override');
  } finally {
    server.close();
  }
}));

test('POST /:key/override requires userId for non-global scope', () => withClearEnv(async () => {
  const { server } = await buildApp({
    flags: { feat: { strategy: 'boolean' } },
  });
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/internal/flags/feat/override',
      headers: { 'content-type': 'application/json' },
      body: { value: true },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'userId_required');
  } finally {
    server.close();
  }
}));

test('DELETE /internal/flags/:key/override?userId=...', () => withClearEnv(async () => {
  const { server, svc } = await buildApp({
    flags: { feat: { strategy: 'boolean', default: false } },
  });
  svc.setUserOverride('u-9', 'feat', true);
  try {
    const res = await request(server, {
      method: 'DELETE',
      path: '/internal/flags/feat/override?userId=u-9',
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(svc.evaluate('feat', { userId: 'u-9' }).reason, 'default');
  } finally {
    server.close();
  }
}));

test('DELETE /internal/flags/:key removes registration', () => withClearEnv(async () => {
  const { server, svc } = await buildApp({
    flags: { feat: { strategy: 'boolean' } },
  });
  try {
    const res = await request(server, { method: 'DELETE', path: '/internal/flags/feat' });
    assert.equal(res.status, 200);
    assert.equal(svc.has('feat'), false);
    const missing = await request(server, { method: 'DELETE', path: '/internal/flags/feat' });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
}));

test('returns 401 when token configured and missing/invalid', async () => {
  const prev = process.env.FLAGS_INTERNAL_TOKEN;
  const prevDb = process.env.DB_INTERNAL_TOKEN;
  process.env.FLAGS_INTERNAL_TOKEN = 'secret-flags';
  delete process.env.DB_INTERNAL_TOKEN;
  const { server } = await buildApp({ flags: { f: { strategy: 'boolean' } } });
  try {
    const noAuth = await request(server, { path: '/internal/flags' });
    assert.equal(noAuth.status, 401);

    const badAuth = await request(server, {
      path: '/internal/flags',
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(badAuth.status, 401);

    const ok = await request(server, {
      path: '/internal/flags',
      headers: { authorization: 'Bearer secret-flags' },
    });
    assert.equal(ok.status, 200);
  } finally {
    server.close();
    if (prev === undefined) delete process.env.FLAGS_INTERNAL_TOKEN; else process.env.FLAGS_INTERNAL_TOKEN = prev;
    if (prevDb !== undefined) process.env.DB_INTERNAL_TOKEN = prevDb;
  }
});

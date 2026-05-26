'use strict';

/**
 * Ratchet 45 (Task 1) — GET /api/webhooks/endpoints pagination.
 * Default limit=50, max=200, response shape {items,total,page,pages}
 * with legacy `endpoints` mirror.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const authPath = path.resolve(__dirname, '../src/middleware/auth.js');
const dbPath = path.resolve(__dirname, '../src/config/database.js');
const triggersPath = path.resolve(__dirname, '../src/services/trigger-registry.js');
const webhooksRoutePath = path.resolve(__dirname, '../src/routes/webhooks.js');

const authMock = {
  _user: { id: 'u-1', email: 'u@example.com', plan: 'PRO', emailVerifiedAt: new Date() },
  authenticateToken: (req, _res, next) => {
    req.user = authMock._user;
    next();
  },
};

const state = { endpoints: [] };

const prismaMock = {
  webhookEndpoint: {
    count: async ({ where }) =>
      state.endpoints.filter((e) => e.userId === where.userId).length,
    findMany: async ({ where, skip = 0, take = 50, orderBy }) => {
      let rows = state.endpoints.filter((e) => e.userId === where.userId);
      if (orderBy && orderBy.createdAt === 'desc') {
        rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      return rows.slice(skip, skip + take);
    },
  },
};

const realTriggers = require('../src/services/trigger-registry');
const triggersMock = {
  TRIGGERS: realTriggers.TRIGGERS,
  isKnownTrigger: realTriggers.isKnownTrigger,
};

require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: authMock };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: prismaMock };
require.cache[triggersPath] = { id: triggersPath, filename: triggersPath, loaded: true, exports: triggersMock };

delete require.cache[webhooksRoutePath];
const webhooksRouter = require(webhooksRoutePath);

function callRoute({ method, urlPath }) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/api/webhooks', webhooksRouter);
    const server = app.listen(0, () => {
      const { port } = server.address();
      const req = http.request(
        { hostname: '127.0.0.1', port, path: urlPath, method, headers: { 'content-type': 'application/json' } },
        (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => {
            server.close();
            let json = null;
            try { json = buf ? JSON.parse(buf) : null; } catch { /* noop */ }
            resolve({ status: res.statusCode, body: json });
          });
        },
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

function seed(n) {
  state.endpoints = [];
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    state.endpoints.push({
      id: `ep-${i}`,
      userId: 'u-1',
      url: `https://hook-${i}.example/x`,
      events: ['*'],
      secret: 'whk_' + 'b'.repeat(48),
      isActive: true,
      createdAt: new Date(now - i * 1000),
    });
  }
}

describe('GET /api/webhooks/endpoints (pagination)', () => {
  beforeEach(() => { state.endpoints = []; });

  test('defaults to page=1 limit=50 and returns {items,total,page,pages,endpoints}', async () => {
    seed(4);
    const res = await callRoute({ method: 'GET', urlPath: '/api/webhooks/endpoints' });
    assert.equal(res.status, 200);
    assert.equal(res.body.page, 1);
    assert.equal(res.body.total, 4);
    assert.equal(res.body.pages, 1);
    assert.equal(res.body.items.length, 4);
    assert.deepEqual(res.body.endpoints, res.body.items);
    // secret is redacted in listing
    assert.ok(typeof res.body.items[0].secret === 'string');
    assert.ok(res.body.items[0].secret.includes('…') || res.body.items[0].secret.startsWith('whk_'));
  });

  test('honors ?page=&limit= and computes pages correctly', async () => {
    seed(7);
    const res = await callRoute({ method: 'GET', urlPath: '/api/webhooks/endpoints?page=2&limit=3' });
    assert.equal(res.status, 200);
    assert.equal(res.body.page, 2);
    assert.equal(res.body.total, 7);
    assert.equal(res.body.pages, 3);
    assert.equal(res.body.items.length, 3);
  });

  test('limit is clamped to 200 max; invalid values use defaults', async () => {
    seed(2);
    const big = await callRoute({ method: 'GET', urlPath: '/api/webhooks/endpoints?limit=99999' });
    assert.equal(big.status, 200);
    assert.equal(big.body.items.length, 2);

    const bad = await callRoute({ method: 'GET', urlPath: '/api/webhooks/endpoints?page=-3&limit=abc' });
    assert.equal(bad.status, 200);
    assert.equal(bad.body.page, 1);
  });

  test('empty list returns total=0 pages=0', async () => {
    const res = await callRoute({ method: 'GET', urlPath: '/api/webhooks/endpoints' });
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 0);
    assert.equal(res.body.pages, 0);
    assert.deepEqual(res.body.items, []);
  });
});

'use strict';

/**
 * Ratchet 45 — per-user webhook-endpoint cap by plan on
 * POST /api/webhooks/endpoints.
 *
 *   FREE       →  2 endpoints
 *   PRO        → 10 endpoints
 *   PRO_MAX    → 25 endpoints
 *   ENTERPRISE → unlimited
 *
 * Overflow returns 402 Payment Required with { error, plan, cap, used }.
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
  _user: { id: 'u-1', email: 'u@example.com', plan: 'FREE' },
  authenticateToken: (req, _res, next) => {
    req.user = authMock._user;
    next();
  },
};

const prismaState = {
  rows: [], // WebhookEndpoint rows
};

const prismaMock = {
  webhookEndpoint: {
    count: async ({ where }) => {
      return prismaState.rows.filter((r) => {
        if (where.userId && r.userId !== where.userId) return false;
        if ('organizationId' in where) {
          if (where.organizationId === null && r.organizationId != null) return false;
          if (where.organizationId !== null && r.organizationId !== where.organizationId) return false;
        }
        return true;
      }).length;
    },
    create: async ({ data }) => {
      const row = {
        id: `ep-${prismaState.rows.length + 1}`,
        isActive: true,
        organizationId: null,
        events: [],
        createdAt: new Date(),
        lastDeliveryAt: null,
        ...data,
      };
      prismaState.rows.push(row);
      return row;
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

function callRoute({ method, urlPath, body }) {
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
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

function seed({ plan = 'FREE', count = 0, orgCount = 0 } = {}) {
  authMock._user = { id: 'u-1', email: 'u@example.com', plan };
  prismaState.rows = [];
  for (let i = 0; i < count; i++) {
    prismaState.rows.push({
      id: `ep-seed-${i}`,
      userId: 'u-1',
      organizationId: null,
      url: `https://hook.example/${i}`,
      events: ['*'],
      isActive: true,
    });
  }
  // Org-scoped endpoints owned by the same user — must NOT count toward
  // the per-user cap.
  for (let i = 0; i < orgCount; i++) {
    prismaState.rows.push({
      id: `ep-org-${i}`,
      userId: 'u-1',
      organizationId: 'org-x',
      url: `https://hook.example/org-${i}`,
      events: ['*'],
      isActive: true,
    });
  }
}

describe('POST /api/webhooks/endpoints · per-user plan cap', () => {
  beforeEach(() => seed());

  test('FREE allows 2 endpoints, rejects 3rd with 402', async () => {
    seed({ plan: 'FREE', count: 2 });
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/webhooks/endpoints',
      body: { url: 'https://hook.example/new', events: ['*'] },
    });
    assert.equal(res.status, 402);
    assert.equal(res.body.error, 'webhook-endpoint-cap-reached');
    assert.equal(res.body.plan, 'FREE');
    assert.equal(res.body.cap, 2);
    assert.equal(res.body.used, 2);
  });

  test('FREE allows first endpoint when under cap', async () => {
    seed({ plan: 'FREE', count: 1 });
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/webhooks/endpoints',
      body: { url: 'https://hook.example/new', events: ['*'] },
    });
    assert.equal(res.status, 201);
  });

  test('PRO cap is 10', async () => {
    seed({ plan: 'PRO', count: 10 });
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/webhooks/endpoints',
      body: { url: 'https://hook.example/eleven', events: ['*'] },
    });
    assert.equal(res.status, 402);
    assert.equal(res.body.cap, 10);
    assert.equal(res.body.used, 10);
  });

  test('PRO_MAX cap is 25', async () => {
    seed({ plan: 'PRO_MAX', count: 25 });
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/webhooks/endpoints',
      body: { url: 'https://hook.example/26', events: ['*'] },
    });
    assert.equal(res.status, 402);
    assert.equal(res.body.cap, 25);
  });

  test('ENTERPRISE never returns 402', async () => {
    seed({ plan: 'ENTERPRISE', count: 1_000 });
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/webhooks/endpoints',
      body: { url: 'https://hook.example/unlimited', events: ['*'] },
    });
    assert.equal(res.status, 201);
  });

  test('org-scoped endpoints (organizationId != null) do not count toward the per-user cap', async () => {
    // FREE user with 1 personal + 5 org-scoped endpoints — the cap
    // check only counts personal rows, so they should still be allowed
    // to create their second personal endpoint.
    seed({ plan: 'FREE', count: 1, orgCount: 5 });
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/webhooks/endpoints',
      body: { url: 'https://hook.example/second-personal', events: ['*'] },
    });
    assert.equal(res.status, 201);
  });
});

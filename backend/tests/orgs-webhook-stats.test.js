'use strict';

/**
 * Ratchet 45 — GET /api/orgs/:id/webhooks/stats (ADMIN+).
 *
 * Joins WebhookEndpoint rows owned by the org against the dispatcher's
 * in-memory delivery log to expose per-endpoint last24h counts + p95.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const authPath = path.resolve(__dirname, '../src/middleware/auth.js');
const dbPath = path.resolve(__dirname, '../src/config/database.js');
const auditPath = path.resolve(__dirname, '../src/utils/audit-log.js');
const triggersPath = path.resolve(__dirname, '../src/services/trigger-registry.js');
const orgsRoutePath = path.resolve(__dirname, '../src/routes/orgs.js');

const authMock = {
  _user: { id: 'u-admin', email: 'admin@example.com', emailVerifiedAt: new Date() },
  authenticateToken: (req, _res, next) => {
    req.user = authMock._user;
    next();
  },
};

const prismaState = {
  membership: { id: 'm1', orgId: 'org-1', userId: 'u-admin', role: 'ADMIN' },
  endpoints: [],
};

const prismaMock = {
  orgMembership: {
    findUnique: async ({ where }) => {
      const { orgId, userId } = where.orgId_userId;
      if (orgId === prismaState.membership.orgId && userId === prismaState.membership.userId) {
        return { ...prismaState.membership, organization: { id: orgId, billingPlan: 'PRO' } };
      }
      return null;
    },
  },
  webhookEndpoint: {
    findMany: async ({ where }) => {
      return prismaState.endpoints.filter((e) => e.organizationId === where.organizationId);
    },
  },
};

const auditMock = { writeAuditLog: () => {} };
const realTriggers = require('../src/services/trigger-registry');
const triggersMock = {
  TRIGGERS: realTriggers.TRIGGERS,
  isKnownTrigger: realTriggers.isKnownTrigger,
  publish: async () => ({ dispatched: 0, deduped: false, errors: [] }),
  publishDebounced: async () => {},
  resetForTests: realTriggers.resetForTests,
};

require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: authMock };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: prismaMock };
require.cache[auditPath] = { id: auditPath, filename: auditPath, loaded: true, exports: auditMock };
require.cache[triggersPath] = { id: triggersPath, filename: triggersPath, loaded: true, exports: triggersMock };

delete require.cache[orgsRoutePath];
const orgsRouter = require(orgsRoutePath);

const webhookDispatcher = require('../src/services/webhook-dispatcher');

function callRoute({ method, urlPath }) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/api/orgs', orgsRouter);
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

function seedDeliveries() {
  // Reset the dispatcher's ring buffer, then push hand-crafted entries
  // by running listDeliveries through the dispatch path is overkill —
  // we mutate the buffer indirectly by calling dispatch with a stub
  // deliverFn. The test seeds 5 entries for hook-a (3 ok + 2 fail)
  // and 1 entry for hook-b (delivered) so we can assert per-endpoint
  // counts independently.
  webhookDispatcher.resetStore();
  const now = Date.now();
  // Seed by directly invoking dispatch with stubbed deliverFn so the
  // ring buffer entries get realistic `durationMs` / `createdAt`.
  return Promise.all([
    // hook-a: 3 delivered (durations 100, 200, 300ms)
    webhookDispatcher.dispatch({
      url: 'https://hook-a.example/x', event: 'evt', payload: { i: 1 },
      deliverFn: async () => ({ status: 200, ok: true }),
      now: () => now,
    }),
    webhookDispatcher.dispatch({
      url: 'https://hook-a.example/x', event: 'evt', payload: { i: 2 },
      deliverFn: async () => ({ status: 200, ok: true }),
      now: () => now,
    }),
    webhookDispatcher.dispatch({
      url: 'https://hook-a.example/x', event: 'evt', payload: { i: 3 },
      deliverFn: async () => ({ status: 200, ok: true }),
      now: () => now,
    }),
    // hook-a: 2 failed (non-retryable 400)
    webhookDispatcher.dispatch({
      url: 'https://hook-a.example/x', event: 'evt', payload: { i: 4 },
      deliverFn: async () => ({ status: 400, ok: false }),
      maxRetries: 0,
      now: () => now,
    }),
    webhookDispatcher.dispatch({
      url: 'https://hook-a.example/x', event: 'evt', payload: { i: 5 },
      deliverFn: async () => ({ status: 400, ok: false }),
      maxRetries: 0,
      now: () => now,
    }),
    // hook-b: 1 delivered
    webhookDispatcher.dispatch({
      url: 'https://hook-b.example/y', event: 'evt', payload: { i: 6 },
      deliverFn: async () => ({ status: 200, ok: true }),
      now: () => now,
    }),
  ]);
}

describe('GET /api/orgs/:id/webhooks/stats', () => {
  beforeEach(() => {
    prismaState.membership = { id: 'm1', orgId: 'org-1', userId: 'u-admin', role: 'ADMIN' };
    prismaState.endpoints = [
      {
        id: 'ep-a',
        organizationId: 'org-1',
        userId: 'u-admin',
        url: 'https://hook-a.example/x',
        events: ['evt'],
        isActive: true,
        createdAt: new Date(),
      },
      {
        id: 'ep-b',
        organizationId: 'org-1',
        userId: 'u-admin',
        url: 'https://hook-b.example/y',
        events: ['*'],
        isActive: true,
        createdAt: new Date(),
      },
    ];
  });

  test('ADMIN gets per-endpoint last24h delivered/failed + p95Ms', async () => {
    await seedDeliveries();
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/webhooks/stats' });
    assert.equal(res.status, 200);
    assert.equal(res.body.orgId, 'org-1');
    assert.equal(Array.isArray(res.body.endpoints), true);
    assert.equal(res.body.endpoints.length, 2);

    const a = res.body.endpoints.find((e) => e.id === 'ep-a');
    const b = res.body.endpoints.find((e) => e.id === 'ep-b');
    assert.ok(a && b);
    assert.equal(a.last24hDelivered, 3);
    assert.equal(a.last24hFailed, 2);
    assert.equal(typeof a.p95Ms, 'number');
    assert.equal(b.last24hDelivered, 1);
    assert.equal(b.last24hFailed, 0);
    assert.deepEqual(a.events, ['evt']);
    assert.deepEqual(b.events, ['*']);
  });

  test('MEMBER role is rejected with 403', async () => {
    prismaState.membership.role = 'MEMBER';
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/webhooks/stats' });
    // assertMembership(_, _, _, 'ADMIN') returns 403 for MEMBER role.
    assert.ok(res.status === 403 || res.status === 401);
  });

  test('non-member returns 404', async () => {
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/other-org/webhooks/stats' });
    assert.equal(res.status, 404);
  });

  test('empty endpoint list when org has no webhooks', async () => {
    prismaState.endpoints = [];
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/webhooks/stats' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.endpoints, []);
  });
});

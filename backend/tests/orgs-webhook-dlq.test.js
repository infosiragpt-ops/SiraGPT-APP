'use strict';

/**
 * Ratchet 45 — org-scoped webhook DLQ endpoints (ADMIN+):
 *   GET  /api/orgs/:id/webhooks/dlq
 *   POST /api/orgs/:id/webhooks/dlq/:dlqId/retry
 *
 * The underlying DLQ in services/webhook-dispatcher is process-wide and
 * indexed by `url`. These routes scope visibility (and retry) to items
 * whose `url` matches a WebhookEndpoint owned by the caller's org.
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
    findFirst: async ({ where }) => {
      return prismaState.endpoints.find(
        (e) => e.organizationId === where.organizationId && e.url === where.url,
      ) || null;
    },
  },
};

const auditCalls = [];
const auditMock = { writeAuditLog: (_p, entry) => { auditCalls.push(entry); } };
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

function callRoute({ method, urlPath, body }) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/api/orgs', orgsRouter);
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const headers = { 'content-type': 'application/json' };
      if (payload) headers['content-length'] = String(payload.length);
      const req = http.request(
        { hostname: '127.0.0.1', port, path: urlPath, method, headers },
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
      if (payload) req.write(payload);
      req.end();
    });
  });
}

async function seedDLQ() {
  // Push items into the DLQ by dispatching failing deliveries with
  // maxRetries=0 so they go straight to the dead-letter queue.
  webhookDispatcher.resetStore();
  await webhookDispatcher.dispatch({
    url: 'https://hook-a.example/x',
    event: 'evt.a',
    payload: { i: 1 },
    deliverFn: async () => ({ status: 500, ok: false }),
    maxRetries: 0,
  });
  await webhookDispatcher.dispatch({
    url: 'https://hook-a.example/x',
    event: 'evt.a',
    payload: { i: 2 },
    deliverFn: async () => ({ status: 500, ok: false }),
    maxRetries: 0,
  });
  await webhookDispatcher.dispatch({
    url: 'https://hook-foreign.example/z',
    event: 'evt.a',
    payload: { i: 3 },
    deliverFn: async () => ({ status: 500, ok: false }),
    maxRetries: 0,
  });
}

describe('Org-scoped webhook DLQ', () => {
  beforeEach(() => {
    prismaState.membership = { id: 'm1', orgId: 'org-1', userId: 'u-admin', role: 'ADMIN' };
    prismaState.endpoints = [
      {
        id: 'ep-a',
        organizationId: 'org-1',
        userId: 'u-admin',
        url: 'https://hook-a.example/x',
        events: ['evt.a'],
        secret: 'whk_secret',
        isActive: true,
        createdAt: new Date(),
      },
    ];
    auditCalls.length = 0;
  });

  test('GET — ADMIN sees only DLQ items whose URL matches an org endpoint', async () => {
    await seedDLQ();
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/webhooks/dlq' });
    assert.equal(res.status, 200);
    assert.equal(Array.isArray(res.body.items), true);
    assert.equal(res.body.items.length, 2);
    for (const item of res.body.items) {
      assert.equal(item.url, 'https://hook-a.example/x');
    }
    assert.equal(res.body.stats.scoped, 2);
    assert.equal(typeof res.body.stats.total, 'number');
    assert.ok(res.body.stats.total >= 3);
  });

  test('GET — stats.scoped reports full org count even when response is limited', async () => {
    await seedDLQ();
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/webhooks/dlq?limit=1' });
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.stats.scoped, 2);
  });

  test('GET — MEMBER role is rejected with 403/401', async () => {
    prismaState.membership.role = 'MEMBER';
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/webhooks/dlq' });
    assert.ok(res.status === 403 || res.status === 401);
  });

  test('GET — non-member returns 404', async () => {
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/other-org/webhooks/dlq' });
    assert.equal(res.status, 404);
  });

  test('GET — empty result when org has no endpoints', async () => {
    await seedDLQ();
    prismaState.endpoints = [];
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/webhooks/dlq' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items, []);
    assert.equal(res.body.stats.scoped, 0);
  });

  test('POST retry — ADMIN can retry an org-owned DLQ item and audit is logged', async () => {
    await seedDLQ();
    const list = webhookDispatcher.listDLQ({ limit: 100 });
    const orgItem = list.find((d) => d.url === 'https://hook-a.example/x');
    assert.ok(orgItem);

    const res = await callRoute({
      method: 'POST',
      urlPath: `/api/orgs/org-1/webhooks/dlq/${orgItem.id}/retry`,
      body: {},
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.result && typeof res.body.result.status === 'string');
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0].action, 'org_webhook_dlq_retry');
    assert.equal(auditCalls[0].before.endpointId, 'ep-a');
    assert.equal(auditCalls[0].before.url, 'https://hook-a.example/x');
  });

  test('POST retry — foreign DLQ item is not visible to this org (404)', async () => {
    await seedDLQ();
    const list = webhookDispatcher.listDLQ({ limit: 100 });
    const foreign = list.find((d) => d.url === 'https://hook-foreign.example/z');
    assert.ok(foreign);
    const res = await callRoute({
      method: 'POST',
      urlPath: `/api/orgs/org-1/webhooks/dlq/${foreign.id}/retry`,
      body: {},
    });
    assert.equal(res.status, 404);
    assert.equal(auditCalls.length, 0);
  });

  test('POST retry — unknown DLQ id returns 404', async () => {
    await seedDLQ();
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/webhooks/dlq/does-not-exist/retry',
      body: {},
    });
    assert.equal(res.status, 404);
  });

  test('POST retry — MEMBER role is rejected', async () => {
    await seedDLQ();
    prismaState.membership.role = 'MEMBER';
    const list = webhookDispatcher.listDLQ({ limit: 100 });
    const orgItem = list.find((d) => d.url === 'https://hook-a.example/x');
    const res = await callRoute({
      method: 'POST',
      urlPath: `/api/orgs/org-1/webhooks/dlq/${orgItem.id}/retry`,
      body: {},
    });
    assert.ok(res.status === 403 || res.status === 401);
  });
});

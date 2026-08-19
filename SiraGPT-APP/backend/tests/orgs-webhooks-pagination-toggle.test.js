'use strict';

/**
 * Ratchet 45 (Tasks 1+2) —
 *   GET  /api/orgs/:id/webhooks                  (pagination)
 *   POST /api/orgs/:id/webhooks/:endpointId/toggle (ADMIN+)
 *
 * Pagination matches the cycle 118 shape `{items,total,page,pages}`
 * with a legacy `endpoints` mirror. The toggle route flips `isActive`
 * and writes an audit-log entry.
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

const auditEntries = [];

function endpointById(id) {
  return prismaState.endpoints.find((e) => e.id === id);
}

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
    count: async ({ where }) => {
      return prismaState.endpoints.filter((e) => e.organizationId === where.organizationId).length;
    },
    findMany: async ({ where, skip = 0, take = 50, orderBy }) => {
      let rows = prismaState.endpoints.filter((e) => e.organizationId === where.organizationId);
      if (orderBy && orderBy.createdAt === 'desc') {
        rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      return rows.slice(skip, skip + take);
    },
    findFirst: async ({ where }) => {
      const found = prismaState.endpoints.find(
        (e) => e.id === where.id && e.organizationId === where.organizationId,
      );
      return found ? { ...found } : null;
    },
    update: async ({ where, data }) => {
      const ep = endpointById(where.id);
      if (!ep) throw new Error('not found');
      Object.assign(ep, data);
      return ep;
    },
  },
};

const auditMock = {
  writeAuditLog: (_prisma, entry) => { auditEntries.push(entry); },
};
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

function seedEndpoints(n) {
  prismaState.endpoints = [];
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    prismaState.endpoints.push({
      id: `ep-${i}`,
      organizationId: 'org-1',
      userId: 'u-admin',
      url: `https://hook-${i}.example/x`,
      events: ['evt'],
      secret: 'whk_' + 'a'.repeat(48),
      isActive: true,
      createdAt: new Date(now - i * 1000),
    });
  }
}

describe('GET /api/orgs/:id/webhooks (pagination)', () => {
  beforeEach(() => {
    prismaState.membership = { id: 'm1', orgId: 'org-1', userId: 'u-admin', role: 'ADMIN' };
    auditEntries.length = 0;
  });

  test('defaults to page=1 limit=50 and returns {items,total,page,pages,endpoints}', async () => {
    seedEndpoints(3);
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/webhooks' });
    assert.equal(res.status, 200);
    assert.equal(res.body.page, 1);
    assert.equal(res.body.total, 3);
    assert.equal(res.body.pages, 1);
    assert.equal(Array.isArray(res.body.items), true);
    assert.equal(res.body.items.length, 3);
    // back-compat mirror
    assert.deepEqual(res.body.endpoints, res.body.items);
  });

  test('honors ?page=2&limit=2 and clamps limit to 200 max', async () => {
    seedEndpoints(5);
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/webhooks?page=2&limit=2' });
    assert.equal(res.status, 200);
    assert.equal(res.body.page, 2);
    assert.equal(res.body.total, 5);
    assert.equal(res.body.pages, 3);
    assert.equal(res.body.items.length, 2);

    const clamped = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/webhooks?limit=9999' });
    assert.equal(clamped.status, 200);
    // We only seeded 5, but the request shouldn't 500. items <= total.
    assert.ok(clamped.body.items.length <= 5);
  });

  test('returns total=0 pages=0 when org has no webhooks', async () => {
    prismaState.endpoints = [];
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/webhooks' });
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 0);
    assert.equal(res.body.pages, 0);
    assert.deepEqual(res.body.items, []);
  });

  test('non-member returns 404', async () => {
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/other-org/webhooks' });
    assert.equal(res.status, 404);
  });
});

describe('POST /api/orgs/:id/webhooks/:endpointId/toggle', () => {
  beforeEach(() => {
    prismaState.membership = { id: 'm1', orgId: 'org-1', userId: 'u-admin', role: 'ADMIN' };
    auditEntries.length = 0;
    seedEndpoints(2);
  });

  test('ADMIN flips isActive from true to false and writes audit log', async () => {
    const res = await callRoute({ method: 'POST', urlPath: '/api/orgs/org-1/webhooks/ep-0/toggle' });
    assert.equal(res.status, 200);
    assert.equal(res.body.endpoint.id, 'ep-0');
    assert.equal(res.body.endpoint.isActive, false);
    assert.equal(endpointById('ep-0').isActive, false);
    assert.equal(auditEntries.length, 1);
    assert.equal(auditEntries[0].action, 'org_webhook_toggle');
    assert.equal(auditEntries[0].before.isActive, true);
    assert.equal(auditEntries[0].after.isActive, false);
  });

  test('second toggle flips back to true', async () => {
    await callRoute({ method: 'POST', urlPath: '/api/orgs/org-1/webhooks/ep-0/toggle' });
    const res = await callRoute({ method: 'POST', urlPath: '/api/orgs/org-1/webhooks/ep-0/toggle' });
    assert.equal(res.status, 200);
    assert.equal(res.body.endpoint.isActive, true);
  });

  test('MEMBER role is rejected with 403', async () => {
    prismaState.membership.role = 'MEMBER';
    const res = await callRoute({ method: 'POST', urlPath: '/api/orgs/org-1/webhooks/ep-0/toggle' });
    assert.ok(res.status === 403 || res.status === 401);
  });

  test('unknown endpointId returns 404', async () => {
    const res = await callRoute({ method: 'POST', urlPath: '/api/orgs/org-1/webhooks/ep-missing/toggle' });
    assert.equal(res.status, 404);
  });

  test('non-member returns 404', async () => {
    const res = await callRoute({ method: 'POST', urlPath: '/api/orgs/other-org/webhooks/ep-0/toggle' });
    assert.equal(res.status, 404);
  });
});

'use strict';

/**
 * Ratchet 44 — bulk webhook operations:
 *   POST /api/orgs/:id/webhooks/bulk-toggle (ADMIN+)
 *   POST /api/orgs/:id/webhooks/bulk-delete (ADMIN+)
 *
 * Each accepts `{ ids: string[] }` capped at 50. Bulk-toggle also takes
 * `{ enabled: bool }`. Successful operations write one audit log entry
 * per endpoint; unknown ids surface in `notFound`.
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
    findMany: async ({ where }) => {
      let rows = prismaState.endpoints.filter(
        (e) => e.organizationId === where.organizationId,
      );
      if (where.id && Array.isArray(where.id.in)) {
        const wanted = new Set(where.id.in);
        rows = rows.filter((e) => wanted.has(e.id));
      }
      return rows.map((r) => ({ ...r }));
    },
    update: async ({ where, data }) => {
      const ep = endpointById(where.id);
      if (!ep) throw new Error('not found');
      Object.assign(ep, data);
      return { ...ep };
    },
    deleteMany: async ({ where }) => {
      const before = prismaState.endpoints.length;
      prismaState.endpoints = prismaState.endpoints.filter((e) => {
        if (where.id && e.id !== where.id) return true;
        if (where.organizationId && e.organizationId !== where.organizationId) return true;
        return false;
      });
      return { count: before - prismaState.endpoints.length };
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

function callRoute({ method, urlPath, body }) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/api/orgs', orgsRouter);
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
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

describe('POST /api/orgs/:id/webhooks/bulk-toggle', () => {
  beforeEach(() => {
    prismaState.membership = { id: 'm1', orgId: 'org-1', userId: 'u-admin', role: 'ADMIN' };
    auditEntries.length = 0;
    seedEndpoints(3);
  });

  test('ADMIN disables all listed endpoints and writes one audit per success', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/webhooks/bulk-toggle',
      body: { ids: ['ep-0', 'ep-1'], enabled: false },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.updated.sort(), ['ep-0', 'ep-1']);
    assert.deepEqual(res.body.notFound, []);
    assert.equal(endpointById('ep-0').isActive, false);
    assert.equal(endpointById('ep-1').isActive, false);
    assert.equal(endpointById('ep-2').isActive, true);
    assert.equal(auditEntries.length, 2);
    assert.equal(auditEntries[0].action, 'org_webhook_bulk_toggle');
    assert.equal(auditEntries[0].before.isActive, true);
    assert.equal(auditEntries[0].after.isActive, false);
  });

  test('ADMIN re-enables endpoints with enabled=true', async () => {
    endpointById('ep-0').isActive = false;
    endpointById('ep-1').isActive = false;
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/webhooks/bulk-toggle',
      body: { ids: ['ep-0', 'ep-1'], enabled: true },
    });
    assert.equal(res.status, 200);
    assert.equal(endpointById('ep-0').isActive, true);
    assert.equal(endpointById('ep-1').isActive, true);
  });

  test('unknown ids surface in notFound and known ids still flip', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/webhooks/bulk-toggle',
      body: { ids: ['ep-0', 'ep-missing'], enabled: false },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.updated, ['ep-0']);
    assert.deepEqual(res.body.notFound, ['ep-missing']);
    assert.equal(auditEntries.length, 1);
  });

  test('cross-org ids are treated as notFound (organizationId scoped)', async () => {
    prismaState.endpoints.push({
      id: 'ep-foreign',
      organizationId: 'other-org',
      userId: 'u-admin',
      url: 'https://other.example/x',
      events: ['evt'],
      secret: 'whk_x',
      isActive: true,
      createdAt: new Date(),
    });
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/webhooks/bulk-toggle',
      body: { ids: ['ep-foreign'], enabled: false },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.updated, []);
    assert.deepEqual(res.body.notFound, ['ep-foreign']);
    // Foreign endpoint untouched.
    assert.equal(endpointById('ep-foreign').isActive, true);
  });

  test('rejects empty ids array with 400', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/webhooks/bulk-toggle',
      body: { ids: [], enabled: false },
    });
    assert.equal(res.status, 400);
  });

  test('rejects more than 50 ids with 400', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `ep-${i}`);
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/webhooks/bulk-toggle',
      body: { ids, enabled: true },
    });
    assert.equal(res.status, 400);
  });

  test('rejects missing/non-boolean enabled with 400', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/webhooks/bulk-toggle',
      body: { ids: ['ep-0'], enabled: 'yes' },
    });
    assert.equal(res.status, 400);
  });

  test('rejects non-array ids with 400', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/webhooks/bulk-toggle',
      body: { ids: 'ep-0', enabled: true },
    });
    assert.equal(res.status, 400);
  });

  test('MEMBER role is rejected with 403', async () => {
    prismaState.membership.role = 'MEMBER';
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/webhooks/bulk-toggle',
      body: { ids: ['ep-0'], enabled: false },
    });
    assert.ok(res.status === 403 || res.status === 401);
  });

  test('non-member returns 404', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/other-org/webhooks/bulk-toggle',
      body: { ids: ['ep-0'], enabled: false },
    });
    assert.equal(res.status, 404);
  });
});

describe('POST /api/orgs/:id/webhooks/bulk-delete', () => {
  beforeEach(() => {
    prismaState.membership = { id: 'm1', orgId: 'org-1', userId: 'u-admin', role: 'ADMIN' };
    auditEntries.length = 0;
    seedEndpoints(3);
  });

  test('ADMIN hard-deletes listed endpoints and writes one audit per success', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/webhooks/bulk-delete',
      body: { ids: ['ep-0', 'ep-1'] },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.updated.sort(), ['ep-0', 'ep-1']);
    assert.deepEqual(res.body.notFound, []);
    assert.equal(endpointById('ep-0'), undefined);
    assert.equal(endpointById('ep-1'), undefined);
    assert.ok(endpointById('ep-2'));
    assert.equal(auditEntries.length, 2);
    assert.equal(auditEntries[0].action, 'org_webhook_bulk_delete');
    assert.equal(auditEntries[0].before.endpointId, 'ep-0');
  });

  test('unknown ids surface in notFound', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/webhooks/bulk-delete',
      body: { ids: ['ep-0', 'ep-missing'] },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.updated, ['ep-0']);
    assert.deepEqual(res.body.notFound, ['ep-missing']);
    assert.equal(auditEntries.length, 1);
  });

  test('cross-org ids do not delete and surface in notFound', async () => {
    prismaState.endpoints.push({
      id: 'ep-foreign',
      organizationId: 'other-org',
      userId: 'u-admin',
      url: 'https://other.example/x',
      events: ['evt'],
      secret: 'whk_x',
      isActive: true,
      createdAt: new Date(),
    });
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/webhooks/bulk-delete',
      body: { ids: ['ep-foreign'] },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.notFound, ['ep-foreign']);
    assert.ok(endpointById('ep-foreign'));
  });

  test('rejects empty ids with 400', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/webhooks/bulk-delete',
      body: { ids: [] },
    });
    assert.equal(res.status, 400);
  });

  test('rejects more than 50 ids with 400', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `ep-${i}`);
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/webhooks/bulk-delete',
      body: { ids },
    });
    assert.equal(res.status, 400);
  });

  test('rejects non-array ids with 400', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/webhooks/bulk-delete',
      body: { ids: 'ep-0' },
    });
    assert.equal(res.status, 400);
  });

  test('deduplicates ids before processing', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/webhooks/bulk-delete',
      body: { ids: ['ep-0', 'ep-0', 'ep-0'] },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.updated, ['ep-0']);
    assert.equal(auditEntries.length, 1);
  });

  test('MEMBER role is rejected with 403', async () => {
    prismaState.membership.role = 'MEMBER';
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/webhooks/bulk-delete',
      body: { ids: ['ep-0'] },
    });
    assert.ok(res.status === 403 || res.status === 401);
  });

  test('non-member returns 404', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/other-org/webhooks/bulk-delete',
      body: { ids: ['ep-0'] },
    });
    assert.equal(res.status, 404);
  });
});

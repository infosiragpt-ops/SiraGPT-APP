'use strict';

/**
 * Tests for org-wide announcements (ratchet 45):
 *   - POST   /api/orgs/:id/announcements (ADMIN+)
 *   - GET    /api/orgs/:id/announcements (any member, current non-expired)
 *   - DELETE /api/orgs/:id/announcements/:announcementId (ADMIN+)
 *
 * Uses require-cache module substitution so the orgs router is wired
 * against fakes for auth, prisma, audit-log, and the trigger registry.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

// ── module mocks ──────────────────────────────────────────────────
const authPath = path.resolve(__dirname, '../src/middleware/auth.js');
const dbPath = path.resolve(__dirname, '../src/config/database.js');
const auditPath = path.resolve(__dirname, '../src/utils/audit-log.js');
const triggersPath = path.resolve(__dirname, '../src/services/trigger-registry.js');
const orgsRoutePath = path.resolve(__dirname, '../src/routes/orgs.js');

const authMock = {
  _user: { id: 'u-admin', email: 'admin@example.com' },
  authenticateToken: (req, _res, next) => {
    req.user = authMock._user;
    next();
  },
};

const prismaState = {
  membership: { id: 'm1', orgId: 'org-1', userId: 'u-admin', role: 'ADMIN' },
  announcements: [],
  _seq: 0,
};

const prismaMock = {
  orgMembership: {
    findUnique: async ({ where }) => {
      const { orgId, userId } = where.orgId_userId;
      if (orgId !== prismaState.membership.orgId) return null;
      if (userId !== prismaState.membership.userId) return null;
      return { ...prismaState.membership, organization: { id: orgId } };
    },
  },
  orgAnnouncement: {
    create: async ({ data }) => {
      prismaState._seq += 1;
      const row = {
        id: `ann-${prismaState._seq}`,
        orgId: data.orgId,
        title: data.title,
        body: data.body,
        severity: data.severity,
        createdById: data.createdById,
        expiresAt: data.expiresAt ?? null,
        createdAt: new Date(),
      };
      prismaState.announcements.push(row);
      return row;
    },
    findMany: async ({ where, orderBy }) => {
      void orderBy;
      const now = Date.now();
      const filtered = prismaState.announcements.filter((r) => {
        if (where.orgId && r.orgId !== where.orgId) return false;
        if (where.OR) {
          const allowNull = where.OR.some((c) => c.expiresAt === null);
          const gtClause = where.OR.find((c) => c.expiresAt && c.expiresAt.gt);
          const gtMs = gtClause
            ? gtClause.expiresAt.gt instanceof Date
              ? gtClause.expiresAt.gt.getTime()
              : now
            : null;
          if (r.expiresAt === null) return allowNull;
          if (gtMs !== null && r.expiresAt.getTime() > gtMs) return true;
          return false;
        }
        return true;
      });
      return filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
    findUnique: async ({ where, select }) => {
      void select;
      const row = prismaState.announcements.find((r) => r.id === where.id);
      return row || null;
    },
    delete: async ({ where }) => {
      const idx = prismaState.announcements.findIndex((r) => r.id === where.id);
      if (idx === -1) throw new Error('not found');
      const [removed] = prismaState.announcements.splice(idx, 1);
      return removed;
    },
  },
};

const auditMock = {
  _calls: [],
  writeAuditLog: (_db, payload) => { auditMock._calls.push(payload); },
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

function resetState({ role = 'ADMIN' } = {}) {
  prismaState.membership = { id: 'm1', orgId: 'org-1', userId: 'u-admin', role };
  prismaState.announcements = [];
  prismaState._seq = 0;
  auditMock._calls.length = 0;
  authMock._user = { id: 'u-admin', email: 'admin@example.com' };
}

// ── POST /api/orgs/:id/announcements ──────────────────────────────
describe('POST /api/orgs/:id/announcements', () => {
  beforeEach(() => resetState());

  test('creates an announcement with sane defaults', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/announcements',
      body: { title: 'Maintenance window', body: 'Saturday 9pm UTC' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.announcement.title, 'Maintenance window');
    assert.equal(res.body.announcement.body, 'Saturday 9pm UTC');
    assert.equal(res.body.announcement.severity, 'info');
    assert.equal(res.body.announcement.createdById, 'u-admin');
    assert.equal(res.body.announcement.expiresAt, null);
    assert.equal(prismaState.announcements.length, 1);
    assert.equal(auditMock._calls.length, 1);
    assert.equal(auditMock._calls[0].action, 'org_announcement_create');
  });

  test('accepts severity warn/critical and expiresAt', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/announcements',
      body: { title: 'Outage', body: 'API degraded', severity: 'critical', expiresAt: future },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.announcement.severity, 'critical');
    assert.ok(res.body.announcement.expiresAt);
  });

  test('rejects invalid severity (400)', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/announcements',
      body: { title: 'x', body: 'y', severity: 'panic' },
    });
    assert.equal(res.status, 400);
  });

  test('rejects empty title (400)', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/announcements',
      body: { title: '   ', body: 'y' },
    });
    assert.equal(res.status, 400);
  });

  test('rejects past expiresAt (400)', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/announcements',
      body: { title: 't', body: 'b', expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    assert.equal(res.status, 400);
  });

  test('VIEWER cannot create (403)', async () => {
    prismaState.membership.role = 'VIEWER';
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/announcements',
      body: { title: 't', body: 'b' },
    });
    assert.equal(res.status, 403);
  });

  test('MEMBER cannot create (403)', async () => {
    prismaState.membership.role = 'MEMBER';
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/announcements',
      body: { title: 't', body: 'b' },
    });
    assert.equal(res.status, 403);
  });

  test('non-member returns 404', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-2/announcements',
      body: { title: 't', body: 'b' },
    });
    assert.equal(res.status, 404);
  });
});

// ── GET /api/orgs/:id/announcements ───────────────────────────────
describe('GET /api/orgs/:id/announcements', () => {
  beforeEach(() => resetState());

  test('lists non-expired announcements ordered newest-first', async () => {
    const now = Date.now();
    prismaState.announcements.push({
      id: 'a1', orgId: 'org-1', title: 'Old', body: 'b', severity: 'info',
      createdById: 'u-admin', expiresAt: null, createdAt: new Date(now - 60_000),
    });
    prismaState.announcements.push({
      id: 'a2', orgId: 'org-1', title: 'New', body: 'b', severity: 'info',
      createdById: 'u-admin', expiresAt: null, createdAt: new Date(now),
    });
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/announcements' });
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 2);
    assert.equal(res.body.items[0].id, 'a2');
    assert.equal(res.body.items[1].id, 'a1');
  });

  test('hides expired announcements', async () => {
    prismaState.announcements.push({
      id: 'expired', orgId: 'org-1', title: 'Old', body: 'b', severity: 'info',
      createdById: 'u-admin', expiresAt: new Date(Date.now() - 1000), createdAt: new Date(),
    });
    prismaState.announcements.push({
      id: 'live', orgId: 'org-1', title: 'Live', body: 'b', severity: 'info',
      createdById: 'u-admin', expiresAt: new Date(Date.now() + 86_400_000), createdAt: new Date(),
    });
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/announcements' });
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].id, 'live');
  });

  test('VIEWER role can read', async () => {
    prismaState.membership.role = 'VIEWER';
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/announcements' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items, []);
  });

  test('non-member returns 404', async () => {
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-2/announcements' });
    assert.equal(res.status, 404);
  });
});

// ── DELETE /api/orgs/:id/announcements/:announcementId ────────────
describe('DELETE /api/orgs/:id/announcements/:announcementId', () => {
  beforeEach(() => resetState());

  test('deletes announcement and writes audit log', async () => {
    prismaState.announcements.push({
      id: 'a-del', orgId: 'org-1', title: 'Bye', body: 'b', severity: 'info',
      createdById: 'u-admin', expiresAt: null, createdAt: new Date(),
    });
    const res = await callRoute({
      method: 'DELETE',
      urlPath: '/api/orgs/org-1/announcements/a-del',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(prismaState.announcements.length, 0);
    assert.equal(auditMock._calls.length, 1);
    assert.equal(auditMock._calls[0].action, 'org_announcement_delete');
  });

  test('unknown id returns 404', async () => {
    const res = await callRoute({
      method: 'DELETE',
      urlPath: '/api/orgs/org-1/announcements/missing',
    });
    assert.equal(res.status, 404);
  });

  test('cannot delete from another org (404)', async () => {
    prismaState.announcements.push({
      id: 'a-foreign', orgId: 'org-other', title: 'x', body: 'y', severity: 'info',
      createdById: 'u-admin', expiresAt: null, createdAt: new Date(),
    });
    const res = await callRoute({
      method: 'DELETE',
      urlPath: '/api/orgs/org-1/announcements/a-foreign',
    });
    assert.equal(res.status, 404);
    assert.equal(prismaState.announcements.length, 1);
  });

  test('VIEWER cannot delete (403)', async () => {
    prismaState.membership.role = 'VIEWER';
    prismaState.announcements.push({
      id: 'a-v', orgId: 'org-1', title: 't', body: 'b', severity: 'info',
      createdById: 'u-admin', expiresAt: null, createdAt: new Date(),
    });
    const res = await callRoute({
      method: 'DELETE',
      urlPath: '/api/orgs/org-1/announcements/a-v',
    });
    assert.equal(res.status, 403);
  });
});

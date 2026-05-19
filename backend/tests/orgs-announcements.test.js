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
  reads: [],
  _seq: 0,
  _readSeq: 0,
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
    count: async ({ where } = {}) => {
      const now = Date.now();
      return prismaState.announcements.filter((r) => {
        if (where && where.orgId && r.orgId !== where.orgId) return false;
        if (where && where.OR) {
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
      }).length;
    },
    update: async ({ where, data }) => {
      const idx = prismaState.announcements.findIndex((r) => r.id === where.id);
      if (idx === -1) throw new Error('not found');
      const merged = { ...prismaState.announcements[idx], ...data };
      prismaState.announcements[idx] = merged;
      return merged;
    },
    delete: async ({ where }) => {
      const idx = prismaState.announcements.findIndex((r) => r.id === where.id);
      if (idx === -1) throw new Error('not found');
      const [removed] = prismaState.announcements.splice(idx, 1);
      return removed;
    },
  },
  orgAnnouncementRead: {
    findUnique: async ({ where }) => {
      const { announcementId, userId } = where.announcementId_userId || {};
      return prismaState.reads.find(
        (r) => r.announcementId === announcementId && r.userId === userId,
      ) || null;
    },
    findMany: async ({ where, select }) => {
      void select;
      const ids = where && where.announcementId && Array.isArray(where.announcementId.in)
        ? new Set(where.announcementId.in)
        : null;
      return prismaState.reads.filter((r) => {
        if (where && where.userId && r.userId !== where.userId) return false;
        if (ids && !ids.has(r.announcementId)) return false;
        return true;
      });
    },
    create: async ({ data }) => {
      const dup = prismaState.reads.find(
        (r) => r.announcementId === data.announcementId && r.userId === data.userId,
      );
      if (dup) {
        const err = new Error('Unique constraint failed');
        err.code = 'P2002';
        throw err;
      }
      prismaState._readSeq += 1;
      const row = {
        id: `read-${prismaState._readSeq}`,
        announcementId: data.announcementId,
        userId: data.userId,
        readAt: new Date(),
      };
      prismaState.reads.push(row);
      return row;
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
  _calls: [],
  publish: async (event, payload, userId) => {
    triggersMock._calls.push({ event, payload, userId });
    return { dispatched: 0, deduped: false, errors: [] };
  },
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
  prismaState.reads = [];
  prismaState._seq = 0;
  prismaState._readSeq = 0;
  auditMock._calls.length = 0;
  triggersMock._calls.length = 0;
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
    // Ratchet 45 Task 1 — trigger fires
    assert.equal(triggersMock._calls.length, 1);
    assert.equal(triggersMock._calls[0].event, 'org.announcement.created');
    assert.equal(triggersMock._calls[0].payload.orgId, 'org-1');
    assert.equal(triggersMock._calls[0].payload.severity, 'info');
    assert.equal(triggersMock._calls[0].userId, 'u-admin');
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

  // Ratchet 45 Task 1 — pagination contract
  test('returns paginated shape {items,total,page,pages} with defaults', async () => {
    prismaState.announcements.push({
      id: 'a1', orgId: 'org-1', title: 'A', body: 'b', severity: 'info',
      createdById: 'u-admin', expiresAt: null, createdAt: new Date(),
    });
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/announcements' });
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.page, 1);
    assert.equal(res.body.pages, 1);
    assert.equal(res.body.items.length, 1);
  });

  test('honors ?page= and ?limit= and caps limit at 100', async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      prismaState.announcements.push({
        id: `a${i}`, orgId: 'org-1', title: `t${i}`, body: 'b', severity: 'info',
        createdById: 'u-admin', expiresAt: null, createdAt: new Date(now + i),
      });
    }
    const res = await callRoute({
      method: 'GET',
      urlPath: '/api/orgs/org-1/announcements?page=2&limit=2',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 5);
    assert.equal(res.body.page, 2);
    assert.equal(res.body.pages, 3);

    const capped = await callRoute({
      method: 'GET',
      urlPath: '/api/orgs/org-1/announcements?limit=9999',
    });
    assert.equal(capped.status, 200);
    // limit was capped at 100 → pages still 1 for 5 items
    assert.equal(capped.body.pages, 1);
  });

  test('empty list returns pages=0', async () => {
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/announcements' });
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 0);
    assert.equal(res.body.pages, 0);
  });
});

// ── PUT /api/orgs/:id/announcements/:announcementId (Task 2) ──────
describe('PUT /api/orgs/:id/announcements/:announcementId', () => {
  beforeEach(() => resetState());

  function seedOne(over = {}) {
    const row = {
      id: 'a-upd',
      orgId: 'org-1',
      title: 'orig title',
      body: 'orig body',
      severity: 'info',
      createdById: 'u-admin',
      expiresAt: null,
      createdAt: new Date(),
      ...over,
    };
    prismaState.announcements.push(row);
    return row;
  }

  test('updates title, body, severity, expiresAt and writes audit log', async () => {
    seedOne();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const res = await callRoute({
      method: 'PUT',
      urlPath: '/api/orgs/org-1/announcements/a-upd',
      body: { title: 'new', body: 'new body', severity: 'critical', expiresAt: future },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.announcement.title, 'new');
    assert.equal(res.body.announcement.body, 'new body');
    assert.equal(res.body.announcement.severity, 'critical');
    assert.ok(res.body.announcement.expiresAt);
    assert.equal(auditMock._calls.length, 1);
    assert.equal(auditMock._calls[0].action, 'org_announcement_update');
    assert.equal(auditMock._calls[0].before.title, 'orig title');
    assert.equal(auditMock._calls[0].after.title, 'new');
  });

  test('partial update only changes provided fields', async () => {
    seedOne();
    const res = await callRoute({
      method: 'PUT',
      urlPath: '/api/orgs/org-1/announcements/a-upd',
      body: { severity: 'warn' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.announcement.severity, 'warn');
    assert.equal(res.body.announcement.title, 'orig title');
    assert.equal(res.body.announcement.body, 'orig body');
  });

  test('expiresAt: null clears the field', async () => {
    seedOne({ expiresAt: new Date(Date.now() + 86_400_000) });
    const res = await callRoute({
      method: 'PUT',
      urlPath: '/api/orgs/org-1/announcements/a-upd',
      body: { expiresAt: null },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.announcement.expiresAt, null);
  });

  test('rejects invalid severity (400)', async () => {
    seedOne();
    const res = await callRoute({
      method: 'PUT',
      urlPath: '/api/orgs/org-1/announcements/a-upd',
      body: { severity: 'panic' },
    });
    assert.equal(res.status, 400);
  });

  test('rejects empty title (400)', async () => {
    seedOne();
    const res = await callRoute({
      method: 'PUT',
      urlPath: '/api/orgs/org-1/announcements/a-upd',
      body: { title: '   ' },
    });
    assert.equal(res.status, 400);
  });

  test('rejects past expiresAt (400)', async () => {
    seedOne();
    const res = await callRoute({
      method: 'PUT',
      urlPath: '/api/orgs/org-1/announcements/a-upd',
      body: { expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    assert.equal(res.status, 400);
  });

  test('empty body returns 400 (no fields to update)', async () => {
    seedOne();
    const res = await callRoute({
      method: 'PUT',
      urlPath: '/api/orgs/org-1/announcements/a-upd',
      body: {},
    });
    assert.equal(res.status, 400);
  });

  test('unknown id returns 404', async () => {
    const res = await callRoute({
      method: 'PUT',
      urlPath: '/api/orgs/org-1/announcements/missing',
      body: { title: 'x' },
    });
    assert.equal(res.status, 404);
  });

  test('cannot update announcement from another org (404)', async () => {
    seedOne({ id: 'a-foreign', orgId: 'org-other' });
    const res = await callRoute({
      method: 'PUT',
      urlPath: '/api/orgs/org-1/announcements/a-foreign',
      body: { title: 'x' },
    });
    assert.equal(res.status, 404);
  });

  test('VIEWER cannot update (403)', async () => {
    prismaState.membership.role = 'VIEWER';
    seedOne();
    const res = await callRoute({
      method: 'PUT',
      urlPath: '/api/orgs/org-1/announcements/a-upd',
      body: { title: 'new' },
    });
    assert.equal(res.status, 403);
  });

  test('MEMBER cannot update (403)', async () => {
    prismaState.membership.role = 'MEMBER';
    seedOne();
    const res = await callRoute({
      method: 'PUT',
      urlPath: '/api/orgs/org-1/announcements/a-upd',
      body: { title: 'new' },
    });
    assert.equal(res.status, 403);
  });

  test('non-member returns 404', async () => {
    const res = await callRoute({
      method: 'PUT',
      urlPath: '/api/orgs/org-2/announcements/whatever',
      body: { title: 'x' },
    });
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

// ── Ratchet 45 Task 1 — trigger ───────────────────────────────────
describe('org.announcement.created trigger', () => {
  beforeEach(() => resetState());

  test('is part of the canonical TRIGGERS allow-list', () => {
    assert.ok(realTriggers.TRIGGERS.includes('org.announcement.created'));
    assert.equal(realTriggers.isKnownTrigger('org.announcement.created'), true);
  });

  test('publishes trigger with severity and announcementId on create', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/announcements',
      body: { title: 'Outage', body: 'API degraded', severity: 'critical', expiresAt: future },
    });
    assert.equal(res.status, 201);
    assert.equal(triggersMock._calls.length, 1);
    const call = triggersMock._calls[0];
    assert.equal(call.event, 'org.announcement.created');
    assert.equal(call.payload.orgId, 'org-1');
    assert.equal(call.payload.severity, 'critical');
    assert.equal(call.payload.announcementId, res.body.announcement.id);
    assert.ok(call.payload.expiresAt);
  });

  test('does NOT publish trigger when validation fails', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/announcements',
      body: { title: '', body: 'b' },
    });
    assert.equal(res.status, 400);
    assert.equal(triggersMock._calls.length, 0);
  });
});

// ── Ratchet 45 Task 2 — critical announcement bulk email ──────────
describe('broadcastCriticalAnnouncement (Task 2)', () => {
  const { broadcastCriticalAnnouncement } = orgsRouter.__announcements;

  function makeDb({ members, settingsByUser = {} }) {
    return {
      orgMembership: {
        findMany: async () => members,
      },
      organization: {
        findUnique: async () => ({ id: 'org-1', name: 'Acme', slug: 'acme' }),
      },
      user: {
        findUnique: async ({ where, select }) => {
          void select;
          const s = settingsByUser[where.id];
          return s !== undefined ? { settings: s } : null;
        },
      },
    };
  }

  function makeEmailService({ configured = true } = {}) {
    const sent = [];
    return {
      sent,
      isConfigured: () => configured,
      sendOrgAnnouncement: async (user, org, announcement) => {
        sent.push({ to: user.email, org: org.id, title: announcement.title });
        return true;
      },
    };
  }

  test('returns zero counts when SMTP not configured (no DB hit)', async () => {
    const emailService = makeEmailService({ configured: false });
    require.cache[path.resolve(__dirname, '../src/services/email.js')] = {
      id: 'email', filename: 'email', loaded: true, exports: emailService,
    };
    const db = makeDb({ members: [{ user: { id: 'u1', email: 'u1@x.com', name: 'u1' } }] });
    const res = await broadcastCriticalAnnouncement(db, 'org-1',
      { id: 'a1' }, { title: 't', body: 'b' });
    assert.deepEqual(res, { attempted: 0, sent: 0, optedOut: 0 });
    assert.equal(emailService.sent.length, 0);
  });

  test('sends to every member that has not opted out', async () => {
    const emailService = makeEmailService();
    require.cache[path.resolve(__dirname, '../src/services/email.js')] = {
      id: 'email', filename: 'email', loaded: true, exports: emailService,
    };
    const db = makeDb({
      members: [
        { user: { id: 'u1', email: 'u1@x.com', name: 'u1' } },
        { user: { id: 'u2', email: 'u2@x.com', name: 'u2' } },
        { user: { id: 'u3', email: 'u3@x.com', name: 'u3' } },
      ],
      settingsByUser: {
        // u1 opted out of announcements
        u1: { notifications: { announcements: false } },
        // u2 opted in explicitly
        u2: { notifications: { announcements: true } },
        // u3 default opt-in (no settings)
        u3: null,
      },
    });
    const res = await broadcastCriticalAnnouncement(db, 'org-1',
      { id: 'a1' }, { title: 'Outage', body: 'API down' });
    assert.equal(res.optedOut, 1);
    assert.equal(res.attempted, 2);
    assert.equal(res.sent, 2);
    assert.equal(emailService.sent.length, 2);
    const tos = emailService.sent.map((s) => s.to).sort();
    assert.deepEqual(tos, ['u2@x.com', 'u3@x.com']);
  });

  test('skips members without an email and tolerates per-send failures', async () => {
    const emailService = {
      sent: [],
      isConfigured: () => true,
      sendOrgAnnouncement: async (user) => {
        if (user.email === 'boom@x.com') throw new Error('SMTP nope');
        emailService.sent.push(user.email);
        return true;
      },
    };
    require.cache[path.resolve(__dirname, '../src/services/email.js')] = {
      id: 'email', filename: 'email', loaded: true, exports: emailService,
    };
    const db = makeDb({
      members: [
        { user: { id: 'u1', email: '', name: 'no-mail' } },
        { user: { id: 'u2', email: 'boom@x.com', name: 'boom' } },
        { user: { id: 'u3', email: 'ok@x.com', name: 'ok' } },
      ],
    });
    const res = await broadcastCriticalAnnouncement(db, 'org-1',
      { id: 'a1' }, { title: 'x', body: 'y' });
    // u1 skipped (no email), u2 throws, u3 succeeds
    assert.equal(res.attempted, 2);
    assert.equal(res.sent, 1);
    assert.deepEqual(emailService.sent, ['ok@x.com']);
  });
});

// ── Ratchet 45 Task 2 — email-preferences category ────────────────
describe('email-preferences announcements category', () => {
  const emailPrefs = require('../src/services/email-preferences');

  test('exposes announcements as a valid category', () => {
    assert.ok(emailPrefs.VALID_CATEGORIES.includes('announcements'));
  });

  test('isOptedOut respects explicit false for announcements', () => {
    assert.equal(emailPrefs.isOptedOut({ announcements: false }, 'announcements'), true);
    assert.equal(emailPrefs.isOptedOut({ announcements: true }, 'announcements'), false);
    assert.equal(emailPrefs.isOptedOut({}, 'announcements'), false);
  });

  test('mergeNotificationsPatch accepts announcements patch', () => {
    const merged = emailPrefs.mergeNotificationsPatch({}, { announcements: false });
    assert.equal(merged.announcements, false);
    const cleared = emailPrefs.mergeNotificationsPatch(merged, { announcements: null });
    assert.equal(Object.prototype.hasOwnProperty.call(cleared, 'announcements'), false);
  });
});

// ── Ratchet 45 — POST /:id/announcements/:announcementId/ack ──────
describe('POST /api/orgs/:id/announcements/:announcementId/ack', () => {
  beforeEach(() => resetState());

  function seedOne(id = 'a-ack', over = {}) {
    const row = {
      id,
      orgId: 'org-1',
      title: 't',
      body: 'b',
      severity: 'info',
      createdById: 'u-admin',
      expiresAt: null,
      createdAt: new Date(),
      ...over,
    };
    prismaState.announcements.push(row);
    return row;
  }

  test('records a read receipt and fires trigger (201)', async () => {
    seedOne();
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/announcements/a-ack/ack',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.alreadyAcked, false);
    assert.ok(res.body.readAt);
    assert.equal(prismaState.reads.length, 1);
    assert.equal(prismaState.reads[0].announcementId, 'a-ack');
    assert.equal(prismaState.reads[0].userId, 'u-admin');
    // Trigger fired with expected payload.
    const ackCalls = triggersMock._calls.filter((c) => c.event === 'org.announcement.acknowledged');
    assert.equal(ackCalls.length, 1);
    assert.deepEqual(ackCalls[0].payload, {
      orgId: 'org-1',
      announcementId: 'a-ack',
      userId: 'u-admin',
    });
    assert.equal(ackCalls[0].userId, 'u-admin');
  });

  test('idempotent: second ack returns 200 alreadyAcked=true and does NOT re-fire trigger', async () => {
    seedOne();
    const first = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/announcements/a-ack/ack',
    });
    assert.equal(first.status, 201);
    const second = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/announcements/a-ack/ack',
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.alreadyAcked, true);
    assert.equal(prismaState.reads.length, 1);
    const ackCalls = triggersMock._calls.filter((c) => c.event === 'org.announcement.acknowledged');
    assert.equal(ackCalls.length, 1);
  });

  test('VIEWER (any member) can ack (201)', async () => {
    prismaState.membership.role = 'VIEWER';
    seedOne();
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/announcements/a-ack/ack',
    });
    assert.equal(res.status, 201);
  });

  test('non-member returns 404', async () => {
    seedOne();
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-2/announcements/a-ack/ack',
    });
    assert.equal(res.status, 404);
  });

  test('unknown announcement id returns 404', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/announcements/missing/ack',
    });
    assert.equal(res.status, 404);
  });

  test('cannot ack announcement from another org (404)', async () => {
    seedOne('a-foreign', { orgId: 'org-other' });
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/announcements/a-foreign/ack',
    });
    assert.equal(res.status, 404);
    assert.equal(prismaState.reads.length, 0);
  });
});

// ── Ratchet 45 — GET exposes acknowledgedByCurrentUser ────────────
describe('GET acknowledgedByCurrentUser flag', () => {
  beforeEach(() => resetState());

  test('returns false for items the current user has not acked', async () => {
    prismaState.announcements.push({
      id: 'a1', orgId: 'org-1', title: 't', body: 'b', severity: 'info',
      createdById: 'u-admin', expiresAt: null, createdAt: new Date(),
    });
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/announcements' });
    assert.equal(res.status, 200);
    assert.equal(res.body.items[0].acknowledgedByCurrentUser, false);
  });

  test('returns true after the current user acks', async () => {
    prismaState.announcements.push({
      id: 'a1', orgId: 'org-1', title: 't', body: 'b', severity: 'info',
      createdById: 'u-admin', expiresAt: null, createdAt: new Date(),
    });
    const ack = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/announcements/a1/ack',
    });
    assert.equal(ack.status, 201);
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/announcements' });
    assert.equal(res.status, 200);
    assert.equal(res.body.items[0].acknowledgedByCurrentUser, true);
  });

  test('flag is per-user — another user`s ack does not flip it', async () => {
    prismaState.announcements.push({
      id: 'a1', orgId: 'org-1', title: 't', body: 'b', severity: 'info',
      createdById: 'u-admin', expiresAt: null, createdAt: new Date(),
    });
    // Seed a read receipt for a DIFFERENT user.
    prismaState.reads.push({
      id: 'r-other', announcementId: 'a1', userId: 'u-other', readAt: new Date(),
    });
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/announcements' });
    assert.equal(res.status, 200);
    assert.equal(res.body.items[0].acknowledgedByCurrentUser, false);
  });
});

// ── Ratchet 45 — org.announcement.acknowledged trigger ────────────
describe('org.announcement.acknowledged trigger', () => {
  test('is part of the canonical TRIGGERS allow-list', () => {
    assert.ok(realTriggers.TRIGGERS.includes('org.announcement.acknowledged'));
    assert.equal(realTriggers.isKnownTrigger('org.announcement.acknowledged'), true);
  });
});

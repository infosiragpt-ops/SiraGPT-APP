'use strict';

/**
 * Tests for org invitation lifecycle (cycle 45 ratchet):
 *   - trigger-registry exposes the new `org.invitation.*` events
 *   - GET    /api/orgs/:id/invitations  (ADMIN+) → list pending
 *   - DELETE /api/orgs/:id/invitations/:token (ADMIN+) → revoke + fire trigger
 *
 * Uses require-cache module substitution so the orgs router is wired
 * against fakes for auth, prisma, audit-log, and the trigger registry.
 * No DB, no Express bind beyond an in-process listener.
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

// Pure JS fake prisma — only the surface the new endpoints + assertMembership touch.
const prismaState = {
  membership: { id: 'm1', orgId: 'org-1', userId: 'u-admin', role: 'ADMIN' },
  invitations: [], // [{ id, orgId, email, role, token, acceptedAt, expiresAt, createdAt }]
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
  orgInvitation: {
    findMany: async ({ where, orderBy, select }) => {
      void orderBy; void select;
      const now = Date.now();
      return prismaState.invitations.filter((r) => {
        if (where.orgId && r.orgId !== where.orgId) return false;
        if (where.acceptedAt === null && r.acceptedAt) return false;
        if (where.expiresAt && where.expiresAt.gt) {
          const cmp = where.expiresAt.gt instanceof Date ? where.expiresAt.gt.getTime() : now;
          if (r.expiresAt.getTime() <= cmp) return false;
        }
        return true;
      });
    },
    findUnique: async ({ where }) => {
      if (where.token) return prismaState.invitations.find((r) => r.token === where.token) || null;
      if (where.id) return prismaState.invitations.find((r) => r.id === where.id) || null;
      return null;
    },
    delete: async ({ where }) => {
      const idx = prismaState.invitations.findIndex((r) => r.id === where.id);
      if (idx === -1) throw new Error('not found');
      const [removed] = prismaState.invitations.splice(idx, 1);
      return removed;
    },
  },
};

const auditMock = {
  _calls: [],
  writeAuditLog: (_db, payload) => { auditMock._calls.push(payload); },
};

// Real trigger-registry: we install fake prisma/dispatcher/slack so
// publish() resolves without DB. We also assert that the new
// `org.invitation.*` events appear in TRIGGERS.
const realTriggers = require('../src/services/trigger-registry');
const triggerCalls = [];
const triggersMock = {
  TRIGGERS: realTriggers.TRIGGERS,
  isKnownTrigger: realTriggers.isKnownTrigger,
  publish: async (event, payload, userId) => {
    triggerCalls.push({ event, payload, userId });
    return { dispatched: 0, deduped: false, errors: [] };
  },
  publishDebounced: async () => {},
  resetForTests: realTriggers.resetForTests,
};

require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: authMock };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: prismaMock };
require.cache[auditPath] = { id: auditPath, filename: auditPath, loaded: true, exports: auditMock };
require.cache[triggersPath] = { id: triggersPath, filename: triggersPath, loaded: true, exports: triggersMock };

// Force fresh load of the orgs route so it captures the mocks above.
delete require.cache[orgsRoutePath];
const orgsRouter = require(orgsRoutePath);

// ── helper: in-process server ─────────────────────────────────────
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
  prismaState.invitations = [];
  auditMock._calls.length = 0;
  triggerCalls.length = 0;
  authMock._user = { id: 'u-admin', email: 'admin@example.com' };
}

// ── trigger registry sanity ───────────────────────────────────────
describe('trigger-registry · org.invitation.* events', () => {
  test('exposes the three lifecycle events', () => {
    assert.ok(realTriggers.TRIGGERS.includes('org.invitation.created'));
    assert.ok(realTriggers.TRIGGERS.includes('org.invitation.accepted'));
    assert.ok(realTriggers.TRIGGERS.includes('org.invitation.revoked'));
    assert.equal(realTriggers.isKnownTrigger('org.invitation.created'), true);
    assert.equal(realTriggers.isKnownTrigger('org.invitation.accepted'), true);
    assert.equal(realTriggers.isKnownTrigger('org.invitation.revoked'), true);
  });
});

// ── GET /api/orgs/:id/invitations ─────────────────────────────────
describe('GET /api/orgs/:id/invitations', () => {
  beforeEach(() => resetState());

  test('lists pending invitations with daysUntilExpiry', async () => {
    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    prismaState.invitations.push({
      id: 'inv-1', orgId: 'org-1', email: 'a@x.com', role: 'MEMBER',
      token: 't'.repeat(32), acceptedAt: null,
      expiresAt: future, createdAt: new Date(),
    });
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/invitations' });
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
    const item = res.body.items[0];
    assert.equal(item.id, 'inv-1');
    assert.equal(item.email, 'a@x.com');
    assert.equal(item.role, 'MEMBER');
    assert.ok(typeof item.daysUntilExpiry === 'number');
    assert.ok(item.daysUntilExpiry >= 4 && item.daysUntilExpiry <= 5);
  });

  test('excludes accepted invitations', async () => {
    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    prismaState.invitations.push({
      id: 'inv-accepted', orgId: 'org-1', email: 'b@x.com', role: 'MEMBER',
      token: 'b'.repeat(32), acceptedAt: new Date(),
      expiresAt: future, createdAt: new Date(),
    });
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/invitations' });
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 0);
  });

  test('VIEWER role is rejected (403)', async () => {
    prismaState.membership.role = 'VIEWER';
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/invitations' });
    assert.equal(res.status, 403);
  });

  test('non-member returns 404', async () => {
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-2/invitations' });
    assert.equal(res.status, 404);
  });
});

// ── DELETE /api/orgs/:id/invitations/:token ───────────────────────
describe('DELETE /api/orgs/:id/invitations/:token', () => {
  beforeEach(() => resetState());

  test('revokes pending invitation, fires trigger, writes audit log', async () => {
    const token = 'r'.repeat(32);
    prismaState.invitations.push({
      id: 'inv-r', orgId: 'org-1', email: 'r@x.com', role: 'MEMBER',
      token, acceptedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000), createdAt: new Date(),
    });

    const res = await callRoute({ method: 'DELETE', urlPath: `/api/orgs/org-1/invitations/${token}` });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(prismaState.invitations.length, 0);

    // Audit log
    assert.equal(auditMock._calls.length, 1);
    assert.equal(auditMock._calls[0].action, 'org_invite_revoke');

    // Trigger
    assert.equal(triggerCalls.length, 1);
    assert.equal(triggerCalls[0].event, 'org.invitation.revoked');
    assert.equal(triggerCalls[0].payload.orgId, 'org-1');
    assert.equal(triggerCalls[0].payload.invitationId, 'inv-r');
    assert.equal(triggerCalls[0].payload.email, 'r@x.com');
    assert.equal(triggerCalls[0].userId, 'u-admin');
  });

  test('rejects revoking an already-accepted invitation (409)', async () => {
    const token = 'a'.repeat(32);
    prismaState.invitations.push({
      id: 'inv-a', orgId: 'org-1', email: 'x@x.com', role: 'MEMBER',
      token, acceptedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000), createdAt: new Date(),
    });
    const res = await callRoute({ method: 'DELETE', urlPath: `/api/orgs/org-1/invitations/${token}` });
    assert.equal(res.status, 409);
    assert.equal(prismaState.invitations.length, 1, 'must not delete an accepted invite');
    assert.equal(triggerCalls.length, 0);
  });

  test('unknown token returns 404', async () => {
    const res = await callRoute({ method: 'DELETE', urlPath: `/api/orgs/org-1/invitations/${'z'.repeat(32)}` });
    assert.equal(res.status, 404);
  });

  test('VIEWER is rejected (403)', async () => {
    prismaState.membership.role = 'VIEWER';
    const token = 'v'.repeat(32);
    prismaState.invitations.push({
      id: 'inv-v', orgId: 'org-1', email: 'v@x.com', role: 'MEMBER',
      token, acceptedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000), createdAt: new Date(),
    });
    const res = await callRoute({ method: 'DELETE', urlPath: `/api/orgs/org-1/invitations/${token}` });
    assert.equal(res.status, 403);
  });

  test('invalid token (too short) returns 400', async () => {
    const res = await callRoute({ method: 'DELETE', urlPath: '/api/orgs/org-1/invitations/short' });
    assert.equal(res.status, 400);
  });
});

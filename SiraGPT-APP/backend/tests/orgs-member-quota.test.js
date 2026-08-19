'use strict';

/**
 * Ratchet 45 — org member-count quota by plan + /api/orgs/:id/limits
 *
 *   FREE       → 3 members
 *   PRO        → 10 members
 *   PRO_MAX    → 50 members
 *   ENTERPRISE → unlimited (cap: null in the API)
 *
 * Covers:
 *   - POST /api/orgs/:id/invite returns 402 when the cap is reached
 *     (counting active members + pending invitations).
 *   - POST /api/orgs/:id/invite succeeds when ENTERPRISE (unlimited).
 *   - POST /api/orgs/invitation/:token/accept returns 402 when the
 *     org has been downgraded between mint + accept.
 *   - GET  /api/orgs/:id/limits returns the usage/cap snapshot.
 *
 * Same in-process express harness used by orgs-invitations.test.js —
 * see that file for the rationale behind the require-cache mocks.
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

// In-memory prisma fake — only the surface touched by invite / accept
// / limits / billing endpoints.
const prismaState = {
  membership: { id: 'm1', orgId: 'org-1', userId: 'u-admin', role: 'ADMIN' },
  organization: {
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    billingPlan: 'FREE',
    ownerId: 'u-admin',
    monthlyQuota: BigInt(50_000),
    usedThisMonth: BigInt(0),
    quotaResetAt: null,
  },
  memberships: [], // [{ orgId, userId, role }]
  invitations: [], // [{ id, orgId, email, role, token, acceptedAt, expiresAt, createdAt }]
};

function matchPending(r, where, now) {
  if (where.orgId && r.orgId !== where.orgId) return false;
  if (where.acceptedAt === null && r.acceptedAt) return false;
  if (where.expiresAt && where.expiresAt.gt) {
    const cmp = where.expiresAt.gt instanceof Date ? where.expiresAt.gt.getTime() : now;
    if (r.expiresAt.getTime() <= cmp) return false;
  }
  return true;
}

const prismaMock = {
  orgMembership: {
    findUnique: async ({ where }) => {
      const { orgId, userId } = where.orgId_userId;
      if (orgId === prismaState.membership.orgId && userId === prismaState.membership.userId) {
        return { ...prismaState.membership, organization: { ...prismaState.organization } };
      }
      const m = prismaState.memberships.find((x) => x.orgId === orgId && x.userId === userId);
      return m ? { ...m, organization: { ...prismaState.organization } } : null;
    },
    count: async ({ where }) => {
      const base = prismaState.memberships.filter((m) => m.orgId === where.orgId).length;
      // The acting admin counts too.
      const adminMatch = prismaState.membership.orgId === where.orgId ? 1 : 0;
      return base + adminMatch;
    },
    create: async ({ data }) => {
      prismaState.memberships.push({ ...data });
      return { ...data };
    },
  },
  orgInvitation: {
    count: async ({ where }) => {
      const now = Date.now();
      return prismaState.invitations.filter((r) => matchPending(r, where, now)).length;
    },
    create: async ({ data }) => {
      const row = {
        id: `inv-${prismaState.invitations.length + 1}`,
        acceptedAt: null,
        createdAt: new Date(),
        ...data,
      };
      prismaState.invitations.push(row);
      return row;
    },
    findUnique: async ({ where, include }) => {
      void include;
      const row = where.token
        ? prismaState.invitations.find((r) => r.token === where.token)
        : prismaState.invitations.find((r) => r.id === where.id);
      if (!row) return null;
      return { ...row, organization: { ...prismaState.organization } };
    },
    update: async ({ where, data }) => {
      const row = prismaState.invitations.find((r) => r.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  },
  organization: {
    findUnique: async ({ where }) => {
      if (where.id === prismaState.organization.id) return { ...prismaState.organization };
      return null;
    },
  },
  $transaction: async (fn) => fn(prismaMock),
};

const auditMock = {
  _calls: [],
  writeAuditLog: (_db, payload) => { auditMock._calls.push(payload); },
};

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

function resetState({ plan = 'FREE', memberCount = 0, pendingInvites = 0 } = {}) {
  prismaState.membership = { id: 'm1', orgId: 'org-1', userId: 'u-admin', role: 'ADMIN' };
  prismaState.organization = {
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    billingPlan: plan,
    ownerId: 'u-admin',
    monthlyQuota: BigInt(50_000),
    usedThisMonth: BigInt(0),
    quotaResetAt: null,
  };
  prismaState.memberships = [];
  // memberCount includes the acting admin; seed the rest as plain members.
  for (let i = 1; i < memberCount; i++) {
    prismaState.memberships.push({ orgId: 'org-1', userId: `u-${i}`, role: 'MEMBER' });
  }
  prismaState.invitations = [];
  const future = new Date(Date.now() + 5 * 86_400_000);
  for (let i = 0; i < pendingInvites; i++) {
    prismaState.invitations.push({
      id: `inv-seed-${i}`,
      orgId: 'org-1',
      email: `p${i}@x.com`,
      role: 'MEMBER',
      token: `seed${i}`.padEnd(32, 'x'),
      acceptedAt: null,
      expiresAt: future,
      createdAt: new Date(),
    });
  }
  auditMock._calls.length = 0;
  triggerCalls.length = 0;
  authMock._user = { id: 'u-admin', email: 'admin@example.com', emailVerifiedAt: new Date() };
}

// ── POST /:id/invite member-quota enforcement ─────────────────────
describe('POST /api/orgs/:id/invite · plan member-count quota', () => {
  beforeEach(() => resetState());

  test('FREE allows invites up to 3 total (members + pending)', async () => {
    resetState({ plan: 'FREE', memberCount: 1, pendingInvites: 0 });
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/invite',
      body: { email: 'new@x.com', role: 'MEMBER' },
    });
    assert.equal(res.status, 201);
  });

  test('FREE rejects with 402 when 1 member + 2 pending invites already', async () => {
    resetState({ plan: 'FREE', memberCount: 1, pendingInvites: 2 });
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/invite',
      body: { email: 'new@x.com', role: 'MEMBER' },
    });
    assert.equal(res.status, 402);
    assert.equal(res.body.plan, 'FREE');
    assert.equal(res.body.cap, 3);
    assert.equal(res.body.used, 3);
  });

  test('PRO allows up to 10 total', async () => {
    resetState({ plan: 'PRO', memberCount: 9, pendingInvites: 0 });
    const ok = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/invite',
      body: { email: 'ten@x.com', role: 'MEMBER' },
    });
    assert.equal(ok.status, 201);

    // simulate the new pending invite already exists; next one should 402
    resetState({ plan: 'PRO', memberCount: 9, pendingInvites: 1 });
    const blocked = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/invite',
      body: { email: 'eleven@x.com', role: 'MEMBER' },
    });
    assert.equal(blocked.status, 402);
    assert.equal(blocked.body.cap, 10);
  });

  test('ENTERPRISE never returns 402', async () => {
    resetState({ plan: 'ENTERPRISE', memberCount: 500, pendingInvites: 0 });
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/invite',
      body: { email: 'limitless@x.com', role: 'MEMBER' },
    });
    assert.equal(res.status, 201);
  });
});

// ── POST /invitation/:token/accept member-quota enforcement ───────
describe('POST /api/orgs/invitation/:token/accept · plan member-count quota', () => {
  beforeEach(() => resetState());

  test('rejects with 402 when org has been downgraded and is already at cap', async () => {
    // Seed an org at FREE with 3 active members (cap met) and one
    // pending invite still on the books from before downgrade.
    resetState({ plan: 'FREE', memberCount: 3, pendingInvites: 0 });
    const token = 'accept-token'.padEnd(32, 'a');
    prismaState.invitations.push({
      id: 'inv-late',
      orgId: 'org-1',
      email: 'late@x.com',
      role: 'MEMBER',
      token,
      acceptedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
    });
    // The accepting user is `late@x.com`.
    authMock._user = { id: 'u-late', email: 'late@x.com', emailVerifiedAt: new Date() };

    const res = await callRoute({
      method: 'POST',
      urlPath: `/api/orgs/invitation/${token}/accept`,
    });
    assert.equal(res.status, 402);
    assert.equal(res.body.plan, 'FREE');
    assert.equal(res.body.cap, 3);
  });

  test('accepts normally when under cap', async () => {
    resetState({ plan: 'PRO', memberCount: 2, pendingInvites: 0 });
    const token = 'ok-token'.padEnd(32, 'o');
    prismaState.invitations.push({
      id: 'inv-ok',
      orgId: 'org-1',
      email: 'ok@x.com',
      role: 'MEMBER',
      token,
      acceptedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
    });
    authMock._user = { id: 'u-ok', email: 'ok@x.com', emailVerifiedAt: new Date() };

    const res = await callRoute({
      method: 'POST',
      urlPath: `/api/orgs/invitation/${token}/accept`,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });
});

// ── GET /:id/limits ───────────────────────────────────────────────
describe('GET /api/orgs/:id/limits', () => {
  beforeEach(() => resetState());

  test('returns plan, members usage/cap, and monthlyQuota usage/cap (FREE)', async () => {
    resetState({ plan: 'FREE', memberCount: 1, pendingInvites: 1 });
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/limits' });
    assert.equal(res.status, 200);
    assert.equal(res.body.plan, 'FREE');
    assert.equal(res.body.members.cap, 3);
    assert.equal(res.body.members.active, 1);
    assert.equal(res.body.members.pending, 1);
    assert.equal(res.body.members.used, 2);
    assert.equal(res.body.monthlyQuota.cap, '50000');
    assert.equal(res.body.monthlyQuota.used, '0');
  });

  test('ENTERPRISE returns cap=null for unlimited members', async () => {
    resetState({ plan: 'ENTERPRISE', memberCount: 1, pendingInvites: 0 });
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/limits' });
    assert.equal(res.status, 200);
    assert.equal(res.body.plan, 'ENTERPRISE');
    assert.equal(res.body.members.cap, null);
  });

  test('VIEWER role is allowed (any member)', async () => {
    resetState({ plan: 'PRO', memberCount: 1, pendingInvites: 0 });
    prismaState.membership.role = 'VIEWER';
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/limits' });
    assert.equal(res.status, 200);
    assert.equal(res.body.members.cap, 10);
  });

  test('non-member returns 404', async () => {
    resetState({ plan: 'FREE' });
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/other-org/limits' });
    assert.equal(res.status, 404);
  });
});

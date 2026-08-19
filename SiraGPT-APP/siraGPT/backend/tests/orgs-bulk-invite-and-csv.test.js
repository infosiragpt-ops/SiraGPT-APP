'use strict';

/**
 * Ratchet 45 — tests for bulk member operations + CSV export.
 *
 *   POST /api/orgs/:id/members/bulk-invite (ADMIN+)
 *   GET  /api/orgs/:id/members.csv         (ADMIN+)
 *
 * Same require-cache mocking style used by orgs-invitations.test.js:
 * fake auth + prisma + audit + trigger-registry; orgs router is
 * required after mocks are installed.
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
  _user: { id: 'u-admin', email: 'admin@example.com' },
  authenticateToken: (req, _res, next) => {
    req.user = authMock._user;
    next();
  },
};

const prismaState = {
  membership: {
    id: 'm1',
    orgId: 'org-1',
    userId: 'u-admin',
    role: 'ADMIN',
    organization: { id: 'org-1', billingPlan: 'PRO' },
  },
  memberCount: 1,
  memberships: [], // [{ id, orgId, userId, role, createdAt, user }]
  invitations: [], // [{ id, orgId, email, role, token, acceptedAt, expiresAt, createdAt }]
  users: [],       // [{ id, email, name, lastActiveAt }]
  invSeq: 0,
};

function makeId() {
  prismaState.invSeq += 1;
  return `inv-${prismaState.invSeq}`;
}

const prismaMock = {
  orgMembership: {
    findUnique: async ({ where }) => {
      const { orgId, userId } = where.orgId_userId;
      if (orgId !== prismaState.membership.orgId) return null;
      if (userId !== prismaState.membership.userId) return null;
      return { ...prismaState.membership };
    },
    count: async ({ where }) => {
      if (where.orgId && where.orgId !== 'org-1') return 0;
      return prismaState.memberCount;
    },
    findMany: async ({ where, include, select, orderBy }) => {
      void orderBy;
      const rows = prismaState.memberships.filter((m) => m.orgId === where.orgId);
      if (where.userId && where.userId.in) {
        const set = new Set(where.userId.in);
        return rows.filter((m) => set.has(m.userId)).map((m) => ({
          userId: m.userId,
          user: (include?.user || select?.user) ? { email: m.user?.email } : undefined,
        }));
      }
      return rows.map((m) => ({
        id: m.id,
        orgId: m.orgId,
        userId: m.userId,
        role: m.role,
        createdAt: m.createdAt,
        user: include?.user ? m.user : undefined,
      }));
    },
  },
  orgInvitation: {
    count: async ({ where }) => {
      const now = Date.now();
      return prismaState.invitations.filter((r) => {
        if (where.orgId && r.orgId !== where.orgId) return false;
        if (where.acceptedAt === null && r.acceptedAt) return false;
        if (where.expiresAt && where.expiresAt.gt) {
          const cmp = where.expiresAt.gt instanceof Date ? where.expiresAt.gt.getTime() : now;
          if (r.expiresAt.getTime() <= cmp) return false;
        }
        return true;
      }).length;
    },
    findMany: async ({ where }) => {
      const now = Date.now();
      return prismaState.invitations.filter((r) => {
        if (where.orgId && r.orgId !== where.orgId) return false;
        if (where.acceptedAt === null && r.acceptedAt) return false;
        if (where.email && where.email.in && !where.email.in.includes(r.email)) return false;
        if (where.expiresAt && where.expiresAt.gt) {
          const cmp = where.expiresAt.gt instanceof Date ? where.expiresAt.gt.getTime() : now;
          if (r.expiresAt.getTime() <= cmp) return false;
        }
        return true;
      }).map((r) => ({ email: r.email }));
    },
    create: async ({ data }) => {
      const row = {
        id: makeId(),
        orgId: data.orgId,
        email: data.email,
        role: data.role,
        token: data.token,
        invitedBy: data.invitedBy,
        acceptedAt: null,
        expiresAt: data.expiresAt,
        createdAt: new Date(),
      };
      prismaState.invitations.push(row);
      return row;
    },
  },
  user: {
    findMany: async ({ where }) => {
      const list = where?.email?.in ? prismaState.users.filter((u) => where.email.in.includes(u.email)) : prismaState.users.slice();
      return list.map((u) => ({ id: u.id, email: u.email }));
    },
  },
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
            const ct = res.headers['content-type'] || '';
            let parsed = null;
            if (ct.includes('application/json')) {
              try { parsed = buf ? JSON.parse(buf) : null; } catch { parsed = null; }
            }
            resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: buf });
          });
        },
      );
      req.on('error', (e) => { server.close(); reject(e); });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

function resetState({ role = 'ADMIN', plan = 'PRO' } = {}) {
  prismaState.membership = {
    id: 'm1',
    orgId: 'org-1',
    userId: 'u-admin',
    role,
    organization: { id: 'org-1', billingPlan: plan },
  };
  prismaState.memberCount = 1;
  prismaState.memberships = [];
  prismaState.invitations = [];
  prismaState.users = [];
  prismaState.invSeq = 0;
  auditMock._calls.length = 0;
  triggerCalls.length = 0;
  authMock._user = { id: 'u-admin', email: 'admin@example.com' };
}

// ── Bulk invite ────────────────────────────────────────────────────
describe('POST /api/orgs/:id/members/bulk-invite', () => {
  beforeEach(() => resetState());

  test('invites multiple fresh emails and writes audit + triggers', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/members/bulk-invite',
      body: { emails: ['a@x.com', 'b@x.com', 'c@x.com'], role: 'MEMBER' },
    });
    assert.equal(res.status, 207);
    assert.equal(res.body.invited.length, 3);
    assert.equal(res.body.skipped.length, 0);
    assert.equal(res.body.errors.length, 0);
    assert.equal(prismaState.invitations.length, 3);
    assert.equal(auditMock._calls.length, 3);
    assert.equal(auditMock._calls[0].action, 'org_invite_create');
    assert.equal(auditMock._calls[0].metadata.bulk, true);
    assert.equal(triggerCalls.length, 3);
    assert.equal(triggerCalls[0].event, 'org.invitation.created');
    // Each invited entry has token + magicLink + expiresAt
    for (const inv of res.body.invited) {
      assert.ok(inv.token && inv.token.length >= 16);
      assert.ok(inv.magicLink.endsWith(inv.token));
      assert.ok(inv.expiresAt);
    }
  });

  test('dedupes duplicate emails inside the request', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/members/bulk-invite',
      body: { emails: ['a@x.com', 'A@X.com', 'b@x.com'], role: 'MEMBER' },
    });
    assert.equal(res.status, 207);
    assert.equal(res.body.invited.length, 2);
    assert.equal(res.body.skipped.length, 1);
    assert.equal(res.body.skipped[0].reason, 'duplicate-in-request');
  });

  test('classifies invalid emails into errors[]', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/members/bulk-invite',
      body: { emails: ['ok@x.com', 'not-an-email', '   ', 42], role: 'MEMBER' },
    });
    assert.equal(res.status, 207);
    assert.equal(res.body.invited.length, 1);
    const errEmails = res.body.errors.map((e) => e.error);
    assert.ok(errEmails.every((e) => e === 'invalid-email'));
    assert.equal(res.body.errors.length, 3);
  });

  test('skips already-member and pending-invite emails', async () => {
    prismaState.users.push({ id: 'u-1', email: 'already@x.com' });
    prismaState.memberships.push({
      id: 'mm-1', orgId: 'org-1', userId: 'u-1', role: 'MEMBER',
      createdAt: new Date(), user: { id: 'u-1', email: 'already@x.com' },
    });
    prismaState.invitations.push({
      id: 'inv-pre', orgId: 'org-1', email: 'pending@x.com', role: 'MEMBER',
      token: 'p'.repeat(32), acceptedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000), createdAt: new Date(),
    });

    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/members/bulk-invite',
      body: { emails: ['already@x.com', 'pending@x.com', 'fresh@x.com'], role: 'MEMBER' },
    });
    assert.equal(res.status, 207);
    assert.equal(res.body.invited.length, 1);
    assert.equal(res.body.invited[0].email, 'fresh@x.com');
    const reasons = res.body.skipped.map((s) => `${s.email}:${s.reason}`).sort();
    assert.deepEqual(reasons, ['already@x.com:already-member', 'pending@x.com:pending-invite']);
  });

  test('enforces 50-email cap with 400', async () => {
    const emails = Array.from({ length: 51 }, (_, i) => `u${i}@x.com`);
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/members/bulk-invite',
      body: { emails, role: 'MEMBER' },
    });
    assert.equal(res.status, 400);
  });

  test('returns 400 when emails missing or empty', async () => {
    const r1 = await callRoute({ method: 'POST', urlPath: '/api/orgs/org-1/members/bulk-invite', body: {} });
    assert.equal(r1.status, 400);
    const r2 = await callRoute({ method: 'POST', urlPath: '/api/orgs/org-1/members/bulk-invite', body: { emails: [] } });
    assert.equal(r2.status, 400);
  });

  test('rejects OWNER role (400)', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/members/bulk-invite',
      body: { emails: ['a@x.com'], role: 'OWNER' },
    });
    assert.equal(res.status, 400);
  });

  test('VIEWER caller is rejected (403)', async () => {
    resetState({ role: 'VIEWER' });
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/members/bulk-invite',
      body: { emails: ['a@x.com'], role: 'MEMBER' },
    });
    assert.equal(res.status, 403);
  });

  test('FREE plan member-cap fills errors[] with quota-exceeded', async () => {
    // FREE cap is small; force using FREE plan and pre-populate
    // memberCount to push us right at the cap.
    resetState({ plan: 'FREE' });
    // The FREE cap is 3 (see PLAN_MEMBER_CAPS). One existing member
    // (the caller) + 2 pending = at the cap of 3, so all 3 new invites
    // should fail with quota-exceeded.
    prismaState.memberCount = 1;
    prismaState.invitations.push(
      { id: 'pinv-a', orgId: 'org-1', email: 'p1@x.com', role: 'MEMBER', token: 'q'.repeat(32), acceptedAt: null, expiresAt: new Date(Date.now() + 86_400_000), createdAt: new Date() },
      { id: 'pinv-b', orgId: 'org-1', email: 'p2@x.com', role: 'MEMBER', token: 'r'.repeat(32), acceptedAt: null, expiresAt: new Date(Date.now() + 86_400_000), createdAt: new Date() },
    );

    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/members/bulk-invite',
      body: { emails: ['n1@x.com', 'n2@x.com', 'n3@x.com'], role: 'MEMBER' },
    });
    assert.equal(res.status, 207);
    assert.equal(res.body.invited.length, 0);
    assert.ok(res.body.errors.length >= 1);
    assert.ok(res.body.errors.every((e) => e.error === 'quota-exceeded'));
  });
});

// ── Members CSV export ─────────────────────────────────────────────
describe('GET /api/orgs/:id/members.csv', () => {
  beforeEach(() => resetState());

  test('renders RFC4180 CSV with the expected columns', async () => {
    prismaState.memberships.push(
      {
        id: 'mm-1', orgId: 'org-1', userId: 'u-1', role: 'OWNER',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        user: {
          id: 'u-1', email: 'owner@x.com', name: 'Owner One',
          lastActiveAt: new Date('2026-05-01T12:00:00.000Z'),
        },
      },
      {
        id: 'mm-2', orgId: 'org-1', userId: 'u-2', role: 'MEMBER',
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
        user: {
          id: 'u-2', email: 'mem@x.com', name: 'Mem, "Two"',
          lastActiveAt: null,
        },
      },
    );

    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/members.csv' });
    assert.equal(res.status, 200);
    assert.ok((res.headers['content-type'] || '').startsWith('text/csv'));
    assert.ok((res.headers['content-disposition'] || '').includes('attachment'));

    const lines = res.raw.split('\r\n');
    assert.equal(lines[0], 'userId,email,name,role,joinedAt,lastActiveAt');
    assert.equal(lines[1], 'u-1,owner@x.com,Owner One,OWNER,2026-01-01T00:00:00.000Z,2026-05-01T12:00:00.000Z');
    // Row 2: the name contains a comma + quote → must be wrapped in
    // double quotes with the internal quote doubled. lastActiveAt is null.
    assert.equal(lines[2], 'u-2,mem@x.com,"Mem, ""Two""",MEMBER,2026-02-01T00:00:00.000Z,');
    // Trailing CRLF (RFC4180).
    assert.equal(res.raw.endsWith('\r\n'), true);

    // Audit log recorded.
    assert.equal(auditMock._calls.length, 1);
    assert.equal(auditMock._calls[0].action, 'org_members_export');
    assert.equal(auditMock._calls[0].metadata.count, 2);
  });

  test('VIEWER cannot export (403)', async () => {
    resetState({ role: 'VIEWER' });
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/members.csv' });
    assert.equal(res.status, 403);
  });

  test('non-member returns 404', async () => {
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-2/members.csv' });
    assert.equal(res.status, 404);
  });
});

// ── Internal helpers (CSV escaping) ────────────────────────────────
describe('orgs.INTERNAL_MEMBERS_CSV.membersCsvEscape', () => {
  const { membersCsvEscape, membersToCsv, BULK_INVITE_MAX } = orgsRouter.INTERNAL_MEMBERS_CSV;

  test('passes-through plain strings', () => {
    assert.equal(membersCsvEscape('hello'), 'hello');
  });
  test('renders null/undefined as empty', () => {
    assert.equal(membersCsvEscape(null), '');
    assert.equal(membersCsvEscape(undefined), '');
  });
  test('wraps + escapes commas, quotes, CR, LF', () => {
    assert.equal(membersCsvEscape('a,b'), '"a,b"');
    assert.equal(membersCsvEscape('a"b'), '"a""b"');
    assert.equal(membersCsvEscape('a\nb'), '"a\nb"');
  });
  test('renders Date as ISO string', () => {
    assert.equal(membersCsvEscape(new Date('2026-05-18T00:00:00.000Z')), '2026-05-18T00:00:00.000Z');
  });
  test('membersToCsv terminates with CRLF', () => {
    const out = membersToCsv([{ userId: 'u', email: 'e', name: 'n', role: 'MEMBER', joinedAt: '', lastActiveAt: '' }]);
    assert.ok(out.endsWith('\r\n'));
  });
  test('BULK_INVITE_MAX is 50', () => {
    assert.equal(BULK_INVITE_MAX, 50);
  });
});

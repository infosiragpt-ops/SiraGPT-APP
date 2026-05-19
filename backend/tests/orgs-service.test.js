'use strict';

/**
 * Unit tests for src/services/orgs-service and the org-quota middleware.
 * Pure-JS — no Prisma client / Express bind required.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const orgs = require('../src/services/orgs-service');
const orgQuota = require('../src/middleware/enforce-org-quota');

// ─── slugify ─────────────────────────────────────────────────────────
test('slugify: lowercases and replaces non-alnum', () => {
  assert.equal(orgs.slugify('Acme Inc.'), 'acme-inc');
  assert.equal(orgs.slugify('  Hello   World!! '), 'hello-world');
  // Diacritics are stripped via NFKD normalization
  assert.equal(orgs.slugify('Café Niño'), 'cafe-nino');
});

test('slugify: returns "org" for empty/invalid input', () => {
  assert.equal(orgs.slugify(''), 'org');
  assert.equal(orgs.slugify(null), '');
});

// ─── token ───────────────────────────────────────────────────────────
test('generateInviteToken: 64 hex chars', () => {
  const t = orgs.generateInviteToken();
  assert.match(t, /^[a-f0-9]{64}$/);
  // entropy: two calls differ
  assert.notEqual(t, orgs.generateInviteToken());
});

// ─── roleAtLeast ─────────────────────────────────────────────────────
test('roleAtLeast: OWNER > ADMIN > MEMBER > VIEWER', () => {
  assert.equal(orgs.roleAtLeast('OWNER', 'ADMIN'), true);
  assert.equal(orgs.roleAtLeast('ADMIN', 'MEMBER'), true);
  assert.equal(orgs.roleAtLeast('MEMBER', 'VIEWER'), true);
  assert.equal(orgs.roleAtLeast('VIEWER', 'MEMBER'), false);
  assert.equal(orgs.roleAtLeast('MEMBER', 'OWNER'), false);
  assert.equal(orgs.roleAtLeast('FOO', 'BAR'), false);
});

test('canManageMembers: ADMIN+ only', () => {
  assert.equal(orgs.canManageMembers('OWNER'), true);
  assert.equal(orgs.canManageMembers('ADMIN'), true);
  assert.equal(orgs.canManageMembers('MEMBER'), false);
  assert.equal(orgs.canManageMembers('VIEWER'), false);
});

test('canShareToOrg: MEMBER+ only', () => {
  assert.equal(orgs.canShareToOrg('MEMBER'), true);
  assert.equal(orgs.canShareToOrg('ADMIN'), true);
  assert.equal(orgs.canShareToOrg('VIEWER'), false);
});

test('isValidRole: accepts only enum members', () => {
  assert.equal(orgs.isValidRole('OWNER'), true);
  assert.equal(orgs.isValidRole('GUEST'), false);
  assert.equal(orgs.isValidRole(null), false);
});

// ─── assertMembership ────────────────────────────────────────────────
test('assertMembership: returns row when member', async () => {
  const prismaStub = {
    orgMembership: {
      findUnique: async () => ({ id: 'm1', role: 'ADMIN', organization: { id: 'o1' } }),
    },
  };
  const row = await orgs.assertMembership(prismaStub, 'o1', 'u1', 'MEMBER');
  assert.equal(row.role, 'ADMIN');
});

test('assertMembership: 404 when not a member', async () => {
  const prismaStub = {
    orgMembership: { findUnique: async () => null },
  };
  await assert.rejects(
    () => orgs.assertMembership(prismaStub, 'o1', 'u1', 'VIEWER'),
    (err) => err.status === 404,
  );
});

test('assertMembership: 403 when role too low', async () => {
  const prismaStub = {
    orgMembership: {
      findUnique: async () => ({ id: 'm1', role: 'VIEWER', organization: { id: 'o1' } }),
    },
  };
  await assert.rejects(
    () => orgs.assertMembership(prismaStub, 'o1', 'u1', 'ADMIN'),
    (err) => err.status === 403,
  );
});

// ─── uniqueSlug ──────────────────────────────────────────────────────
test('uniqueSlug: returns base when free', async () => {
  const prismaStub = {
    organization: { findUnique: async () => null },
  };
  const slug = await orgs.uniqueSlug(prismaStub, 'Acme');
  assert.equal(slug, 'acme');
});

test('uniqueSlug: appends suffix when base taken', async () => {
  let calls = 0;
  const prismaStub = {
    organization: {
      findUnique: async () => {
        calls += 1;
        return calls === 1 ? { id: 'taken' } : null;
      },
    },
  };
  const slug = await orgs.uniqueSlug(prismaStub, 'Acme');
  assert.match(slug, /^acme-[a-f0-9]{4}$/);
});

// ─── org-quota: resolveOrgId ─────────────────────────────────────────
test('resolveOrgId: prefers header over body', () => {
  const req = {
    headers: { 'x-org-id': 'hdr-org' },
    body: { organizationId: 'body-org' },
  };
  assert.equal(orgQuota.resolveOrgId(req), 'hdr-org');
});

test('resolveOrgId: falls back to body', () => {
  const req = { headers: {}, body: { organizationId: 'body-org' } };
  assert.equal(orgQuota.resolveOrgId(req), 'body-org');
});

test('resolveOrgId: null when neither', () => {
  assert.equal(orgQuota.resolveOrgId({ headers: {}, body: {} }), null);
});

test('sameCalendarMonth: same vs. different month', () => {
  const a = new Date(Date.UTC(2026, 4, 1));
  const b = new Date(Date.UTC(2026, 4, 29));
  const c = new Date(Date.UTC(2026, 5, 1));
  assert.equal(orgQuota.sameCalendarMonth(a, b), true);
  assert.equal(orgQuota.sameCalendarMonth(a, c), false);
});

// ─── org-quota: end-to-end with fake prisma ──────────────────────────
function makeFakePrisma(initial) {
  const org = { ...initial };
  return {
    _org: org,
    orgMembership: {
      findUnique: async () => (org.member ? { role: org.member } : null),
    },
    organization: {
      findUnique: async () => ({
        id: org.id,
        monthlyQuota: BigInt(org.monthlyQuota),
        usedThisMonth: BigInt(org.usedThisMonth),
        quotaResetAt: org.quotaResetAt,
      }),
      update: async ({ data }) => {
        if (data.usedThisMonth?.increment != null) {
          org.usedThisMonth = BigInt(org.usedThisMonth) + BigInt(data.usedThisMonth.increment);
        } else if (data.usedThisMonth?.decrement != null) {
          org.usedThisMonth = BigInt(org.usedThisMonth) - BigInt(data.usedThisMonth.decrement);
        } else if (data.usedThisMonth != null) {
          org.usedThisMonth = data.usedThisMonth;
        }
        if (data.quotaResetAt) org.quotaResetAt = data.quotaResetAt;
        return org;
      },
    },
  };
}

function makeRes() {
  const headers = {};
  let status = 200;
  let body;
  return {
    headers,
    setHeader(k, v) { headers[k] = v; },
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
    get _status() { return status; },
    get _body() { return body; },
  };
}

test('enforce-org-quota: no-op when no org context', async () => {
  const fake = makeFakePrisma({
    id: 'o1', member: 'MEMBER', monthlyQuota: 100, usedThisMonth: 0, quotaResetAt: new Date(),
  });
  const mw = orgQuota.enforceOrgQuota({ prisma: fake });
  let called = false;
  await mw({ user: { id: 'u1' }, headers: {}, body: {} }, makeRes(), () => { called = true; });
  assert.equal(called, true);
  assert.equal(fake._org.usedThisMonth.toString(), '0');
});

test('enforce-org-quota: increments usedThisMonth when allowed', async () => {
  const fake = makeFakePrisma({
    id: 'o1', member: 'MEMBER', monthlyQuota: 100, usedThisMonth: 5, quotaResetAt: new Date(),
  });
  const mw = orgQuota.enforceOrgQuota({ prisma: fake });
  const req = { user: { id: 'u1' }, headers: { 'x-org-id': 'o1' }, body: {} };
  const res = makeRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(fake._org.usedThisMonth.toString(), '6');
  assert.equal(res.headers['X-Org-Quota-Used'], '6');
  assert.equal(res.headers['X-Org-Quota-Limit'], '100');
  assert.equal(req.orgContext.orgId, 'o1');
});

test('enforce-org-quota: 429 when over quota', async () => {
  const fake = makeFakePrisma({
    id: 'o1', member: 'MEMBER', monthlyQuota: 10, usedThisMonth: 10, quotaResetAt: new Date(),
  });
  const mw = orgQuota.enforceOrgQuota({ prisma: fake });
  const req = { user: { id: 'u1' }, headers: { 'x-org-id': 'o1' }, body: {} };
  const res = makeRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res._status, 429);
  assert.equal(fake._org.usedThisMonth.toString(), '10'); // not incremented
});

test('enforce-org-quota: 403 when not a member', async () => {
  const fake = makeFakePrisma({
    id: 'o1', member: null, monthlyQuota: 100, usedThisMonth: 0, quotaResetAt: new Date(),
  });
  const mw = orgQuota.enforceOrgQuota({ prisma: fake });
  const req = { user: { id: 'u1' }, headers: { 'x-org-id': 'o1' }, body: {} };
  const res = makeRes();
  await mw(req, res, () => {
    throw new Error('should not call next');
  });
  assert.equal(res._status, 403);
});

test('enforce-org-quota: refund decrements usage', async () => {
  const fake = makeFakePrisma({
    id: 'o1', member: 'ADMIN', monthlyQuota: 100, usedThisMonth: 0, quotaResetAt: new Date(),
  });
  const mw = orgQuota.enforceOrgQuota({ prisma: fake });
  const req = { user: { id: 'u1' }, headers: { 'x-org-id': 'o1' }, body: {} };
  await mw(req, makeRes(), () => {});
  assert.equal(fake._org.usedThisMonth.toString(), '1');
  await req.orgContext.refund();
  assert.equal(fake._org.usedThisMonth.toString(), '0');
});

test('enforce-org-quota: resets counter on month rollover', async () => {
  const lastMonth = new Date(Date.UTC(2025, 0, 1)); // very old
  const fake = makeFakePrisma({
    id: 'o1', member: 'MEMBER', monthlyQuota: 100, usedThisMonth: 90, quotaResetAt: lastMonth,
  });
  const mw = orgQuota.enforceOrgQuota({ prisma: fake });
  const req = { user: { id: 'u1' }, headers: { 'x-org-id': 'o1' }, body: {} };
  const res = makeRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  // After reset → was 0 → incremented to 1
  assert.equal(fake._org.usedThisMonth.toString(), '1');
});

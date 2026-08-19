'use strict';

/**
 * Ratchet 45 — org-enforced 2FA tests.
 *
 * Covers:
 *   - orgs-service helpers (orgRequiresTwoFactor, userHasTwoFactor, assertOrgTwoFactor)
 *   - assertMembership opts.user 2FA gate
 *   - POST /api/orgs/:id/security handler (OWNER toggle)
 *   - org-context fetch (getOrgSettings) returning 403 + code 'org_requires_2fa'
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  orgRequiresTwoFactor,
  userHasTwoFactor,
  assertOrgTwoFactor,
  assertMembership,
} = require('../src/services/orgs-service');

const orgsRouter = require('../src/routes/orgs');
const { postOrgSecurity, getOrgSettings } = orgsRouter.__handlers;

function makeRes() {
  let status = 200;
  let body;
  return {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
    get _status() { return status; },
    get _body() { return body; },
  };
}

function makeFakePrisma({ members = {}, orgs = {} } = {}) {
  const audits = [];
  const writeAuditLog = (_db, payload) => { audits.push(payload); };
  const orgMembership = {
    findUnique: async ({ where }) => {
      const { orgId, userId } = where.orgId_userId;
      const m = members[`${orgId}:${userId}`];
      if (!m) return null;
      return {
        id: 'mem',
        orgId,
        userId,
        role: m.role,
        organization: orgs[orgId] || { id: orgId },
      };
    },
  };
  const organization = {
    findUnique: async ({ where, select }) => {
      const row = orgs[where.id];
      if (!row) return null;
      if (select) {
        const out = {};
        for (const k of Object.keys(select)) out[k] = row[k];
        return out;
      }
      return row;
    },
    update: async ({ where, data, select }) => {
      orgs[where.id] = { ...(orgs[where.id] || { id: where.id }), ...data };
      if (select) {
        const out = {};
        for (const k of Object.keys(select)) out[k] = orgs[where.id][k];
        return out;
      }
      return orgs[where.id];
    },
  };
  return { prisma: { orgMembership, organization }, writeAuditLog, audits };
}

// ─── helpers ────────────────────────────────────────────────────────

test('orgRequiresTwoFactor: returns true only when flag is true', () => {
  assert.equal(orgRequiresTwoFactor(null), false);
  assert.equal(orgRequiresTwoFactor({}), false);
  assert.equal(orgRequiresTwoFactor({ settings: null }), false);
  assert.equal(orgRequiresTwoFactor({ settings: {} }), false);
  assert.equal(orgRequiresTwoFactor({ settings: { security: {} } }), false);
  assert.equal(
    orgRequiresTwoFactor({ settings: { security: { requireTwoFactor: false } } }),
    false,
  );
  assert.equal(
    orgRequiresTwoFactor({ settings: { security: { requireTwoFactor: true } } }),
    true,
  );
  // Tolerant to array/wrong-shape settings.
  assert.equal(orgRequiresTwoFactor({ settings: [] }), false);
});

test('userHasTwoFactor: SMS or TOTP enrolment counts; nothing else does', () => {
  assert.equal(userHasTwoFactor(null), false);
  assert.equal(userHasTwoFactor({}), false);
  // SMS requires twoFactorEnabled + phone + phoneVerifiedAt.
  assert.equal(userHasTwoFactor({ twoFactorEnabled: true }), false);
  assert.equal(
    userHasTwoFactor({ twoFactorEnabled: true, phone: '+34600', phoneVerifiedAt: null }),
    false,
  );
  assert.equal(
    userHasTwoFactor({ twoFactorEnabled: true, phone: '+34600', phoneVerifiedAt: new Date() }),
    true,
  );
  // TOTP alone is enough.
  assert.equal(userHasTwoFactor({ totpEnabled: true }), true);
});

test('assertOrgTwoFactor: throws 403 org_requires_2fa when policy on + user lacks 2FA', () => {
  const org = { settings: { security: { requireTwoFactor: true } } };
  try {
    assertOrgTwoFactor(org, { id: 'u1' });
    assert.fail('expected throw');
  } catch (e) {
    assert.equal(e.status, 403);
    assert.equal(e.code, 'org_requires_2fa');
  }
  // Passes when user has TOTP.
  assertOrgTwoFactor(org, { totpEnabled: true });
  // Passes when policy is off.
  assertOrgTwoFactor({ settings: {} }, { id: 'u1' });
});

// ─── assertMembership 2FA gate ──────────────────────────────────────

test('assertMembership: blocks user without 2FA when org requires it', async () => {
  const { prisma } = makeFakePrisma({
    members: { 'o1:u1': { role: 'MEMBER' } },
    orgs: { o1: { id: 'o1', settings: { security: { requireTwoFactor: true } } } },
  });
  try {
    await assertMembership(prisma, 'o1', 'u1', 'VIEWER', { user: { id: 'u1' } });
    assert.fail('expected throw');
  } catch (e) {
    assert.equal(e.status, 403);
    assert.equal(e.code, 'org_requires_2fa');
  }
});

test('assertMembership: allows user with TOTP enrolled when org requires 2FA', async () => {
  const { prisma } = makeFakePrisma({
    members: { 'o1:u1': { role: 'MEMBER' } },
    orgs: { o1: { id: 'o1', settings: { security: { requireTwoFactor: true } } } },
  });
  const row = await assertMembership(prisma, 'o1', 'u1', 'VIEWER', {
    user: { id: 'u1', totpEnabled: true },
  });
  assert.equal(row.role, 'MEMBER');
});

test('assertMembership: skips 2FA gate when opts.user is omitted (back-compat)', async () => {
  const { prisma } = makeFakePrisma({
    members: { 'o1:u1': { role: 'MEMBER' } },
    orgs: { o1: { id: 'o1', settings: { security: { requireTwoFactor: true } } } },
  });
  const row = await assertMembership(prisma, 'o1', 'u1');
  assert.equal(row.role, 'MEMBER');
});

// ─── POST /api/orgs/:id/security ────────────────────────────────────

test('postOrgSecurity: OWNER toggles flag + writes audit log', async () => {
  const { prisma, writeAuditLog, audits } = makeFakePrisma({
    members: { 'o1:owner1': { role: 'OWNER' } },
    orgs: { o1: { id: 'o1', settings: {} } },
  });
  const req = {
    user: { id: 'owner1' },
    params: { id: 'o1' },
    body: { requireTwoFactor: true },
  };
  const res = makeRes();
  await postOrgSecurity(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 200);
  assert.equal(res._body.security.requireTwoFactor, true);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'org_security_update');
  assert.equal(audits[0].after.security.requireTwoFactor, true);
  assert.equal(audits[0].metadata.orgId, 'o1');
});

test('postOrgSecurity: preserves other settings keys on update', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: { 'o1:owner1': { role: 'OWNER' } },
    orgs: { o1: { id: 'o1', settings: { defaultModel: 'opus-4-7', security: { foo: 'bar' } } } },
  });
  const req = {
    user: { id: 'owner1' },
    params: { id: 'o1' },
    body: { requireTwoFactor: true },
  };
  const res = makeRes();
  await postOrgSecurity(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 200);
  // The merged settings (read directly off the in-memory fake) keep the
  // other top-level keys + the original security sub-keys.
  // We just assert that the stored settings still contains defaultModel.
  const stored = await prisma.organization.findUnique({ where: { id: 'o1' } });
  assert.equal(stored.settings.defaultModel, 'opus-4-7');
  assert.equal(stored.settings.security.foo, 'bar');
  assert.equal(stored.settings.security.requireTwoFactor, true);
});

test('postOrgSecurity: ADMIN rejected (403)', async () => {
  const { prisma, writeAuditLog, audits } = makeFakePrisma({
    members: { 'o1:a1': { role: 'ADMIN' } },
    orgs: { o1: { id: 'o1', settings: {} } },
  });
  const req = {
    user: { id: 'a1' },
    params: { id: 'o1' },
    body: { requireTwoFactor: true },
  };
  const res = makeRes();
  await postOrgSecurity(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 403);
  assert.equal(audits.length, 0);
});

test('postOrgSecurity: non-member returns 404', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: {},
    orgs: { o1: { id: 'o1', settings: {} } },
  });
  const req = {
    user: { id: 'ghost' },
    params: { id: 'o1' },
    body: { requireTwoFactor: true },
  };
  const res = makeRes();
  await postOrgSecurity(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 404);
});

test('postOrgSecurity: rejects non-boolean payload (400)', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: { 'o1:owner1': { role: 'OWNER' } },
    orgs: { o1: { id: 'o1', settings: {} } },
  });
  const req = {
    user: { id: 'owner1' },
    params: { id: 'o1' },
    body: { requireTwoFactor: 'yes' },
  };
  const res = makeRes();
  await postOrgSecurity(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 400);
});

// ─── org-context fetch — 403 propagation ────────────────────────────

test('getOrgSettings: blocks member without 2FA when org requires it (403 + code)', async () => {
  const { prisma } = makeFakePrisma({
    members: { 'o1:u1': { role: 'MEMBER' } },
    orgs: { o1: { id: 'o1', settings: { security: { requireTwoFactor: true } } } },
  });
  const req = { user: { id: 'u1' }, params: { id: 'o1' } };
  const res = makeRes();
  await getOrgSettings(req, res, { prisma });
  assert.equal(res._status, 403);
  assert.equal(res._body.code, 'org_requires_2fa');
});

test('getOrgSettings: allows member with TOTP when org requires 2FA', async () => {
  const { prisma } = makeFakePrisma({
    members: { 'o1:u1': { role: 'MEMBER' } },
    orgs: {
      o1: {
        id: 'o1',
        settings: { security: { requireTwoFactor: true }, defaultModel: 'opus-4-7' },
      },
    },
  });
  const req = { user: { id: 'u1', totpEnabled: true }, params: { id: 'o1' } };
  const res = makeRes();
  await getOrgSettings(req, res, { prisma });
  assert.equal(res._status, 200);
  assert.equal(res._body.settings.defaultModel, 'opus-4-7');
});

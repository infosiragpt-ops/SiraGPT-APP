'use strict';

/**
 * Ratchet 45 — SSO provisioning policies + SSOIdentity link (cycle 144).
 *
 * Exercises the three provisioning policies (`jit_create`,
 * `jit_require_invite`, `manual`) and verifies that the callback
 * handler finds-or-creates an SSOIdentity row keyed by
 * (provider, externalId). The Prisma layer is stubbed via deps so we
 * don't need a live DB.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-sso-provisioning';

const authRouter = require('../src/routes/auth');
const { ssoSamlCallbackHandler } = authRouter.__ssoHelpers;

function makeRes() {
  let status = 200;
  let body;
  return {
    status(c) { status = c; return this; },
    json(p) { body = p; return this; },
    cookie() { return this; },
    set() { return this; },
    get _status() { return status; },
    get _body() { return body; },
  };
}

function makeOrg(extra = {}) {
  return {
    id: 'org1',
    slug: 'acme',
    ssoEnabled: true,
    ssoConfig: {
      provider: 'saml',
      entryPoint: 'https://idp/sso',
      issuer: 'sp',
      callbackUrl: 'https://x/cb',
      cert: 'CERT',
      ...extra,
    },
  };
}

function makePrisma({
  user = null,
  org,
  memberships = [],
  invitations = [],
  identities = [],
} = {}) {
  const db = {
    _identities: identities.slice(),
    _memberships: memberships.slice(),
    _invitations: invitations.slice(),
    user: {
      findUnique: async ({ where }) => (user && where.email === user.email ? user : null),
      create: async ({ data }) => ({ id: 'u-new', ...data }),
    },
    session: { create: async () => ({}) },
    organization: {
      findUnique: async ({ where }) => (org && org.slug === where.slug ? org : null),
    },
    orgMembership: {
      findUnique: async ({ where: { orgId_userId } }) =>
        db._memberships.find(
          (m) => m.orgId === orgId_userId.orgId && m.userId === orgId_userId.userId,
        ) || null,
      upsert: async ({ where: { orgId_userId }, create }) => {
        const found = db._memberships.find(
          (m) => m.orgId === orgId_userId.orgId && m.userId === orgId_userId.userId,
        );
        if (found) return found;
        const row = { ...create };
        db._memberships.push(row);
        return row;
      },
    },
    orgInvitation: {
      findFirst: async ({ where }) =>
        db._invitations.find(
          (i) => i.orgId === where.orgId
            && i.email === where.email
            && i.acceptedAt == null
            && i.expiresAt > new Date(),
        ) || null,
      update: async ({ where: { id }, data }) => {
        const inv = db._invitations.find((i) => i.id === id);
        if (inv) Object.assign(inv, data);
        return inv;
      },
    },
    sSOIdentity: {
      findUnique: async ({ where: { provider_externalId } }) =>
        db._identities.find(
          (r) => r.provider === provider_externalId.provider
            && r.externalId === provider_externalId.externalId,
        ) || null,
      create: async ({ data }) => {
        const row = { id: `ssoi-${db._identities.length + 1}`, ...data, createdAt: new Date(), lastUsedAt: new Date() };
        db._identities.push(row);
        return row;
      },
      update: async ({ where: { id }, data }) => {
        const row = db._identities.find((r) => r.id === id);
        if (row) Object.assign(row, data);
        return row;
      },
    },
  };
  return db;
}

function makeDeps(overrides = {}) {
  return {
    prisma: overrides.prisma,
    writeAuditLog: overrides.writeAuditLog || (() => {}),
    resolveOrgForSso: async (slug) => overrides.prisma.organization.findUnique({ where: { slug } }),
    samlHandler: overrides.samlHandler || {
      verifySamlResponse: async () => ({
        ok: true,
        email: 'alice@acme.com',
        displayName: 'Alice',
        nameId: 'saml-nameid-alice',
        profile: {},
      }),
    },
  };
}

test('jit_create (default) — auto-creates user + identity row', async () => {
  const audits = [];
  const prisma = makePrisma({ org: makeOrg() });
  const deps = makeDeps({ prisma, writeAuditLog: (_d, p) => audits.push(p) });
  const res = makeRes();
  await ssoSamlCallbackHandler(
    { params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } },
    res,
    deps,
  );
  assert.equal(res._status, 200);
  assert.equal(res._body.policy, 'jit_create');
  assert.equal(prisma._identities.length, 1);
  assert.equal(prisma._identities[0].provider, 'saml');
  assert.equal(prisma._identities[0].externalId, 'saml-nameid-alice');
  const success = audits.find((a) => a.action === 'sso_login_success');
  assert.ok(success);
  assert.equal(success.metadata.policy, 'jit_create');
  assert.ok(success.metadata.ssoIdentityId);
});

test('manual — rejects when user is not a member', async () => {
  const audits = [];
  const prisma = makePrisma({ org: makeOrg({ provisioning: 'manual' }) });
  const deps = makeDeps({ prisma, writeAuditLog: (_d, p) => audits.push(p) });
  const res = makeRes();
  await ssoSamlCallbackHandler(
    { params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } },
    res,
    deps,
  );
  assert.equal(res._status, 403);
  assert.equal(res._body.error, 'sso_provisioning_denied');
  assert.equal(prisma._identities.length, 0);
  const denied = audits.find((a) => a.action === 'sso_login_denied');
  assert.ok(denied);
  assert.equal(denied.metadata.policy, 'manual');
  assert.equal(denied.metadata.reason, 'not_a_member');
});

test('manual — allows existing member + creates identity link', async () => {
  const existing = { id: 'u-exist', email: 'alice@acme.com', name: 'Alice', isAdmin: false };
  const prisma = makePrisma({
    org: makeOrg({ provisioning: 'manual' }),
    user: existing,
    memberships: [{ orgId: 'org1', userId: 'u-exist', role: 'MEMBER' }],
  });
  const deps = makeDeps({ prisma });
  const res = makeRes();
  await ssoSamlCallbackHandler(
    { params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } },
    res,
    deps,
  );
  assert.equal(res._status, 200);
  assert.equal(res._body.policy, 'manual');
  assert.equal(res._body.createdUser, false);
  assert.equal(prisma._identities.length, 1);
});

test('jit_require_invite — rejects when no pending invitation', async () => {
  const audits = [];
  const prisma = makePrisma({ org: makeOrg({ provisioning: 'jit_require_invite' }) });
  const deps = makeDeps({ prisma, writeAuditLog: (_d, p) => audits.push(p) });
  const res = makeRes();
  await ssoSamlCallbackHandler(
    { params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } },
    res,
    deps,
  );
  assert.equal(res._status, 403);
  assert.equal(res._body.error, 'sso_provisioning_denied');
  const denied = audits.find((a) => a.action === 'sso_login_denied');
  assert.ok(denied);
  assert.equal(denied.metadata.reason, 'no_pending_invite');
});

test('jit_require_invite — accepts pending invitation + auto-marks accepted', async () => {
  const audits = [];
  const inv = {
    id: 'inv-1',
    orgId: 'org1',
    email: 'alice@acme.com',
    acceptedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
  };
  const prisma = makePrisma({
    org: makeOrg({ provisioning: 'jit_require_invite' }),
    invitations: [inv],
  });
  const deps = makeDeps({ prisma, writeAuditLog: (_d, p) => audits.push(p) });
  const res = makeRes();
  await ssoSamlCallbackHandler(
    { params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } },
    res,
    deps,
  );
  assert.equal(res._status, 200);
  assert.equal(res._body.policy, 'jit_require_invite');
  assert.ok(inv.acceptedAt instanceof Date, 'invitation should be auto-accepted');
  assert.equal(prisma._identities.length, 1);
  const success = audits.find((a) => a.action === 'sso_login_success');
  assert.ok(success);
  assert.equal(success.metadata.invitationAccepted, 'inv-1');
});

test('SSOIdentity — re-login reuses row + refreshes lastUsedAt', async () => {
  const existing = { id: 'u-exist', email: 'alice@acme.com', name: 'Alice', isAdmin: false };
  const original = new Date(Date.now() - 60_000);
  const prisma = makePrisma({
    org: makeOrg(),
    user: existing,
    memberships: [{ orgId: 'org1', userId: 'u-exist', role: 'MEMBER' }],
    identities: [{
      id: 'ssoi-existing',
      userId: 'u-exist',
      orgId: 'org1',
      provider: 'saml',
      externalId: 'saml-nameid-alice',
      createdAt: original,
      lastUsedAt: original,
    }],
  });
  const deps = makeDeps({ prisma });
  const res = makeRes();
  await ssoSamlCallbackHandler(
    { params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } },
    res,
    deps,
  );
  assert.equal(res._status, 200);
  assert.equal(prisma._identities.length, 1, 'no duplicate identity created');
  assert.ok(prisma._identities[0].lastUsedAt > original, 'lastUsedAt refreshed');
});

test('OIDC provider — identity row uses provider="oidc" + sub as externalId', async () => {
  const oidcOrg = {
    id: 'org-oidc',
    slug: 'acme-oidc',
    ssoEnabled: true,
    ssoConfig: {
      provider: 'oidc',
      issuer: 'https://issuer',
      clientId: 'c',
      clientSecret: 's',
      callbackUrl: 'https://x/cb',
    },
  };
  const prisma = makePrisma({ org: oidcOrg });
  const deps = {
    prisma,
    writeAuditLog: () => {},
    resolveOrgForSso: async (slug) => (slug === oidcOrg.slug ? oidcOrg : null),
    oidcHandler: {
      verifyOidcCode: async () => ({
        ok: true,
        email: 'alice@acme.com',
        displayName: 'Alice',
        nameId: 'sub-oidc-123',
        profile: {},
      }),
    },
    samlHandler: {
      verifySamlResponse: async () => { throw new Error('should not be called'); },
    },
  };
  const res = makeRes();
  await ssoSamlCallbackHandler(
    { params: { orgSlug: 'acme-oidc' }, query: { code: 'abc' }, body: {} },
    res,
    deps,
  );
  assert.equal(res._status, 200);
  assert.equal(prisma._identities.length, 1);
  assert.equal(prisma._identities[0].provider, 'oidc');
  assert.equal(prisma._identities[0].externalId, 'sub-oidc-123');
});

test('unknown provisioning value falls back to jit_create', async () => {
  const prisma = makePrisma({ org: makeOrg({ provisioning: 'bogus-value' }) });
  const deps = makeDeps({ prisma });
  const res = makeRes();
  await ssoSamlCallbackHandler(
    { params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } },
    res,
    deps,
  );
  assert.equal(res._status, 200);
  assert.equal(res._body.policy, 'jit_create');
});

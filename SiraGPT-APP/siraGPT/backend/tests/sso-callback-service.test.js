'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SsoCallbackService } = require('../src/services/SsoCallbackService');

const silentLogger = { error: () => {}, warn: () => {}, log: () => {} };

function makeRes() {
  let _status = 200;
  let _body;
  return {
    status(c) { _status = c; return this; },
    json(p) { _body = p; return this; },
    get _status() { return _status },
    get _body() { return _body },
  };
}

function makePrisma(extra = {}) {
  return {
    user: {
      findUnique: async () => null,
      create: async ({ data }) => ({ id: 'u-new', ...data }),
      ...(extra.user || {}),
    },
    session: { create: async () => ({}) },
    orgMembership: {
      findUnique: async () => null,
      upsert: async () => ({}),
      ...(extra.orgMembership || {}),
    },
    orgInvitation: extra.orgInvitation,
    sSOIdentity: extra.sSOIdentity,
    organization: { findUnique: async () => null },
  };
}

const fixedOrg = {
  id: 'org1', slug: 'acme', ssoEnabled: true,
  ssoConfig: { provider: 'saml', cert: 'X' },
};

function makeSvc(over = {}) {
  return new SsoCallbackService({
    prisma: over.prisma || makePrisma(),
    audit: over.audit || (() => {}),
    samlHandler: over.samlHandler || { verifySamlResponse: async () => ({ ok: true, email: 'a@x.com', displayName: 'A', nameId: 'sub-1' }) },
    oidcHandler: over.oidcHandler || { verifyOidcCode: async () => ({ ok: true, email: 'a@x.com', displayName: 'A', nameId: 'sub-1' }) },
    resolveOrg: over.resolveOrg || (async () => fixedOrg),
    signSessionToken: over.signSessionToken || (() => 'TOKEN'),
    hashPassword: over.hashPassword || (async () => 'HASH'),
    now: over.now || (() => new Date('2026-01-01T00:00:00Z')),
    logger: silentLogger,
  });
}

test('SsoCallbackService: constructor enforces all dependencies', () => {
  assert.throws(() => new SsoCallbackService({}), /prisma is required/);
  assert.throws(
    () => new SsoCallbackService({ prisma: {}, audit: () => {}, samlHandler: {}, oidcHandler: { verifyOidcCode: () => {} }, resolveOrg: () => {}, signSessionToken: () => {} }),
    /samlHandler.verifySamlResponse is required/
  );
});

test('handle: 404 when resolveOrg returns null', async () => {
  const svc = makeSvc({ resolveOrg: async () => null });
  const res = makeRes();
  await svc.handle({ params: { orgSlug: 'nope' }, body: { SAMLResponse: 'x' } }, res);
  assert.equal(res._status, 404);
});

test('handle: 400 when SSO disabled', async () => {
  const svc = makeSvc({ resolveOrg: async () => ({ ...fixedOrg, ssoEnabled: false }) });
  const res = makeRes();
  await svc.handle({ params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } }, res);
  assert.equal(res._status, 400);
});

test('handle: defaults provisioning policy to jit_create on typo, audits attempt with normalised policy', async () => {
  const audits = [];
  const svc = makeSvc({
    audit: (_db, p) => audits.push(p),
    resolveOrg: async () => ({ ...fixedOrg, ssoConfig: { ...fixedOrg.ssoConfig, provisioning: 'BoGuS' } }),
  });
  const res = makeRes();
  await svc.handle({ params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } }, res);
  const attempt = audits.find((a) => a.action === 'sso_login_attempt');
  assert.equal(attempt.metadata.policy, 'jit_create');
});

test('handle: maps verifier failure to its status + error shape', async () => {
  const svc = makeSvc({
    samlHandler: { verifySamlResponse: async () => ({ ok: false, status: 403, error: 'bad_sig', hint: 'h' }) },
  });
  const res = makeRes();
  await svc.handle({ params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } }, res);
  assert.equal(res._status, 403);
  assert.deepEqual(res._body, { ok: false, error: 'bad_sig', hint: 'h', orgSlug: 'acme' });
});

test('handle: manual policy denies non-member with audit + 403', async () => {
  const audits = [];
  const existing = { id: 'u1', email: 'a@x.com', name: 'A', isAdmin: false };
  const svc = makeSvc({
    audit: (_db, p) => audits.push(p),
    prisma: makePrisma({ user: { findUnique: async () => existing } }),
    resolveOrg: async () => ({ ...fixedOrg, ssoConfig: { ...fixedOrg.ssoConfig, provisioning: 'manual' } }),
  });
  const res = makeRes();
  await svc.handle({ params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } }, res);
  assert.equal(res._status, 403);
  assert.equal(res._body.error, 'sso_provisioning_denied');
  const denied = audits.find((a) => a.action === 'sso_login_denied');
  assert.equal(denied.metadata.reason, 'not_a_member');
});

test('handle: jit_require_invite accepts pending invite, marks acceptedAt with injected clock', async () => {
  const NOW = new Date('2026-05-22T00:00:00Z');
  const audits = [];
  const inv = { id: 'inv-1', orgId: 'org1', email: 'a@x.com', acceptedAt: null, expiresAt: new Date('2026-12-31T00:00:00Z') };
  const updateCalls = [];
  const svc = makeSvc({
    audit: (_db, p) => audits.push(p),
    now: () => NOW,
    prisma: makePrisma({
      orgInvitation: {
        findFirst: async ({ where }) => (where.expiresAt.gt.getTime() === NOW.getTime() ? inv : null),
        update: async ({ where, data }) => { updateCalls.push({ where, data }); return inv; },
      },
    }),
    resolveOrg: async () => ({ ...fixedOrg, ssoConfig: { ...fixedOrg.ssoConfig, provisioning: 'jit_require_invite' } }),
  });
  const res = makeRes();
  await svc.handle({ params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } }, res);
  assert.equal(res._status, 200);
  assert.equal(updateCalls[0].where.id, 'inv-1');
  assert.equal(updateCalls[0].data.acceptedAt.getTime(), NOW.getTime());
  const success = audits.find((a) => a.action === 'sso_login_success');
  assert.equal(success.metadata.invitationAccepted, 'inv-1');
});

test('handle: links SSOIdentity by (provider, externalId) — create when missing, update lastUsedAt when existing', async () => {
  const NOW = new Date('2026-05-22T00:00:00Z');
  const createCalls = [];
  const updateCalls = [];

  // First call: no existing identity → create
  let svc = makeSvc({
    now: () => NOW,
    prisma: makePrisma({
      sSOIdentity: {
        findUnique: async () => null,
        create: async ({ data }) => { createCalls.push(data); return { id: 'idn-1' }; },
      },
    }),
  });
  let res = makeRes();
  await svc.handle({ params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } }, res);
  assert.equal(res._status, 200);
  assert.equal(createCalls[0].provider, 'saml');
  assert.equal(createCalls[0].externalId, 'sub-1');

  // Second call: existing → update lastUsedAt with injected clock
  svc = makeSvc({
    now: () => NOW,
    prisma: makePrisma({
      sSOIdentity: {
        findUnique: async () => ({ id: 'idn-1' }),
        update: async ({ where, data }) => { updateCalls.push({ where, data }); return {}; },
      },
    }),
  });
  res = makeRes();
  await svc.handle({ params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } }, res);
  assert.equal(updateCalls[0].where.id, 'idn-1');
  assert.equal(updateCalls[0].data.lastUsedAt.getTime(), NOW.getTime());
});

test('handle: catches downstream errors and returns 500 sso_login_failed (audit failure never bubbles)', async () => {
  const svc = makeSvc({
    prisma: makePrisma({
      user: { findUnique: async () => { throw new Error('db dead'); } },
    }),
  });
  const res = makeRes();
  await svc.handle({ params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } }, res);
  assert.equal(res._status, 500);
  assert.deepEqual(res._body, { ok: false, error: 'sso_login_failed' });
});

test('handle: OIDC branch dispatches to oidcHandler, reads code from query and from body', async () => {
  const oidcCalls = [];
  const oidc = { verifyOidcCode: async (code) => { oidcCalls.push(code); return { ok: true, email: 'a@x.com', displayName: 'A', nameId: 's' }; } };
  const svc = makeSvc({
    oidcHandler: oidc,
    resolveOrg: async () => ({ ...fixedOrg, ssoConfig: { provider: 'oidc' } }),
  });

  let res = makeRes();
  await svc.handle({ params: { orgSlug: 'acme' }, query: { code: 'Q-CODE' }, body: {} }, res);
  assert.equal(res._status, 200);
  assert.equal(oidcCalls[0], 'Q-CODE');

  res = makeRes();
  await svc.handle({ params: { orgSlug: 'acme' }, query: {}, body: { code: 'B-CODE' } }, res);
  assert.equal(oidcCalls[1], 'B-CODE');
});

test('handle: success body shape matches legacy contract (ok, token, user{id,email,name}, orgSlug, createdUser, policy)', async () => {
  const svc = makeSvc();
  const res = makeRes();
  await svc.handle({ params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } }, res);
  assert.equal(res._status, 200);
  assert.deepEqual(Object.keys(res._body).sort(), ['createdUser', 'ok', 'orgSlug', 'policy', 'token', 'user'].sort());
  assert.deepEqual(Object.keys(res._body.user).sort(), ['email', 'id', 'name'].sort());
  assert.equal(res._body.ok, true);
  assert.equal(res._body.policy, 'jit_create');
});

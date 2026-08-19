'use strict';

/**
 * Ratchet 45 — POST /api/auth/sso/:orgSlug/callback handler tests.
 *
 * Exercises the route-level SAML response handler with the saml-handler
 * service stubbed via deps so we don't need @node-saml/node-saml. We
 * also stub prisma + writeAuditLog so no DB is required.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub JWT_SECRET so signSessionToken doesn't refuse to mint.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-saml-callback';

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

const validOrg = {
  id: 'org1',
  slug: 'acme',
  ssoEnabled: true,
  ssoConfig: {
    provider: 'saml',
    entryPoint: 'https://idp/sso',
    issuer: 'sp',
    callbackUrl: 'https://x/cb',
    cert: 'CERT',
  },
};

function makePrisma({ user = null, orgs = { acme: validOrg } } = {}) {
  return {
    user: {
      findUnique: async ({ where }) => (user && where.email === user.email ? user : null),
      create: async ({ data }) => ({ id: 'u-new', ...data }),
    },
    session: { create: async () => ({}) },
    organization: {
      findUnique: async ({ where }) => orgs[where.slug] || null,
    },
    orgMembership: { upsert: async () => ({}) },
  };
}

function makeDeps(overrides = {}) {
  const prisma = overrides.prisma || makePrisma();
  return {
    prisma,
    writeAuditLog: overrides.writeAuditLog || (() => {}),
    resolveOrgForSso: async (slug) => prisma.organization.findUnique({ where: { slug } }),
    samlHandler: overrides.samlHandler,
  };
}

test('POST callback 404 when org not found', async () => {
  const deps = makeDeps({ prisma: makePrisma({ orgs: {} }) });
  const res = makeRes();
  await ssoSamlCallbackHandler(
    { params: { orgSlug: 'nope' }, body: { SAMLResponse: 'x' } },
    res,
    deps,
  );
  assert.equal(res._status, 404);
});

test('POST callback 400 when SSO disabled', async () => {
  const deps = makeDeps({
    prisma: makePrisma({ orgs: { acme: { ...validOrg, ssoEnabled: false } } }),
  });
  const res = makeRes();
  await ssoSamlCallbackHandler(
    { params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } },
    res,
    deps,
  );
  assert.equal(res._status, 400);
});

test('POST callback returns 501 when SAML lib missing', async () => {
  const audits = [];
  const deps = makeDeps({
    writeAuditLog: (_db, p) => audits.push(p),
    samlHandler: {
      verifySamlResponse: async () => ({
        ok: false, status: 501, error: 'saml_lib_missing',
      }),
    },
  });
  const res = makeRes();
  await ssoSamlCallbackHandler(
    { params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } },
    res,
    deps,
  );
  assert.equal(res._status, 501);
  assert.equal(res._body.error, 'saml_lib_missing');
  // attempt audit fired even though verification failed
  assert.ok(audits.some((a) => a.action === 'sso_login_attempt'));
  assert.ok(!audits.some((a) => a.action === 'sso_login_success'));
});

test('POST callback creates user + mints session on success', async () => {
  const audits = [];
  const deps = makeDeps({
    writeAuditLog: (_db, p) => audits.push(p),
    samlHandler: {
      verifySamlResponse: async () => ({
        ok: true,
        email: 'new@acme.com',
        displayName: 'New User',
        nameId: 'new',
        profile: {},
      }),
    },
  });
  const res = makeRes();
  await ssoSamlCallbackHandler(
    { params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } },
    res,
    deps,
  );
  assert.equal(res._status, 200);
  assert.equal(res._body.ok, true);
  assert.ok(res._body.token);
  assert.equal(res._body.createdUser, true);
  assert.equal(res._body.user.email, 'new@acme.com');
  assert.ok(audits.some((a) => a.action === 'sso_login_attempt'));
  assert.ok(audits.some((a) => a.action === 'sso_login_success'));
});

test('POST callback returns existing user without recreate', async () => {
  const existing = { id: 'u-exist', email: 'existing@acme.com', name: 'E', isAdmin: false };
  const prisma = makePrisma({ user: existing });
  const deps = makeDeps({
    prisma,
    samlHandler: {
      verifySamlResponse: async () => ({
        ok: true, email: 'existing@acme.com', displayName: 'E', nameId: null, profile: {},
      }),
    },
  });
  const res = makeRes();
  await ssoSamlCallbackHandler(
    { params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } },
    res,
    deps,
  );
  assert.equal(res._status, 200);
  assert.equal(res._body.createdUser, false);
  assert.equal(res._body.user.id, 'u-exist');
});

test('POST callback 401 on bad SAML response', async () => {
  const deps = makeDeps({
    samlHandler: {
      verifySamlResponse: async () => ({
        ok: false, status: 401, error: 'saml_response_invalid', hint: 'bad sig',
      }),
    },
  });
  const res = makeRes();
  await ssoSamlCallbackHandler(
    { params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } },
    res,
    deps,
  );
  assert.equal(res._status, 401);
  assert.equal(res._body.error, 'saml_response_invalid');
});

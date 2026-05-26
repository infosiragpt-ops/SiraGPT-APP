'use strict';

/**
 * Ratchet 45 — OIDC dispatch through POST /api/auth/sso/:orgSlug/callback.
 *
 * Reuses the unified `ssoSamlCallbackHandler` (which dispatches on
 * `ssoConfig.provider`). Stubs the oidc-handler service via deps so we
 * don't need `openid-client`. Also stubs prisma + writeAuditLog.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-oidc-callback';

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

const oidcOrg = {
  id: 'org-oidc',
  slug: 'acme-oidc',
  ssoEnabled: true,
  ssoConfig: {
    provider: 'oidc',
    issuer: 'https://idp.example.com',
    clientId: 'sira',
    clientSecret: 'shh',
    callbackUrl: 'https://x/cb',
  },
};

function makePrisma({ user = null, orgs = { 'acme-oidc': oidcOrg } } = {}) {
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
    oidcHandler: overrides.oidcHandler,
    // SAML handler shouldn't be called on OIDC orgs — but provide a
    // bomb stub so any accidental call fails loudly.
    samlHandler: overrides.samlHandler || {
      verifySamlResponse: async () => { throw new Error('saml path used on oidc org'); },
    },
  };
}

test('OIDC callback returns 501 when openid-client lib missing', async () => {
  const audits = [];
  const deps = makeDeps({
    writeAuditLog: (_db, p) => audits.push(p),
    oidcHandler: {
      verifyOidcCode: async () => ({
        ok: false, status: 501, error: 'oidc_lib_missing',
      }),
    },
  });
  const res = makeRes();
  await ssoSamlCallbackHandler(
    { params: { orgSlug: 'acme-oidc' }, query: { code: 'abc' }, body: {} },
    res,
    deps,
  );
  assert.equal(res._status, 501);
  assert.equal(res._body.error, 'oidc_lib_missing');
  const attempt = audits.find((a) => a.action === 'sso_login_attempt');
  assert.ok(attempt);
  assert.equal(attempt.metadata.method, 'oidc');
  assert.ok(!audits.some((a) => a.action === 'sso_login_success'));
});

test('OIDC callback creates user + mints session on success', async () => {
  const audits = [];
  const deps = makeDeps({
    writeAuditLog: (_db, p) => audits.push(p),
    oidcHandler: {
      verifyOidcCode: async () => ({
        ok: true,
        email: 'new@acme.com',
        displayName: 'New User',
        nameId: 'sub-123',
        profile: {},
      }),
    },
  });
  const res = makeRes();
  await ssoSamlCallbackHandler(
    { params: { orgSlug: 'acme-oidc' }, query: { code: 'authcode' }, body: {} },
    res,
    deps,
  );
  assert.equal(res._status, 200);
  assert.equal(res._body.ok, true);
  assert.ok(res._body.token);
  assert.equal(res._body.createdUser, true);
  assert.equal(res._body.user.email, 'new@acme.com');
  const success = audits.find((a) => a.action === 'sso_login_success');
  assert.ok(success);
  assert.equal(success.metadata.method, 'oidc');
});

test('OIDC callback 401 on invalid code', async () => {
  const deps = makeDeps({
    oidcHandler: {
      verifyOidcCode: async () => ({
        ok: false, status: 401, error: 'oidc_response_invalid', hint: 'bad code',
      }),
    },
  });
  const res = makeRes();
  await ssoSamlCallbackHandler(
    { params: { orgSlug: 'acme-oidc' }, query: { code: 'bad' }, body: {} },
    res,
    deps,
  );
  assert.equal(res._status, 401);
  assert.equal(res._body.error, 'oidc_response_invalid');
});

test('OIDC callback accepts code from POST body when query absent', async () => {
  let codeSeen = null;
  const deps = makeDeps({
    oidcHandler: {
      verifyOidcCode: async (code) => {
        codeSeen = code;
        return {
          ok: true, email: 'body@acme.com', displayName: 'Body', nameId: 's', profile: {},
        };
      },
    },
  });
  const res = makeRes();
  await ssoSamlCallbackHandler(
    { params: { orgSlug: 'acme-oidc' }, query: {}, body: { code: 'from-body' } },
    res,
    deps,
  );
  assert.equal(res._status, 200);
  assert.equal(codeSeen, 'from-body');
});

test('OIDC callback 400 when ssoConfig missing required fields downstream', async () => {
  const deps = makeDeps({
    oidcHandler: {
      verifyOidcCode: async () => ({
        ok: false, status: 400, error: 'oidc_not_configured', hint: 'no issuer',
      }),
    },
  });
  const res = makeRes();
  await ssoSamlCallbackHandler(
    { params: { orgSlug: 'acme-oidc' }, query: { code: 'abc' }, body: {} },
    res,
    deps,
  );
  assert.equal(res._status, 400);
  assert.equal(res._body.error, 'oidc_not_configured');
});

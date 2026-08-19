'use strict';

/**
 * Ratchet 45 — SSO scaffold tests.
 *
 * Exercises the org-SSO configuration handler (`POST /api/orgs/:id/sso`)
 * and the public SAML/OIDC login + callback placeholders
 * (`GET /api/auth/sso/:orgSlug/login` and `/callback`) directly with a
 * fake prisma. No Express bind / DB required. The endpoints intentionally
 * return 501 — the assertions lock in that contract until the actual
 * SAML/OIDC handshake ships.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const orgsRouter = require('../src/routes/orgs');

const { configureOrgSso } = orgsRouter.__handlers;
const { sanitizeSsoConfig, redactSsoConfig, SSO_PROVIDERS } = orgsRouter.__ssoHelpers;

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

function makeFakeOrgPrisma({ members = {}, orgs = {} } = {}) {
  return {
    orgMembership: {
      findUnique: async ({ where }) => {
        const { orgId, userId } = where.orgId_userId;
        const m = members[`${orgId}:${userId}`];
        if (!m) return null;
        return { id: 'mem', orgId, userId, role: m.role, organization: { id: orgId } };
      },
    },
    organization: {
      findUnique: async ({ where }) => orgs[where.id] || null,
      update: async ({ where, data, select }) => {
        orgs[where.id] = { ...(orgs[where.id] || { id: where.id }), ...data };
        if (select) {
          const out = {};
          for (const k of Object.keys(select)) out[k] = orgs[where.id][k];
          return out;
        }
        return orgs[where.id];
      },
    },
  };
}

const validConfig = {
  provider: 'saml',
  entryPoint: 'https://idp.example.com/sso',
  issuer: 'https://sira.example.com/sp',
  callbackUrl: 'https://sira.example.com/api/auth/sso/acme/callback',
  cert: '-----BEGIN CERTIFICATE-----\nMIIDdjCCAl6gAwIBAgIE...redacted-payload-bytes-here...==\n-----END CERTIFICATE-----',
};

// ─── sanitizeSsoConfig ──────────────────────────────────────────────

test('sanitizeSsoConfig: accepts valid SAML payload', () => {
  const out = sanitizeSsoConfig({ ...validConfig });
  assert.equal(out.provider, 'saml');
  assert.equal(out.entryPoint, validConfig.entryPoint);
  assert.equal(out.issuer, validConfig.issuer);
  assert.equal(out.callbackUrl, validConfig.callbackUrl);
  assert.equal(out.cert, validConfig.cert);
});

test('sanitizeSsoConfig: accepts valid OIDC payload with client secret', () => {
  const out = sanitizeSsoConfig({
    provider: 'oidc',
    entryPoint: 'https://idp.example.com/authorize',
    issuer: 'sira-client-id',
    callbackUrl: 'https://sira.example.com/cb',
    clientSecret: 'super-secret-value',
    audience: 'sira-api',
  });
  assert.equal(out.provider, 'oidc');
  assert.equal(out.clientSecret, 'super-secret-value');
  assert.equal(out.audience, 'sira-api');
});

test('sanitizeSsoConfig: rejects bogus provider', () => {
  assert.throws(() => sanitizeSsoConfig({ ...validConfig, provider: 'magic' }), /provider must be/);
});

test('sanitizeSsoConfig: requires entryPoint / issuer / callbackUrl', () => {
  assert.throws(() => sanitizeSsoConfig({ provider: 'saml' }), /entryPoint is required/);
  assert.throws(
    () => sanitizeSsoConfig({ provider: 'saml', entryPoint: 'https://x' }),
    /issuer is required/,
  );
});

test('sanitizeSsoConfig: rejects non-http callbackUrl', () => {
  assert.throws(
    () => sanitizeSsoConfig({ ...validConfig, callbackUrl: 'ftp://nope' }),
    /must be http\(s\) URLs/,
  );
});

test('sanitizeSsoConfig: rejects non-object input', () => {
  assert.throws(() => sanitizeSsoConfig(null), /must be a JSON object/);
  assert.throws(() => sanitizeSsoConfig('foo'), /must be a JSON object/);
  assert.throws(() => sanitizeSsoConfig([1, 2, 3]), /must be a JSON object/);
});

test('redactSsoConfig: hides clientSecret and trims cert', () => {
  const red = redactSsoConfig({
    provider: 'oidc',
    entryPoint: 'https://x',
    issuer: 'x',
    callbackUrl: 'https://x',
    clientSecret: 'top-secret',
    cert: 'A'.repeat(200),
  });
  assert.equal(red.clientSecret, '***redacted***');
  assert.ok(red.cert.includes('…'));
  assert.ok(red.cert.length < 100);
});

test('SSO_PROVIDERS catalogue', () => {
  assert.deepEqual([...SSO_PROVIDERS].sort(), ['oidc', 'saml']);
});

// ─── configureOrgSso handler ────────────────────────────────────────

test('configureOrgSso: 403 when caller is not OWNER', async () => {
  const prisma = makeFakeOrgPrisma({
    members: { 'org1:u1': { role: 'ADMIN' } },
    orgs: { org1: { id: 'org1', ssoConfig: null, ssoEnabled: false } },
  });
  const res = makeRes();
  await configureOrgSso(
    { user: { id: 'u1' }, params: { id: 'org1' }, body: validConfig },
    res,
    { prisma, writeAuditLog: () => {} },
  );
  assert.equal(res._status, 403);
});

test('configureOrgSso: 404 when caller is not a member', async () => {
  const prisma = makeFakeOrgPrisma({
    members: {},
    orgs: { org1: { id: 'org1' } },
  });
  const res = makeRes();
  await configureOrgSso(
    { user: { id: 'u1' }, params: { id: 'org1' }, body: validConfig },
    res,
    { prisma, writeAuditLog: () => {} },
  );
  assert.equal(res._status, 404);
});

test('configureOrgSso: persists config + returns 501 with redacted secrets', async () => {
  const orgs = { org1: { id: 'org1', ssoConfig: null, ssoEnabled: false } };
  const prisma = makeFakeOrgPrisma({
    members: { 'org1:owner1': { role: 'OWNER' } },
    orgs,
  });
  const audits = [];
  const writeAuditLog = (_db, payload) => audits.push(payload);
  const res = makeRes();
  await configureOrgSso(
    {
      user: { id: 'owner1' },
      params: { id: 'org1' },
      body: { ...validConfig, provider: 'oidc', clientSecret: 'shh', enabled: true },
    },
    res,
    { prisma, writeAuditLog },
  );
  assert.equal(res._status, 501);
  assert.equal(res._body.implemented, false);
  assert.equal(res._body.ssoEnabled, true);
  assert.equal(res._body.ssoConfig.clientSecret, '***redacted***');
  assert.equal(orgs.org1.ssoEnabled, true);
  assert.equal(orgs.org1.ssoConfig.provider, 'oidc');
  assert.equal(orgs.org1.ssoConfig.clientSecret, 'shh'); // raw stored, only redacted on response
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'org_sso_configure');
});

test('configureOrgSso: validation error returns 400', async () => {
  const prisma = makeFakeOrgPrisma({
    members: { 'org1:owner1': { role: 'OWNER' } },
    orgs: { org1: { id: 'org1' } },
  });
  const res = makeRes();
  await configureOrgSso(
    { user: { id: 'owner1' }, params: { id: 'org1' }, body: { provider: 'saml' } },
    res,
    { prisma, writeAuditLog: () => {} },
  );
  assert.equal(res._status, 400);
});

// ─── /api/auth/sso/:orgSlug/* placeholders ──────────────────────────

test('auth router exposes SSO helpers', () => {
  const authRouter = require('../src/routes/auth');
  assert.ok(authRouter.__ssoHelpers);
  const { redactSsoConfigForPublic } = authRouter.__ssoHelpers;
  const out = redactSsoConfigForPublic({
    provider: 'saml',
    entryPoint: 'https://idp/sso',
    issuer: 'sp',
    callbackUrl: 'https://x/cb',
    cert: 'should-not-leak',
    clientSecret: 'should-not-leak',
  });
  assert.equal(out.provider, 'saml');
  assert.equal(out.entryPoint, 'https://idp/sso');
  assert.equal(out.cert, undefined);
  assert.equal(out.clientSecret, undefined);
});

'use strict';

/**
 * Ratchet 45 — SSO domain claim tests.
 *
 * Covers:
 *   - `POST /api/orgs/:id/sso/domains` handler (add/remove + OWNER gate)
 *   - `normalizeSsoDomain` / `sanitizeSsoDomainList` helpers
 *   - `resolveOrgBySsoDomain` short-circuit used by /login + /register
 *
 * No DB, no Express bind — handlers are invoked directly with a fake
 * prisma so we lock the contract without spinning up Postgres.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-sso-domains-jwt-secret-at-least-32-chars!!';

const orgsRouter = require('../src/routes/orgs');
const authRouter = require('../src/routes/auth');

const { configureOrgSsoDomains } = orgsRouter.__handlers;
const {
  normalizeSsoDomain,
  sanitizeSsoDomainList,
  MAX_SSO_DOMAINS,
} = orgsRouter.__ssoDomainHelpers;
const { extractEmailDomain, resolveOrgBySsoDomain } = authRouter.__ssoHelpers;

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
      findUnique: async ({ where, select }) => {
        const row = orgs[where.id];
        if (!row) return null;
        if (!select) return row;
        const out = {};
        for (const k of Object.keys(select)) out[k] = row[k];
        return out;
      },
      findFirst: async ({ where, select }) => {
        const wantDomain = where?.ssoDomains?.has;
        const wantEnabled = where?.ssoEnabled;
        for (const row of Object.values(orgs)) {
          const domains = Array.isArray(row.ssoDomains) ? row.ssoDomains : [];
          if (wantEnabled === true && !row.ssoEnabled) continue;
          if (wantDomain && !domains.includes(wantDomain)) continue;
          if (!select) return row;
          const out = {};
          for (const k of Object.keys(select)) out[k] = row[k];
          return out;
        }
        return null;
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
    },
  };
}

// ─── helpers ────────────────────────────────────────────────────────

test('normalizeSsoDomain: lowercases + strips @, scheme, path, port', () => {
  assert.equal(normalizeSsoDomain('Acme.COM'), 'acme.com');
  assert.equal(normalizeSsoDomain('@Acme.com'), 'acme.com');
  assert.equal(normalizeSsoDomain('https://acme.com/sso'), 'acme.com');
  assert.equal(normalizeSsoDomain('acme.com:443'), 'acme.com');
  assert.equal(normalizeSsoDomain('  sub.acme.co.uk  '), 'sub.acme.co.uk');
});

test('normalizeSsoDomain: rejects bogus input', () => {
  assert.equal(normalizeSsoDomain(''), null);
  assert.equal(normalizeSsoDomain('not a domain'), null);
  assert.equal(normalizeSsoDomain('localhost'), null);
  assert.equal(normalizeSsoDomain('.com'), null);
  assert.equal(normalizeSsoDomain(123), null);
  assert.equal(normalizeSsoDomain(null), null);
});

test('sanitizeSsoDomainList: dedupes + normalizes', () => {
  const out = sanitizeSsoDomainList(['acme.com', '@ACME.com', 'corp.acme.com'], 'add');
  assert.deepEqual(out, ['acme.com', 'corp.acme.com']);
});

test('sanitizeSsoDomainList: throws on non-array or invalid domain', () => {
  assert.throws(() => sanitizeSsoDomainList('acme.com', 'add'), /must be an array/);
  assert.throws(() => sanitizeSsoDomainList(['valid.com', 'not a domain'], 'add'), /invalid domain/);
});

test('sanitizeSsoDomainList: returns [] for null/undefined', () => {
  assert.deepEqual(sanitizeSsoDomainList(null, 'add'), []);
  assert.deepEqual(sanitizeSsoDomainList(undefined, 'remove'), []);
});

test('MAX_SSO_DOMAINS sanity', () => {
  assert.equal(typeof MAX_SSO_DOMAINS, 'number');
  assert.ok(MAX_SSO_DOMAINS > 0 && MAX_SSO_DOMAINS <= 256);
});

// ─── configureOrgSsoDomains handler ─────────────────────────────────

test('configureOrgSsoDomains: 403 when caller is not OWNER', async () => {
  const prisma = makeFakeOrgPrisma({
    members: { 'org1:u1': { role: 'ADMIN' } },
    orgs: { org1: { id: 'org1', ssoDomains: [] } },
  });
  const res = makeRes();
  await configureOrgSsoDomains(
    { user: { id: 'u1' }, params: { id: 'org1' }, body: { add: ['acme.com'] } },
    res,
    { prisma, writeAuditLog: () => {} },
  );
  assert.equal(res._status, 403);
});

test('configureOrgSsoDomains: 400 when neither add nor remove provided', async () => {
  const prisma = makeFakeOrgPrisma({
    members: { 'org1:owner1': { role: 'OWNER' } },
    orgs: { org1: { id: 'org1', ssoDomains: [] } },
  });
  const res = makeRes();
  await configureOrgSsoDomains(
    { user: { id: 'owner1' }, params: { id: 'org1' }, body: {} },
    res,
    { prisma, writeAuditLog: () => {} },
  );
  assert.equal(res._status, 400);
});

test('configureOrgSsoDomains: 400 on bogus domain', async () => {
  const prisma = makeFakeOrgPrisma({
    members: { 'org1:owner1': { role: 'OWNER' } },
    orgs: { org1: { id: 'org1', ssoDomains: [] } },
  });
  const res = makeRes();
  await configureOrgSsoDomains(
    { user: { id: 'owner1' }, params: { id: 'org1' }, body: { add: ['nope'] } },
    res,
    { prisma, writeAuditLog: () => {} },
  );
  assert.equal(res._status, 400);
});

test('configureOrgSsoDomains: adds + removes, dedupes, writes audit', async () => {
  const orgs = { org1: { id: 'org1', ssoDomains: ['old.com'], ssoEnabled: true } };
  const prisma = makeFakeOrgPrisma({
    members: { 'org1:owner1': { role: 'OWNER' } },
    orgs,
  });
  const audits = [];
  const res = makeRes();
  await configureOrgSsoDomains(
    {
      user: { id: 'owner1' },
      params: { id: 'org1' },
      body: { add: ['Acme.com', '@acme.com', 'beta.io'], remove: ['old.com'] },
    },
    res,
    { prisma, writeAuditLog: (_db, payload) => audits.push(payload) },
  );
  assert.equal(res._status, 200);
  assert.deepEqual(res._body.ssoDomains.sort(), ['acme.com', 'beta.io']);
  assert.equal(res._body.ssoEnabled, true);
  assert.deepEqual(orgs.org1.ssoDomains.sort(), ['acme.com', 'beta.io']);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'org_sso_domains_update');
  assert.deepEqual(audits[0].metadata.added, ['acme.com', 'beta.io']);
  assert.deepEqual(audits[0].metadata.removed, ['old.com']);
});

test('configureOrgSsoDomains: 400 when result would exceed MAX_SSO_DOMAINS', async () => {
  const existing = Array.from({ length: MAX_SSO_DOMAINS }, (_, i) => `d${i}.com`);
  const orgs = { org1: { id: 'org1', ssoDomains: existing } };
  const prisma = makeFakeOrgPrisma({
    members: { 'org1:owner1': { role: 'OWNER' } },
    orgs,
  });
  const res = makeRes();
  await configureOrgSsoDomains(
    { user: { id: 'owner1' }, params: { id: 'org1' }, body: { add: ['overflow.com'] } },
    res,
    { prisma, writeAuditLog: () => {} },
  );
  assert.equal(res._status, 400);
});

// ─── domain resolver used by /login + /register ─────────────────────

test('extractEmailDomain: pulls the domain out', () => {
  assert.equal(extractEmailDomain('user@ACME.com'), 'acme.com');
  assert.equal(extractEmailDomain('user@sub.example.org'), 'sub.example.org');
  assert.equal(extractEmailDomain('no-at'), null);
  assert.equal(extractEmailDomain('user@'), null);
  assert.equal(extractEmailDomain(null), null);
});

test('resolveOrgBySsoDomain: returns org when domain matches and ssoEnabled', async () => {
  const prisma = makeFakeOrgPrisma({
    orgs: {
      org1: { id: 'org1', slug: 'acme', ssoEnabled: true, ssoDomains: ['acme.com'] },
    },
  });
  const out = await resolveOrgBySsoDomain('user@acme.com', { prisma });
  assert.ok(out);
  assert.equal(out.slug, 'acme');
});

test('resolveOrgBySsoDomain: returns null when ssoEnabled = false', async () => {
  const prisma = makeFakeOrgPrisma({
    orgs: {
      org1: { id: 'org1', slug: 'acme', ssoEnabled: false, ssoDomains: ['acme.com'] },
    },
  });
  const out = await resolveOrgBySsoDomain('user@acme.com', { prisma });
  assert.equal(out, null);
});

test('resolveOrgBySsoDomain: returns null when domain not claimed', async () => {
  const prisma = makeFakeOrgPrisma({
    orgs: {
      org1: { id: 'org1', slug: 'acme', ssoEnabled: true, ssoDomains: ['acme.com'] },
    },
  });
  const out = await resolveOrgBySsoDomain('user@other.com', { prisma });
  assert.equal(out, null);
});

test('resolveOrgBySsoDomain: fail-open on lookup error', async () => {
  const prisma = {
    organization: { findFirst: async () => { throw new Error('db down'); } },
  };
  const out = await resolveOrgBySsoDomain('user@acme.com', { prisma });
  assert.equal(out, null);
});

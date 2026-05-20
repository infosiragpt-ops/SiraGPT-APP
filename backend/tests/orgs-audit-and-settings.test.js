'use strict';

/**
 * Cycle 66 — tests for the org-scoped audit-log feed + per-org
 * settings endpoints. Exercises handler functions directly with a fake
 * prisma; no Express bind / DB required.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const orgsRouter = require('../src/routes/orgs');

const {
  listOrgAuditLogs,
  listMemberActivity,
  getOrgSettings,
  patchOrgSettings,
  postOrgSecurity,
} = orgsRouter.__handlers;
const { sanitizeSettings, mergeSettings } = orgsRouter.__settingsHelpers;
const { parseOrgSettingsPatch } = require('../src/schemas/orgs');

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

function makeFakePrisma({ members = {}, orgs = {}, auditRows = [] } = {}) {
  const audits = [];
  const writeAuditLog = (_db, payload) => { audits.push(payload); };

  const orgMembership = {
    findUnique: async ({ where }) => {
      const { orgId, userId } = where.orgId_userId;
      const m = members[`${orgId}:${userId}`];
      if (!m) return null;
      return { id: `mem`, orgId, userId, role: m.role, organization: { id: orgId } };
    },
  };
  const organization = {
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
  };
  // Minimal AuditLog mock — captures the `where` clause used and
  // returns rows that satisfy it so we can assert byOrg filter is set.
  const auditCalls = [];
  const auditLog = {
    findMany: async ({ where, skip, take }) => {
      auditCalls.push({ where, skip, take });
      return auditRows.filter((r) => {
        if (where.metadata?.path?.[0] === 'orgId') {
          if (!r.metadata || r.metadata.orgId !== where.metadata.equals) return false;
        }
        if (where.action && r.action !== where.action) return false;
        if (where.actorId && r.actorId !== where.actorId) return false;
        return true;
      }).slice(skip || 0, (skip || 0) + (take || 100));
    },
    count: async ({ where }) => {
      return auditRows.filter((r) => {
        if (where.metadata?.path?.[0] === 'orgId') {
          if (!r.metadata || r.metadata.orgId !== where.metadata.equals) return false;
        }
        if (where.action && r.action !== where.action) return false;
        return true;
      }).length;
    },
  };

  return {
    prisma: { orgMembership, organization, auditLog, _auditCalls: auditCalls, _orgs: orgs },
    writeAuditLog,
    audits,
  };
}

// ─── listOrgAuditLogs ───────────────────────────────────────────────

test('audit-logs: ADMIN can list, byOrg filter is forced on prisma where', async () => {
  const { prisma } = makeFakePrisma({
    members: { 'o1:admin1': { role: 'ADMIN' } },
    auditRows: [
      { id: 'a1', action: 'org_create', metadata: { orgId: 'o1' } },
      { id: 'a2', action: 'org_invite_create', metadata: { orgId: 'o1' } },
      { id: 'a3', action: 'org_create', metadata: { orgId: 'o2' } },
    ],
  });
  const req = { user: { id: 'admin1' }, params: { id: 'o1' }, query: {} };
  const res = makeRes();
  await listOrgAuditLogs(req, res, { prisma });
  assert.equal(res._status, 200);
  assert.equal(res._body.total, 2);
  assert.equal(res._body.items.length, 2);
  // byOrg must be enforced regardless of query params.
  const call = prisma._auditCalls[0];
  assert.deepEqual(call.where.metadata, { path: ['orgId'], equals: 'o1' });
});

test('audit-logs: rejects MEMBER (403)', async () => {
  const { prisma } = makeFakePrisma({
    members: { 'o1:member1': { role: 'MEMBER' } },
  });
  const req = { user: { id: 'member1' }, params: { id: 'o1' }, query: {} };
  const res = makeRes();
  await listOrgAuditLogs(req, res, { prisma });
  assert.equal(res._status, 403);
});

test('audit-logs: non-member returns 404', async () => {
  const { prisma } = makeFakePrisma({ members: {} });
  const req = { user: { id: 'ghost' }, params: { id: 'o1' }, query: {} };
  const res = makeRes();
  await listOrgAuditLogs(req, res, { prisma });
  assert.equal(res._status, 404);
});

test('audit-logs: caller cannot escape org by passing another orgId in query', async () => {
  const { prisma } = makeFakePrisma({
    members: { 'o1:admin1': { role: 'ADMIN' } },
    auditRows: [
      { id: 'a1', action: 'x', metadata: { orgId: 'o1' } },
      { id: 'a2', action: 'x', metadata: { orgId: 'o2' } },
    ],
  });
  // orgId query param is ignored — byOrg is bound to path param.
  const req = { user: { id: 'admin1' }, params: { id: 'o1' }, query: { orgId: 'o2' } };
  const res = makeRes();
  await listOrgAuditLogs(req, res, { prisma });
  assert.equal(res._status, 200);
  assert.equal(prisma._auditCalls[0].where.metadata.equals, 'o1');
});

test('audit-logs: action + page + limit filters honored', async () => {
  const { prisma } = makeFakePrisma({
    members: { 'o1:owner1': { role: 'OWNER' } },
    auditRows: Array.from({ length: 7 }, (_, i) => ({
      id: `a${i}`,
      action: 'org_invite_create',
      metadata: { orgId: 'o1' },
    })),
  });
  const req = {
    user: { id: 'owner1' },
    params: { id: 'o1' },
    query: { action: 'org_invite_create', page: '2', limit: '3' },
  };
  const res = makeRes();
  await listOrgAuditLogs(req, res, { prisma });
  assert.equal(res._status, 200);
  assert.equal(res._body.page, 2);
  assert.equal(res._body.limit, 3);
  assert.equal(res._body.total, 7);
  assert.equal(res._body.items.length, 3);
});

// ─── settings helpers ───────────────────────────────────────────────

test('sanitizeSettings: rejects arrays + primitives, accepts plain objects', () => {
  assert.deepEqual(sanitizeSettings({}), {});
  assert.deepEqual(sanitizeSettings({ a: 1 }), { a: 1 });
  assert.deepEqual(sanitizeSettings(null), {});
  assert.deepEqual(sanitizeSettings(undefined), {});
  assert.equal(sanitizeSettings([1, 2]), null);
  assert.equal(sanitizeSettings('hello'), null);
  assert.equal(sanitizeSettings(42), null);
});

test('mergeSettings: shallow merge, null removes keys', () => {
  assert.deepEqual(mergeSettings({ a: 1, b: 2 }, { b: 3, c: 4 }), { a: 1, b: 3, c: 4 });
  assert.deepEqual(mergeSettings({ a: 1, b: 2 }, { a: null }), { b: 2 });
  assert.deepEqual(mergeSettings(null, { a: 1 }), { a: 1 });
});

// ─── GET settings ───────────────────────────────────────────────────

test('get settings: VIEWER allowed, returns empty object when null', async () => {
  const { prisma } = makeFakePrisma({
    members: { 'o1:v1': { role: 'VIEWER' } },
    orgs: { o1: { id: 'o1', settings: null } },
  });
  const req = { user: { id: 'v1' }, params: { id: 'o1' } };
  const res = makeRes();
  await getOrgSettings(req, res, { prisma });
  assert.equal(res._status, 200);
  assert.deepEqual(res._body.settings, {});
});

test('get settings: returns stored object', async () => {
  const { prisma } = makeFakePrisma({
    members: { 'o1:v1': { role: 'VIEWER' } },
    orgs: { o1: { id: 'o1', settings: { defaultModel: 'opus-4-7', brand: { color: '#0af' } } } },
  });
  const req = { user: { id: 'v1' }, params: { id: 'o1' } };
  const res = makeRes();
  await getOrgSettings(req, res, { prisma });
  assert.equal(res._status, 200);
  assert.equal(res._body.settings.defaultModel, 'opus-4-7');
  assert.equal(res._body.settings.brand.color, '#0af');
});

test('get settings: non-member 404', async () => {
  const { prisma } = makeFakePrisma({ members: {} });
  const req = { user: { id: 'ghost' }, params: { id: 'o1' } };
  const res = makeRes();
  await getOrgSettings(req, res, { prisma });
  assert.equal(res._status, 404);
});

// ─── PATCH settings ─────────────────────────────────────────────────

test('patch settings: ADMIN merges + audit-logs with before/after', async () => {
  const { prisma, writeAuditLog, audits } = makeFakePrisma({
    members: { 'o1:a1': { role: 'ADMIN' } },
    orgs: { o1: { id: 'o1', settings: { defaultModel: 'sonnet', responseStyle: 'concise' } } },
  });
  const req = {
    user: { id: 'a1' },
    params: { id: 'o1' },
    body: { settings: { defaultModel: 'opus-4-7', brand: 'sira' } },
  };
  const res = makeRes();
  await patchOrgSettings(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 200);
  assert.deepEqual(res._body.settings, {
    defaultModel: 'opus-4-7',
    responseStyle: 'concise',
    brand: 'sira',
  });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'org_settings_update');
  assert.equal(audits[0].before.defaultModel, 'sonnet');
  assert.equal(audits[0].after.defaultModel, 'opus-4-7');
  assert.equal(audits[0].metadata.orgId, 'o1');
});

test('patch settings: accepts bare body (no settings wrapper)', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: { 'o1:a1': { role: 'ADMIN' } },
    orgs: { o1: { id: 'o1', settings: {} } },
  });
  const req = { user: { id: 'a1' }, params: { id: 'o1' }, body: { defaultModel: 'haiku' } };
  const res = makeRes();
  await patchOrgSettings(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 200);
  assert.equal(res._body.settings.defaultModel, 'haiku');
});

test('patch settings: explicit null removes key', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: { 'o1:a1': { role: 'ADMIN' } },
    orgs: { o1: { id: 'o1', settings: { defaultModel: 'sonnet', branding: 'x' } } },
  });
  const req = {
    user: { id: 'a1' },
    params: { id: 'o1' },
    body: { settings: { branding: null } },
  };
  const res = makeRes();
  await patchOrgSettings(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 200);
  assert.equal(res._body.settings.defaultModel, 'sonnet');
  assert.equal(res._body.settings.branding, undefined);
});

test('patch settings: MEMBER rejected (403)', async () => {
  const { prisma, writeAuditLog, audits } = makeFakePrisma({
    members: { 'o1:m1': { role: 'MEMBER' } },
    orgs: { o1: { id: 'o1', settings: {} } },
  });
  const req = { user: { id: 'm1' }, params: { id: 'o1' }, body: { settings: { x: 1 } } };
  const res = makeRes();
  await patchOrgSettings(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 403);
  assert.equal(audits.length, 0);
});

test('patch settings: rejects non-object payload (400)', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: { 'o1:a1': { role: 'ADMIN' } },
    orgs: { o1: { id: 'o1', settings: {} } },
  });
  const req = { user: { id: 'a1' }, params: { id: 'o1' }, body: { settings: [1, 2, 3] } };
  const res = makeRes();
  await patchOrgSettings(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 400);
});

// ─── zod schema validation (cycle 78) ───────────────────────────────

test('parseOrgSettingsPatch: accepts known keys with valid shape', () => {
  const r = parseOrgSettingsPatch({
    defaultModel: 'opus-4-7',
    responseStyle: 'concise',
    branding: { primaryColor: '#0af', logoUrl: 'https://x.test/logo.png' },
    features: { betaCowork: true, betaAgents: false },
  });
  assert.equal(r.error, null);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.value.defaultModel, 'opus-4-7');
});

test('parseOrgSettingsPatch: rejects unknown enum value for responseStyle', () => {
  const r = parseOrgSettingsPatch({ responseStyle: 'verbose' });
  assert.ok(r.error, 'expected error');
  assert.ok(Array.isArray(r.error.issues));
  assert.ok(r.error.issues.some((i) => i.path === 'responseStyle'));
});

test('parseOrgSettingsPatch: rejects malformed branding.primaryColor', () => {
  const r = parseOrgSettingsPatch({ branding: { primaryColor: 'not-a-color' } });
  assert.ok(r.error);
  assert.ok(r.error.issues.some((i) => i.path.startsWith('branding')));
});

test('parseOrgSettingsPatch: rejects non-bool features.betaCowork', () => {
  const r = parseOrgSettingsPatch({ features: { betaCowork: 'yes' } });
  assert.ok(r.error);
  assert.ok(r.error.issues.some((i) => i.path.startsWith('features')));
});

test('parseOrgSettingsPatch: unknown top-level keys pass through as warnings', () => {
  const r = parseOrgSettingsPatch({ defaultModel: 'sonnet', futureFlag: 1, anotherUnknown: 'x' });
  assert.equal(r.error, null);
  assert.deepEqual(r.warnings.sort(), ['anotherUnknown', 'futureFlag']);
  assert.equal(r.value.futureFlag, 1);
});

test('parseOrgSettingsPatch: explicit null for known keys is honoured (delete semantics)', () => {
  const r = parseOrgSettingsPatch({ defaultModel: null, branding: null });
  assert.equal(r.error, null);
  assert.equal(r.value.defaultModel, null);
  assert.equal(r.value.branding, null);
});

test('parseOrgSettingsPatch: rejects array / primitive payloads', () => {
  assert.ok(parseOrgSettingsPatch(null).error);
  assert.ok(parseOrgSettingsPatch([1, 2]).error);
  assert.ok(parseOrgSettingsPatch('hi').error);
});

// ─── ai block (Task 1 + Task 2) ─────────────────────────────────────

test('parseOrgSettingsPatch: accepts ai block with valid provider + model + cost cap', () => {
  const r = parseOrgSettingsPatch({
    ai: {
      preferredProvider: 'Anthropic',
      preferredModel: 'claude-sonnet-4.5',
      maxCostPerRequestUSD: 2.5,
    },
  });
  assert.equal(r.error, null);
  assert.equal(r.value.ai.preferredProvider, 'Anthropic');
  assert.equal(r.value.ai.preferredModel, 'claude-sonnet-4.5');
  assert.equal(r.value.ai.maxCostPerRequestUSD, 2.5);
});

test('parseOrgSettingsPatch: rejects ai.preferredProvider outside allowlist', () => {
  const r = parseOrgSettingsPatch({ ai: { preferredProvider: 'Bogus' } });
  assert.ok(r.error);
  assert.ok(r.error.issues.some((i) => i.path.startsWith('ai')));
});

test('parseOrgSettingsPatch: rejects ai.maxCostPerRequestUSD <= 0', () => {
  const zero = parseOrgSettingsPatch({ ai: { maxCostPerRequestUSD: 0 } });
  assert.ok(zero.error);
  const neg = parseOrgSettingsPatch({ ai: { maxCostPerRequestUSD: -1 } });
  assert.ok(neg.error);
});

test('parseOrgSettingsPatch: rejects ai unknown sub-key (strict)', () => {
  const r = parseOrgSettingsPatch({ ai: { preferredProvider: 'OpenAI', wat: 1 } });
  assert.ok(r.error);
});

test('parseOrgSettingsPatch: ai = null deletes the bag', () => {
  const r = parseOrgSettingsPatch({ ai: null });
  assert.equal(r.error, null);
  assert.equal(r.value.ai, null);
});

test('patch settings: zod 400 on invalid known key (responseStyle)', async () => {
  const { prisma, writeAuditLog, audits } = makeFakePrisma({
    members: { 'o1:a1': { role: 'ADMIN' } },
    orgs: { o1: { id: 'o1', settings: {} } },
  });
  const req = {
    user: { id: 'a1' },
    params: { id: 'o1' },
    body: { settings: { responseStyle: 'verbose' } },
  };
  const res = makeRes();
  await patchOrgSettings(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 400);
  assert.equal(audits.length, 0);
  assert.ok(Array.isArray(res._body.issues));
});

test('patch settings: zod allows unknown keys + returns warnings array', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: { 'o1:a1': { role: 'ADMIN' } },
    orgs: { o1: { id: 'o1', settings: {} } },
  });
  const req = {
    user: { id: 'a1' },
    params: { id: 'o1' },
    body: { settings: { defaultModel: 'opus-4-7', experimentalFlag: true } },
  };
  const res = makeRes();
  await patchOrgSettings(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 200);
  assert.equal(res._body.settings.defaultModel, 'opus-4-7');
  assert.equal(res._body.settings.experimentalFlag, true);
  assert.deepEqual(res._body.warnings, ['experimentalFlag']);
});

// ─── POST security ─────────────────────────────────────────────────

test('post security: OWNER toggles requireTwoFactor and audit-logs change', async () => {
  const { prisma, writeAuditLog, audits } = makeFakePrisma({
    members: { 'o1:owner1': { role: 'OWNER' } },
    orgs: { o1: { id: 'o1', settings: { responseStyle: 'concise', security: { requireTwoFactor: false } } } },
  });
  const req = { user: { id: 'owner1' }, params: { id: 'o1' }, body: { requireTwoFactor: true } };
  const res = makeRes();
  await postOrgSecurity(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 200);
  assert.deepEqual(res._body.security, { requireTwoFactor: true });
  assert.equal(prisma._orgs.o1.settings.responseStyle, 'concise');
  assert.deepEqual(prisma._orgs.o1.settings.security, { requireTwoFactor: true });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'org_security_update');
  assert.deepEqual(audits[0].before.security, { requireTwoFactor: false });
  assert.deepEqual(audits[0].after.security, { requireTwoFactor: true });
});

test('post security: rejects non-owner and malformed body', async () => {
  const { prisma, writeAuditLog, audits } = makeFakePrisma({
    members: { 'o1:admin1': { role: 'ADMIN' } },
    orgs: { o1: { id: 'o1', settings: {} } },
  });

  const badBody = makeRes();
  await postOrgSecurity(
    { user: { id: 'admin1' }, params: { id: 'o1' }, body: { requireTwoFactor: 'yes' } },
    badBody,
    { prisma, writeAuditLog },
  );
  assert.equal(badBody._status, 400);

  const notOwner = makeRes();
  await postOrgSecurity(
    { user: { id: 'admin1' }, params: { id: 'o1' }, body: { requireTwoFactor: true } },
    notOwner,
    { prisma, writeAuditLog },
  );
  assert.equal(notOwner._status, 403);
  assert.equal(audits.length, 0);
});

// ─── listMemberActivity (cycle 78) ──────────────────────────────────

test('member activity: ADMIN gets last 50 rows scoped to org + user', async () => {
  const { prisma } = makeFakePrisma({
    members: { 'o1:admin1': { role: 'ADMIN' } },
    auditRows: [
      { id: 'a1', action: 'org_invite_create', actorId: 'u9', metadata: { orgId: 'o1' } },
      { id: 'a2', action: 'org_settings_update', actorId: 'u9', metadata: { orgId: 'o1' } },
      { id: 'a3', action: 'org_invite_create', actorId: 'other', metadata: { orgId: 'o1' } },
      { id: 'a4', action: 'org_invite_create', actorId: 'u9', metadata: { orgId: 'o2' } },
    ],
  });
  const req = { user: { id: 'admin1' }, params: { id: 'o1', userId: 'u9' }, query: {} };
  const res = makeRes();
  await listMemberActivity(req, res, { prisma });
  assert.equal(res._status, 200);
  assert.equal(res._body.userId, 'u9');
  assert.equal(res._body.orgId, 'o1');
  assert.equal(res._body.limit, 50);
  assert.equal(res._body.items.length, 2);
  // The query must combine byOrg + byUser filters.
  const call = prisma._auditCalls[0];
  assert.equal(call.where.actorId, 'u9');
  assert.deepEqual(call.where.metadata, { path: ['orgId'], equals: 'o1' });
});

test('member activity: MEMBER rejected (403)', async () => {
  const { prisma } = makeFakePrisma({
    members: { 'o1:m1': { role: 'MEMBER' } },
  });
  const req = { user: { id: 'm1' }, params: { id: 'o1', userId: 'u9' }, query: {} };
  const res = makeRes();
  await listMemberActivity(req, res, { prisma });
  assert.equal(res._status, 403);
});

test('member activity: non-member caller 404', async () => {
  const { prisma } = makeFakePrisma({ members: {} });
  const req = { user: { id: 'ghost' }, params: { id: 'o1', userId: 'u9' }, query: {} };
  const res = makeRes();
  await listMemberActivity(req, res, { prisma });
  assert.equal(res._status, 404);
});

test('member activity: empty userId param → 400', async () => {
  const { prisma } = makeFakePrisma({
    members: { 'o1:admin1': { role: 'ADMIN' } },
  });
  const req = { user: { id: 'admin1' }, params: { id: 'o1', userId: '' }, query: {} };
  const res = makeRes();
  await listMemberActivity(req, res, { prisma });
  assert.equal(res._status, 400);
});

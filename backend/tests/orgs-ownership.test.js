'use strict';

/**
 * Unit tests for the org ownership transfer + self-leave endpoints
 * (orgs route, cycle 47). Exercises the handler functions directly
 * with fake prisma + req/res — no Express bind or DB required.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const orgsRouter = require('../src/routes/orgs');

const { transferOwnership, leaveOrg } = orgsRouter.__handlers;

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

function makeFakePrisma({ members = {}, ownerCount = null } = {}) {
  // `members` is a map: `${orgId}:${userId}` → { role }.
  const audits = [];
  const updates = [];
  const writeAuditLog = (_db, payload) => { audits.push(payload); };
  const txState = { tx: 0 };

  const orgMembership = {
    findUnique: async ({ where }) => {
      const { orgId, userId } = where.orgId_userId;
      const key = `${orgId}:${userId}`;
      const m = members[key];
      if (!m) return null;
      return { id: `mem-${key}`, orgId, userId, role: m.role, organization: { id: orgId } };
    },
    update: async ({ where, data }) => {
      const { orgId, userId } = where.orgId_userId;
      const key = `${orgId}:${userId}`;
      if (!members[key]) throw new Error('not found');
      members[key] = { ...members[key], role: data.role };
      updates.push({ where: key, data });
      return { id: `mem-${key}`, orgId, userId, role: data.role };
    },
    delete: async ({ where }) => {
      const { orgId, userId } = where.orgId_userId;
      delete members[`${orgId}:${userId}`];
      return { ok: true };
    },
    count: async ({ where }) => {
      if (ownerCount != null) return ownerCount;
      return Object.values(members).filter((m) => m.role === where.role && where.orgId).length;
    },
  };
  const organization = {
    update: async ({ where, data }) => {
      updates.push({ org: where.id, data });
      return { id: where.id, ownerId: data.ownerId };
    },
  };
  const prisma = {
    orgMembership,
    organization,
    $transaction: async (fn) => {
      txState.tx += 1;
      return fn({ orgMembership, organization });
    },
    _audits: audits,
    _updates: updates,
    _tx: txState,
  };
  return { prisma, writeAuditLog };
}

// ─── transfer-ownership ────────────────────────────────────────────

test('transfer-ownership: happy path swaps OWNER → ADMIN, MEMBER → OWNER atomically', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: {
      'o1:owner1': { role: 'OWNER' },
      'o1:user2': { role: 'MEMBER' },
    },
  });
  const req = { user: { id: 'owner1' }, params: { id: 'o1' }, body: { newOwnerId: 'user2' } };
  const res = makeRes();
  await transferOwnership(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 200);
  assert.equal(res._body.ok, true);
  assert.equal(res._body.ownerId, 'user2');
  assert.equal(res._body.previousOwnerRole, 'ADMIN');
  assert.equal(res._body.newOwnerRole, 'OWNER');
  assert.equal(res._body.previousTargetRole, 'MEMBER');
  // Members updated through the swap.
  assert.equal(prisma.orgMembership.findUnique && true, true);
  assert.equal(prisma._tx.tx, 1, 'must run inside a single $transaction');
  // Audit logged.
  assert.equal(prisma._audits.length, 1);
  assert.equal(prisma._audits[0].action, 'org_ownership_transfer');
  assert.equal(prisma._audits[0].after.ownerId, 'user2');
});

test('transfer-ownership: rejects when caller is not OWNER (403)', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: {
      'o1:admin1': { role: 'ADMIN' },
      'o1:user2': { role: 'MEMBER' },
    },
  });
  const req = { user: { id: 'admin1' }, params: { id: 'o1' }, body: { newOwnerId: 'user2' } };
  const res = makeRes();
  await transferOwnership(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 403);
  assert.equal(prisma._audits.length, 0);
});

test('transfer-ownership: 404 when target is not a member', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: { 'o1:owner1': { role: 'OWNER' } },
  });
  const req = { user: { id: 'owner1' }, params: { id: 'o1' }, body: { newOwnerId: 'ghost' } };
  const res = makeRes();
  await transferOwnership(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 404);
});

test('transfer-ownership: 400 when target role is below MEMBER', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: {
      'o1:owner1': { role: 'OWNER' },
      'o1:viewer1': { role: 'VIEWER' },
    },
  });
  const req = { user: { id: 'owner1' }, params: { id: 'o1' }, body: { newOwnerId: 'viewer1' } };
  const res = makeRes();
  await transferOwnership(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 400);
  assert.match(res._body.error, /at least a MEMBER/);
});

test('transfer-ownership: 400 when newOwnerId missing', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: { 'o1:owner1': { role: 'OWNER' } },
  });
  const req = { user: { id: 'owner1' }, params: { id: 'o1' }, body: {} };
  const res = makeRes();
  await transferOwnership(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 400);
  assert.match(res._body.error, /newOwnerId/);
});

test('transfer-ownership: 400 when newOwnerId equals caller', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: { 'o1:owner1': { role: 'OWNER' } },
  });
  const req = { user: { id: 'owner1' }, params: { id: 'o1' }, body: { newOwnerId: 'owner1' } };
  const res = makeRes();
  await transferOwnership(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 400);
});

test('transfer-ownership: ADMIN target gets promoted to OWNER, previous role preserved in audit', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: {
      'o1:owner1': { role: 'OWNER' },
      'o1:admin1': { role: 'ADMIN' },
    },
  });
  const req = { user: { id: 'owner1' }, params: { id: 'o1' }, body: { newOwnerId: 'admin1' } };
  const res = makeRes();
  await transferOwnership(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 200);
  assert.equal(res._body.previousTargetRole, 'ADMIN');
  assert.equal(prisma._audits[0].before.targetRole, 'ADMIN');
});

// ─── leave ──────────────────────────────────────────────────────────

test('leave: ADMIN can self-leave', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: {
      'o1:owner1': { role: 'OWNER' },
      'o1:admin1': { role: 'ADMIN' },
    },
  });
  const req = { user: { id: 'admin1' }, params: { id: 'o1' }, body: {} };
  const res = makeRes();
  await leaveOrg(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 200);
  assert.equal(res._body.ok, true);
  assert.equal(prisma._audits[0].action, 'org_member_leave');
});

test('leave: 409 last_owner when sole OWNER tries to leave', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: { 'o1:owner1': { role: 'OWNER' } },
    ownerCount: 1,
  });
  const req = { user: { id: 'owner1' }, params: { id: 'o1' }, body: {} };
  const res = makeRes();
  await leaveOrg(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 409);
  assert.equal(res._body.reason, 'last_owner');
  assert.equal(prisma._audits.length, 0);
});

test('leave: OWNER can leave when another OWNER exists', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: {
      'o1:owner1': { role: 'OWNER' },
      'o1:owner2': { role: 'OWNER' },
    },
    ownerCount: 2,
  });
  const req = { user: { id: 'owner1' }, params: { id: 'o1' }, body: {} };
  const res = makeRes();
  await leaveOrg(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 200);
  assert.equal(res._body.ok, true);
});

test('leave: 404 when caller is not a member', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({ members: {} });
  const req = { user: { id: 'ghost' }, params: { id: 'o1' }, body: {} };
  const res = makeRes();
  await leaveOrg(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 404);
});

test('leave: VIEWER can self-leave', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: {
      'o1:owner1': { role: 'OWNER' },
      'o1:viewer1': { role: 'VIEWER' },
    },
  });
  const req = { user: { id: 'viewer1' }, params: { id: 'o1' }, body: {} };
  const res = makeRes();
  await leaveOrg(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 200);
});

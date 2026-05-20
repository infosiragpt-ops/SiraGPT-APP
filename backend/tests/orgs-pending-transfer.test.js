'use strict';

/**
 * Unit tests for the org pending-transfer workflow (ratchet 44, cycle 76).
 * Exercises the request / accept / cancel handlers directly with a
 * hand-rolled fake prisma — no Express bind or real DB required.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const orgsRouter = require('../src/routes/orgs');

const { requestTransfer, acceptTransfer, cancelTransfer, transferOwnership } = orgsRouter.__handlers;

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

let pendingIdCounter = 0;
function nextPendingId() { pendingIdCounter += 1; return `pt-${pendingIdCounter}`; }

function makeFakePrisma({ members = {}, orgs = {}, pending = {} } = {}) {
  const audits = [];
  const writeAuditLog = (_db, payload) => { audits.push(payload); };

  const orgMembership = {
    findUnique: async ({ where }) => {
      const { orgId, userId } = where.orgId_userId;
      const key = `${orgId}:${userId}`;
      const m = members[key];
      if (!m) return null;
      return {
        id: `mem-${key}`,
        orgId,
        userId,
        role: m.role,
        organization: orgs[orgId] || { id: orgId },
      };
    },
    update: async ({ where, data }) => {
      const { orgId, userId } = where.orgId_userId;
      const key = `${orgId}:${userId}`;
      if (!members[key]) throw new Error('not found');
      members[key] = { ...members[key], role: data.role };
      return { id: `mem-${key}`, orgId, userId, role: data.role };
    },
  };

  const organization = {
    findUnique: async ({ where, select }) => {
      const org = orgs[where.id];
      if (!org) return null;
      if (!select) return { ...org };
      const out = {};
      for (const k of Object.keys(select)) {
        if (select[k]) out[k] = org[k];
      }
      // Always provide id
      out.id = org.id;
      return out;
    },
    update: async ({ where, data }) => {
      const existing = orgs[where.id] || { id: where.id };
      orgs[where.id] = { ...existing, ...data };
      return { id: where.id, ownerId: data.ownerId };
    },
  };

  const orgPendingTransfer = {
    findUnique: async ({ where }) => pending[where.id] || null,
    findFirst: async ({ where }) => {
      const now = Date.now();
      for (const row of Object.values(pending)) {
        if (where.orgId && row.orgId !== where.orgId) continue;
        if (where.acceptedAt === null && row.acceptedAt) continue;
        if (where.expiresAt && where.expiresAt.gt) {
          const exp = row.expiresAt instanceof Date ? row.expiresAt.getTime() : new Date(row.expiresAt).getTime();
          const gt = where.expiresAt.gt instanceof Date ? where.expiresAt.gt.getTime() : new Date(where.expiresAt.gt).getTime();
          if (exp <= gt) continue;
        }
        return row;
      }
      return null;
    },
    create: async ({ data }) => {
      const id = nextPendingId();
      const row = {
        id,
        orgId: data.orgId,
        fromOwnerId: data.fromOwnerId,
        toOwnerId: data.toOwnerId,
        requestedAt: new Date(),
        expiresAt: data.expiresAt,
        acceptedAt: null,
      };
      pending[id] = row;
      return row;
    },
    update: async ({ where, data }) => {
      const row = pending[where.id];
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
    delete: async ({ where }) => {
      const row = pending[where.id];
      delete pending[where.id];
      return row;
    },
  };

  const prisma = {
    orgMembership,
    organization,
    orgPendingTransfer,
    $transaction: async (fn) => fn({ orgMembership, organization, orgPendingTransfer }),
    _audits: audits,
    _pending: pending,
    _orgs: orgs,
  };
  return { prisma, writeAuditLog };
}

// ─── requestTransfer ──────────────────────────────────────────────

test('request: with requireApprovalDays=0 falls through to instant transfer', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: {
      'o1:owner1': { role: 'OWNER' },
      'o1:user2': { role: 'MEMBER' },
    },
    orgs: { o1: { id: 'o1', settings: {} } },
  });
  const req = { user: { id: 'owner1' }, params: { id: 'o1' }, body: { newOwnerId: 'user2' } };
  const res = makeRes();
  await requestTransfer(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 200);
  assert.equal(res._body.ok, true);
  assert.equal(res._body.ownerId, 'user2');
  // No pending row created — instant path.
  assert.equal(Object.keys(prisma._pending).length, 0);
  // Audit emitted via the instant handler.
  assert.equal(prisma._audits[0].action, 'org_ownership_transfer');
});

test('request: with requireApprovalDays>0 creates pending row and does not swap', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: {
      'o1:owner1': { role: 'OWNER' },
      'o1:user2': { role: 'MEMBER' },
    },
    orgs: { o1: { id: 'o1', settings: { transfer: { requireApprovalDays: 3 } } } },
  });
  const req = { user: { id: 'owner1' }, params: { id: 'o1' }, body: { newOwnerId: 'user2' } };
  const res = makeRes();
  await requestTransfer(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 202);
  assert.equal(res._body.pending, true);
  assert.equal(res._body.toOwnerId, 'user2');
  assert.equal(res._body.requireApprovalDays, 3);
  assert.ok(res._body.transferId);
  // Pending row exists, membership unchanged.
  assert.equal(Object.keys(prisma._pending).length, 1);
  assert.equal((await prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: 'o1', userId: 'owner1' } } })).role, 'OWNER');
  // Audit action recorded.
  assert.equal(prisma._audits[0].action, 'org_ownership_transfer_request');
  assert.equal(prisma._audits[0].metadata?.orgId, 'o1');
  assert.equal(prisma._audits[0].metadata?.requireApprovalDays, 3);
});

test('request: rejects non-OWNER caller with 403', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: {
      'o1:owner1': { role: 'OWNER' },
      'o1:admin1': { role: 'ADMIN' },
      'o1:user2': { role: 'MEMBER' },
    },
    orgs: { o1: { id: 'o1', settings: { transfer: { requireApprovalDays: 2 } } } },
  });
  const req = { user: { id: 'admin1' }, params: { id: 'o1' }, body: { newOwnerId: 'user2' } };
  const res = makeRes();
  await requestTransfer(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 403);
  assert.equal(Object.keys(prisma._pending).length, 0);
});

test('request: 409 when another request is already pending', async () => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: {
      'o1:owner1': { role: 'OWNER' },
      'o1:user2': { role: 'MEMBER' },
      'o1:user3': { role: 'MEMBER' },
    },
    orgs: { o1: { id: 'o1', settings: { transfer: { requireApprovalDays: 2 } } } },
    pending: {
      existing: {
        id: 'existing', orgId: 'o1', fromOwnerId: 'owner1', toOwnerId: 'user2',
        requestedAt: new Date(), expiresAt: future, acceptedAt: null,
      },
    },
  });
  const req = { user: { id: 'owner1' }, params: { id: 'o1' }, body: { newOwnerId: 'user3' } };
  const res = makeRes();
  await requestTransfer(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 409);
  assert.equal(res._body.code, 'transfer_already_pending');
});

test('request: 400 when newOwnerId equals caller', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: { 'o1:owner1': { role: 'OWNER' } },
    orgs: { o1: { id: 'o1', settings: { transfer: { requireApprovalDays: 2 } } } },
  });
  const req = { user: { id: 'owner1' }, params: { id: 'o1' }, body: { newOwnerId: 'owner1' } };
  const res = makeRes();
  await requestTransfer(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 400);
});

test('request: 400 when target role is below MEMBER', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: {
      'o1:owner1': { role: 'OWNER' },
      'o1:viewer1': { role: 'VIEWER' },
    },
    orgs: { o1: { id: 'o1', settings: { transfer: { requireApprovalDays: 2 } } } },
  });
  const req = { user: { id: 'owner1' }, params: { id: 'o1' }, body: { newOwnerId: 'viewer1' } };
  const res = makeRes();
  await requestTransfer(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 400);
});

test('request: out-of-range requireApprovalDays clamped to 30', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: {
      'o1:owner1': { role: 'OWNER' },
      'o1:user2': { role: 'MEMBER' },
    },
    orgs: { o1: { id: 'o1', settings: { transfer: { requireApprovalDays: 999 } } } },
  });
  const req = { user: { id: 'owner1' }, params: { id: 'o1' }, body: { newOwnerId: 'user2' } };
  const res = makeRes();
  await requestTransfer(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 202);
  assert.equal(res._body.requireApprovalDays, 30);
});

// ─── acceptTransfer ───────────────────────────────────────────────

test('accept: target completes pending transfer, swaps roles atomically', async () => {
  const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: {
      'o1:owner1': { role: 'OWNER' },
      'o1:user2': { role: 'MEMBER' },
    },
    orgs: { o1: { id: 'o1', settings: { transfer: { requireApprovalDays: 3 } } } },
    pending: {
      pt1: {
        id: 'pt1', orgId: 'o1', fromOwnerId: 'owner1', toOwnerId: 'user2',
        requestedAt: new Date(), expiresAt: future, acceptedAt: null,
      },
    },
  });
  const req = { user: { id: 'user2' }, params: { id: 'pt1' }, body: {} };
  const res = makeRes();
  await acceptTransfer(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 200);
  assert.equal(res._body.ok, true);
  assert.equal(res._body.ownerId, 'user2');
  assert.equal(res._body.previousOwnerRole, 'ADMIN');
  assert.equal(res._body.previousTargetRole, 'MEMBER');
  assert.ok(res._body.acceptedAt);
  // Roles swapped.
  const ownerMembership = await prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: 'o1', userId: 'owner1' } } });
  const userMembership = await prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: 'o1', userId: 'user2' } } });
  assert.equal(ownerMembership.role, 'ADMIN');
  assert.equal(userMembership.role, 'OWNER');
  // Pending row stamped.
  assert.ok(prisma._pending.pt1.acceptedAt);
  // Audit logged with the expected action + transferId.
  assert.equal(prisma._audits[0].action, 'org_ownership_transfer');
  assert.equal(prisma._audits[0].metadata.transferId, 'pt1');
  assert.equal(prisma._audits[0].metadata.viaPendingRequest, true);
});

test('accept: 403 when caller is not the proposed new owner', async () => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: {
      'o1:owner1': { role: 'OWNER' },
      'o1:user2': { role: 'MEMBER' },
      'o1:user3': { role: 'MEMBER' },
    },
    pending: {
      pt1: { id: 'pt1', orgId: 'o1', fromOwnerId: 'owner1', toOwnerId: 'user2', requestedAt: new Date(), expiresAt: future, acceptedAt: null },
    },
  });
  const req = { user: { id: 'user3' }, params: { id: 'pt1' }, body: {} };
  const res = makeRes();
  await acceptTransfer(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 403);
});

test('accept: 410 when the request has expired', async () => {
  const past = new Date(Date.now() - 60 * 1000);
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: {
      'o1:owner1': { role: 'OWNER' },
      'o1:user2': { role: 'MEMBER' },
    },
    pending: {
      pt1: { id: 'pt1', orgId: 'o1', fromOwnerId: 'owner1', toOwnerId: 'user2', requestedAt: new Date(), expiresAt: past, acceptedAt: null },
    },
  });
  const req = { user: { id: 'user2' }, params: { id: 'pt1' }, body: {} };
  const res = makeRes();
  await acceptTransfer(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 410);
  assert.equal(res._body.code, 'transfer_expired');
});

test('accept: 409 when already accepted', async () => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const { prisma, writeAuditLog } = makeFakePrisma({
    members: {
      'o1:owner1': { role: 'OWNER' },
      'o1:user2': { role: 'MEMBER' },
    },
    pending: {
      pt1: { id: 'pt1', orgId: 'o1', fromOwnerId: 'owner1', toOwnerId: 'user2', requestedAt: new Date(), expiresAt: future, acceptedAt: new Date() },
    },
  });
  const req = { user: { id: 'user2' }, params: { id: 'pt1' }, body: {} };
  const res = makeRes();
  await acceptTransfer(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 409);
  assert.equal(res._body.code, 'transfer_already_accepted');
});

test('accept: 409 transfer_stale_from when requesting owner is no longer OWNER', async () => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const { prisma, writeAuditLog } = makeFakePrisma({
    // owner1 no longer OWNER — they were demoted in the meantime.
    members: {
      'o1:owner1': { role: 'ADMIN' },
      'o1:user2': { role: 'MEMBER' },
      'o1:owner3': { role: 'OWNER' },
    },
    pending: {
      pt1: { id: 'pt1', orgId: 'o1', fromOwnerId: 'owner1', toOwnerId: 'user2', requestedAt: new Date(), expiresAt: future, acceptedAt: null },
    },
  });
  const req = { user: { id: 'user2' }, params: { id: 'pt1' }, body: {} };
  const res = makeRes();
  await acceptTransfer(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 409);
  assert.equal(res._body.code, 'transfer_stale_from');
});

test('accept: 404 when request does not exist', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({});
  const req = { user: { id: 'user2' }, params: { id: 'missing' }, body: {} };
  const res = makeRes();
  await acceptTransfer(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 404);
});

// ─── cancelTransfer ───────────────────────────────────────────────

test('cancel: requesting owner removes pending row', async () => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const { prisma, writeAuditLog } = makeFakePrisma({
    pending: {
      pt1: { id: 'pt1', orgId: 'o1', fromOwnerId: 'owner1', toOwnerId: 'user2', requestedAt: new Date(), expiresAt: future, acceptedAt: null },
    },
  });
  const req = { user: { id: 'owner1' }, params: { id: 'pt1' }, body: {} };
  const res = makeRes();
  await cancelTransfer(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 200);
  assert.equal(res._body.ok, true);
  assert.equal(prisma._pending.pt1, undefined);
  assert.equal(prisma._audits[0].action, 'org_ownership_transfer_cancel');
});

test('cancel: 403 when caller is not the requester', async () => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const { prisma, writeAuditLog } = makeFakePrisma({
    pending: {
      pt1: { id: 'pt1', orgId: 'o1', fromOwnerId: 'owner1', toOwnerId: 'user2', requestedAt: new Date(), expiresAt: future, acceptedAt: null },
    },
  });
  const req = { user: { id: 'user2' }, params: { id: 'pt1' }, body: {} };
  const res = makeRes();
  await cancelTransfer(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 403);
  assert.ok(prisma._pending.pt1);
});

test('cancel: 409 when request already accepted', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({
    pending: {
      pt1: { id: 'pt1', orgId: 'o1', fromOwnerId: 'owner1', toOwnerId: 'user2', requestedAt: new Date(), expiresAt: new Date(), acceptedAt: new Date() },
    },
  });
  const req = { user: { id: 'owner1' }, params: { id: 'pt1' }, body: {} };
  const res = makeRes();
  await cancelTransfer(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 409);
  assert.equal(res._body.code, 'transfer_already_accepted');
});

test('cancel: 404 when request does not exist', async () => {
  const { prisma, writeAuditLog } = makeFakePrisma({});
  const req = { user: { id: 'owner1' }, params: { id: 'missing' }, body: {} };
  const res = makeRes();
  await cancelTransfer(req, res, { prisma, writeAuditLog });
  assert.equal(res._status, 404);
});

// ─── orgTransferApprovalDays helper ──────────────────────────────

test('orgTransferApprovalDays: handles missing / malformed settings safely', () => {
  const { orgTransferApprovalDays } = require('../src/services/orgs-service');
  assert.equal(orgTransferApprovalDays(null), 0);
  assert.equal(orgTransferApprovalDays({}), 0);
  assert.equal(orgTransferApprovalDays({ settings: null }), 0);
  assert.equal(orgTransferApprovalDays({ settings: [] }), 0);
  assert.equal(orgTransferApprovalDays({ settings: { transfer: null } }), 0);
  assert.equal(orgTransferApprovalDays({ settings: { transfer: { requireApprovalDays: 'bad' } } }), 0);
  assert.equal(orgTransferApprovalDays({ settings: { transfer: { requireApprovalDays: -3 } } }), 0);
  assert.equal(orgTransferApprovalDays({ settings: { transfer: { requireApprovalDays: 0 } } }), 0);
  assert.equal(orgTransferApprovalDays({ settings: { transfer: { requireApprovalDays: 5 } } }), 5);
  assert.equal(orgTransferApprovalDays({ settings: { transfer: { requireApprovalDays: 5.7 } } }), 5);
  assert.equal(orgTransferApprovalDays({ settings: { transfer: { requireApprovalDays: 999 } } }), 30);
});

// Sanity-check that the instant handler is still exposed.
test('legacy transferOwnership handler is still exported', () => {
  assert.equal(typeof transferOwnership, 'function');
});

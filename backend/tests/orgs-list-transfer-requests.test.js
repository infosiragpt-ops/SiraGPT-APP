'use strict';

/**
 * Unit tests for GET /api/orgs/:id/transfer-requests (ratchet 44 cycle 164).
 * Exercises the handler directly via the router's `__handlers` export —
 * no Express bind or real DB required.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const orgsRouter = require('../src/routes/orgs');

const { listTransferRequests } = orgsRouter.__handlers;

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

function makeFakePrisma({ members = {}, pending = [] } = {}) {
  const orgMembership = {
    findUnique: async ({ where }) => {
      const { orgId, userId } = where.orgId_userId;
      const key = `${orgId}:${userId}`;
      const m = members[key];
      if (!m) return null;
      return { id: `mem-${key}`, orgId, userId, role: m.role };
    },
  };

  const orgPendingTransfer = {
    findMany: async ({ where, orderBy, select }) => {
      const now = new Date();
      const filtered = pending.filter((r) => {
        if (where.orgId && r.orgId !== where.orgId) return false;
        if (where.acceptedAt === null && r.acceptedAt) return false;
        if (where.expiresAt?.gt) {
          const exp = r.expiresAt instanceof Date ? r.expiresAt.getTime() : new Date(r.expiresAt).getTime();
          const gt = where.expiresAt.gt instanceof Date ? where.expiresAt.gt.getTime() : new Date(where.expiresAt.gt).getTime();
          if (exp <= gt) return false;
        }
        return true;
      });
      // Sort desc by requestedAt to match orderBy contract.
      filtered.sort((a, b) => {
        const av = a.requestedAt instanceof Date ? a.requestedAt.getTime() : new Date(a.requestedAt).getTime();
        const bv = b.requestedAt instanceof Date ? b.requestedAt.getTime() : new Date(b.requestedAt).getTime();
        return bv - av;
      });
      if (!select) return filtered;
      return filtered.map((r) => {
        const out = {};
        for (const k of Object.keys(select)) if (select[k]) out[k] = r[k];
        return out;
      });
    },
  };

  return { orgMembership, orgPendingTransfer };
}

test('list: returns active pending transfers for ADMIN caller', async () => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const requestedAt = new Date(Date.now() - 60 * 1000);
  const prisma = makeFakePrisma({
    members: { 'o1:admin1': { role: 'ADMIN' } },
    pending: [
      {
        id: 'pt1', orgId: 'o1', fromOwnerId: 'owner1', toOwnerId: 'user2',
        requestedAt, expiresAt: future, acceptedAt: null,
      },
    ],
  });
  const req = { user: { id: 'admin1' }, params: { id: 'o1' } };
  const res = makeRes();

  await listTransferRequests(req, res, { prisma });

  assert.equal(res._status, 200);
  assert.ok(Array.isArray(res._body.items));
  assert.equal(res._body.items.length, 1);
  assert.equal(res._body.items[0].id, 'pt1');
  assert.equal(res._body.items[0].fromOwnerId, 'owner1');
  assert.equal(res._body.items[0].toOwnerId, 'user2');
  assert.equal(res._body.items[0].requestedAt, requestedAt.toISOString());
  assert.equal(res._body.items[0].expiresAt, future.toISOString());
});

test('list: OWNER also has ADMIN+ access', async () => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const prisma = makeFakePrisma({
    members: { 'o1:owner1': { role: 'OWNER' } },
    pending: [
      {
        id: 'pt1', orgId: 'o1', fromOwnerId: 'owner1', toOwnerId: 'user2',
        requestedAt: new Date(), expiresAt: future, acceptedAt: null,
      },
    ],
  });
  const req = { user: { id: 'owner1' }, params: { id: 'o1' } };
  const res = makeRes();
  await listTransferRequests(req, res, { prisma });
  assert.equal(res._status, 200);
  assert.equal(res._body.items.length, 1);
});

test('list: MEMBER caller is rejected with 403', async () => {
  const prisma = makeFakePrisma({
    members: { 'o1:member1': { role: 'MEMBER' } },
    pending: [],
  });
  const req = { user: { id: 'member1' }, params: { id: 'o1' } };
  const res = makeRes();
  await listTransferRequests(req, res, { prisma });
  assert.equal(res._status, 403);
});

test('list: non-member caller is rejected (assertMembership throws)', async () => {
  const prisma = makeFakePrisma({ members: {}, pending: [] });
  const req = { user: { id: 'stranger' }, params: { id: 'o1' } };
  const res = makeRes();
  await listTransferRequests(req, res, { prisma });
  // assertMembership throws an error with .status; could be 403/404
  // depending on implementation — assert non-200.
  assert.notEqual(res._status, 200);
});

test('list: expired rows are filtered out by expiresAt > now', async () => {
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const prisma = makeFakePrisma({
    members: { 'o1:admin1': { role: 'ADMIN' } },
    pending: [
      { id: 'pt-expired', orgId: 'o1', fromOwnerId: 'owner1', toOwnerId: 'user2', requestedAt: past, expiresAt: past, acceptedAt: null },
      { id: 'pt-active', orgId: 'o1', fromOwnerId: 'owner1', toOwnerId: 'user3', requestedAt: new Date(), expiresAt: future, acceptedAt: null },
    ],
  });
  const req = { user: { id: 'admin1' }, params: { id: 'o1' } };
  const res = makeRes();
  await listTransferRequests(req, res, { prisma });
  assert.equal(res._status, 200);
  assert.equal(res._body.items.length, 1);
  assert.equal(res._body.items[0].id, 'pt-active');
});

test('list: accepted rows are filtered out by acceptedAt: null', async () => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const prisma = makeFakePrisma({
    members: { 'o1:admin1': { role: 'ADMIN' } },
    pending: [
      { id: 'pt-accepted', orgId: 'o1', fromOwnerId: 'owner1', toOwnerId: 'user2', requestedAt: new Date(), expiresAt: future, acceptedAt: new Date() },
      { id: 'pt-pending', orgId: 'o1', fromOwnerId: 'owner1', toOwnerId: 'user3', requestedAt: new Date(), expiresAt: future, acceptedAt: null },
    ],
  });
  const req = { user: { id: 'admin1' }, params: { id: 'o1' } };
  const res = makeRes();
  await listTransferRequests(req, res, { prisma });
  assert.equal(res._status, 200);
  assert.equal(res._body.items.length, 1);
  assert.equal(res._body.items[0].id, 'pt-pending');
});

test('list: empty result returns items: []', async () => {
  const prisma = makeFakePrisma({
    members: { 'o1:admin1': { role: 'ADMIN' } },
    pending: [],
  });
  const req = { user: { id: 'admin1' }, params: { id: 'o1' } };
  const res = makeRes();
  await listTransferRequests(req, res, { prisma });
  assert.equal(res._status, 200);
  assert.deepEqual(res._body, { items: [] });
});

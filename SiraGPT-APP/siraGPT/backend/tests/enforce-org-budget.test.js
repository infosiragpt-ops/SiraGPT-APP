'use strict';

/**
 * Unit tests for middleware/enforce-org-budget.js — verifies the
 * hard-block path triggers HTTP 402 only when:
 *   1. an org is resolved on the request, AND
 *   2. `Organization.settings.budget.enforceLimit === true`, AND
 *   3. month-to-date spend (from injected records) >= monthlyCapUSD.
 * Otherwise the middleware is a transparent no-op.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  enforceOrgBudget,
  readEnforcedBudget,
  sumMonthToDate,
} = require('../src/middleware/enforce-org-budget');

function makeRes() {
  const headers = {};
  return {
    statusCode: 0,
    headers,
    body: null,
    setHeader(k, v) { headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function makePrisma({ org, members = [] }) {
  return {
    organization: {
      findUnique: async ({ where }) => {
        if (org && org.id === where.id) return org;
        return null;
      },
    },
    orgMembership: {
      findMany: async () => members.map((id) => ({ userId: id })),
    },
  };
}

test('readEnforcedBudget rejects when enforceLimit is not true', () => {
  assert.equal(readEnforcedBudget(null), null);
  assert.equal(readEnforcedBudget({}), null);
  assert.equal(readEnforcedBudget({ budget: { monthlyCapUSD: 100 } }), null);
  assert.equal(
    readEnforcedBudget({ budget: { monthlyCapUSD: 100, enforceLimit: false } }),
    null,
  );
  assert.equal(
    readEnforcedBudget({ budget: { monthlyCapUSD: 0, enforceLimit: true } }),
    null,
  );
  const out = readEnforcedBudget({
    budget: { monthlyCapUSD: 100, enforceLimit: true },
  });
  assert.deepEqual(out, { monthlyCapUSD: 100, enforceLimit: true });
});

test('sumMonthToDate only counts current-month records for members', () => {
  const now = Date.parse('2026-05-19T12:00:00Z');
  const records = [
    { userId: 'm1', costUSD: 12, ts: '2026-05-01T00:00:00Z' },
    { userId: 'm2', costUSD: 8, ts: '2026-05-10T00:00:00Z' },
    { userId: 'm1', costUSD: 999, ts: '2026-04-30T00:00:00Z' }, // prior month
    { userId: 'stranger', costUSD: 999, ts: '2026-05-15T00:00:00Z' }, // not member
  ];
  const total = sumMonthToDate(records, new Set(['m1', 'm2']), now);
  assert.equal(total, 20);
});

test('middleware is no-op when no org context resolved', async () => {
  let called = false;
  const mw = enforceOrgBudget({
    prisma: makePrisma({ org: null }),
    getRecords: () => [],
    now: () => Date.parse('2026-05-19T00:00:00Z'),
  });
  const res = makeRes();
  await mw({ headers: {}, body: {} }, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.statusCode, 0);
});

test('middleware passes through when enforceLimit is false', async () => {
  let called = false;
  const mw = enforceOrgBudget({
    prisma: makePrisma({
      org: { id: 'org1', settings: { budget: { monthlyCapUSD: 50, enforceLimit: false } } },
      members: ['m1'],
    }),
    getRecords: () => [
      { userId: 'm1', costUSD: 999, ts: '2026-05-10T00:00:00Z' },
    ],
    now: () => Date.parse('2026-05-19T00:00:00Z'),
  });
  const res = makeRes();
  await mw(
    { headers: {}, body: {}, orgContext: { orgId: 'org1' } },
    res,
    () => { called = true; },
  );
  assert.equal(called, true);
  assert.equal(res.statusCode, 0);
  // Headers are NOT set when enforcement is disabled
  assert.equal(res.headers['X-Org-Budget-Enforced'], undefined);
});

test('middleware blocks with HTTP 402 when MTD >= cap and enforceLimit is true', async () => {
  let called = false;
  let refundCalled = false;
  const mw = enforceOrgBudget({
    prisma: makePrisma({
      org: { id: 'org1', settings: { budget: { monthlyCapUSD: 50, enforceLimit: true } } },
      members: ['m1', 'm2'],
    }),
    getRecords: () => [
      { userId: 'm1', costUSD: 30, ts: '2026-05-10T00:00:00Z' },
      { userId: 'm2', costUSD: 25, ts: '2026-05-12T00:00:00Z' },
    ],
    now: () => Date.parse('2026-05-19T00:00:00Z'),
  });
  const res = makeRes();
  await mw(
    {
      headers: {},
      body: {},
      orgContext: { orgId: 'org1', refund: async () => { refundCalled = true; } },
    },
    res,
    () => { called = true; },
  );
  assert.equal(called, false, 'next() must NOT be called when blocked');
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.error, 'organization_budget_exhausted');
  assert.equal(res.body.orgId, 'org1');
  assert.equal(res.body.usedThisMonthUSD, 55);
  assert.equal(res.body.monthlyCapUSD, 50);
  assert.equal(res.headers['X-Org-Budget-Enforced'], 'true');
  assert.equal(res.headers['X-Org-Budget-Used'], '55');
  assert.equal(res.headers['X-Org-Budget-Cap'], '50');
  // Refund optimistic +1 from enforceOrgQuota
  assert.equal(refundCalled, true);
});

test('middleware allows request when MTD is under cap', async () => {
  let called = false;
  const mw = enforceOrgBudget({
    prisma: makePrisma({
      org: { id: 'org1', settings: { budget: { monthlyCapUSD: 100, enforceLimit: true } } },
      members: ['m1'],
    }),
    getRecords: () => [
      { userId: 'm1', costUSD: 40, ts: '2026-05-10T00:00:00Z' },
    ],
    now: () => Date.parse('2026-05-19T00:00:00Z'),
  });
  const res = makeRes();
  await mw(
    { headers: {}, body: {}, orgContext: { orgId: 'org1' } },
    res,
    () => { called = true; },
  );
  assert.equal(called, true);
  assert.equal(res.statusCode, 0);
  // Telemetry headers are still emitted even when not blocked.
  assert.equal(res.headers['X-Org-Budget-Enforced'], 'true');
  assert.equal(res.headers['X-Org-Budget-Used'], '40');
});

test('middleware fails open on prisma errors', async () => {
  let called = false;
  const mw = enforceOrgBudget({
    prisma: {
      organization: { findUnique: async () => { throw new Error('db down'); } },
      orgMembership: { findMany: async () => [] },
    },
    getRecords: () => [],
    now: () => Date.now(),
  });
  const res = makeRes();
  await mw(
    { headers: {}, body: {}, orgContext: { orgId: 'org1' } },
    res,
    () => { called = true; },
  );
  assert.equal(called, true);
  assert.equal(res.statusCode, 0);
});

test('middleware resolves orgId from x-org-id header when orgContext missing', async () => {
  let blocked = false;
  const mw = enforceOrgBudget({
    prisma: makePrisma({
      org: { id: 'org9', settings: { budget: { monthlyCapUSD: 10, enforceLimit: true } } },
      members: ['m1'],
    }),
    getRecords: () => [
      { userId: 'm1', costUSD: 25, ts: '2026-05-10T00:00:00Z' },
    ],
    now: () => Date.parse('2026-05-19T00:00:00Z'),
  });
  const res = makeRes();
  await mw(
    { headers: { 'x-org-id': 'org9' }, body: {} },
    res,
    () => { blocked = false; },
  );
  blocked = res.statusCode === 402;
  assert.equal(blocked, true);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { enforceOrgQuota } = require('../src/middleware/enforce-org-quota');

function makeRes() {
  const headers = {};
  return {
    statusCode: 0, headers, body: null,
    setHeader(k, v) { headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// Fake client whose $queryRawUnsafe mimics the atomic conditional reserve
// (`UPDATE ... WHERE usedThisMonth + cost <= monthlyQuota RETURNING`). Because
// JS is single-threaded, this serializes concurrent calls exactly as a row lock
// would — so the middleware can't overshoot even when every request loaded the
// same pre-increment snapshot via findUnique.
function makeClient(org) {
  return {
    orgMembership: { findUnique: async () => ({ role: 'member' }) },
    organization: {
      findUnique: async () => ({ ...org }),
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
    },
    $queryRawUnsafe: async (_sql, costStr) => {
      const cost = Number(costStr);
      if (org.usedThisMonth + cost <= org.monthlyQuota) {
        org.usedThisMonth += cost;
        return [{ usedThisMonth: BigInt(org.usedThisMonth) }];
      }
      return [];
    },
  };
}

function fire(mw) {
  const res = makeRes();
  let nexted = false;
  return mw({ user: { id: 'u1' }, headers: { 'x-org-id': 'org1' }, body: {} }, res, () => { nexted = true; })
    .then(() => ({ status: res.statusCode, nexted }));
}

test('atomic reserve: a single request under the cap reserves and proceeds', async () => {
  const org = { id: 'org1', monthlyQuota: 10, usedThisMonth: 4, quotaResetAt: new Date() };
  const r = await fire(enforceOrgQuota({ prisma: makeClient(org), cost: 1 }));
  assert.equal(r.nexted, true);
  assert.equal(r.status, 0);
  assert.equal(org.usedThisMonth, 5);
});

test('atomic reserve: a request at the cap is blocked with 429', async () => {
  const org = { id: 'org1', monthlyQuota: 10, usedThisMonth: 10, quotaResetAt: new Date() };
  const r = await fire(enforceOrgQuota({ prisma: makeClient(org), cost: 1 }));
  assert.equal(r.nexted, false);
  assert.equal(r.status, 429);
  assert.equal(org.usedThisMonth, 10, 'counter untouched on a blocked request');
});

test('atomic reserve: concurrent requests at the cap do NOT overshoot (TOCTOU fixed)', async () => {
  const org = { id: 'org1', monthlyQuota: 10, usedThisMonth: 8, quotaResetAt: new Date() };
  const mw = enforceOrgQuota({ prisma: makeClient(org), cost: 1 });
  const results = await Promise.all(Array.from({ length: 5 }, () => fire(mw)));
  const allowed = results.filter((r) => r.nexted).length;
  const blocked = results.filter((r) => r.status === 429).length;
  assert.equal(allowed, 2, 'exactly the remaining 2 units (8→10) are reserved');
  assert.equal(blocked, 3, 'the other 3 are rejected');
  assert.equal(org.usedThisMonth, 10, 'usedThisMonth never exceeds monthlyQuota');
});

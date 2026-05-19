/**
 * enforce-org-rate-limit — verifies the per-org RPS middleware.
 *
 * Properties under test:
 *   1. No org context → no-op pass-through.
 *   2. FREE plan → 1 rps; second call within 1s → 429 + Retry-After.
 *   3. PRO plan → 10 rps; ENT plan → 100 rps.
 *   4. Plan from req.orgContext skips the DB hit.
 *   5. Store failure → fail-open (next called, no 429).
 *   6. Headers (limit / remaining / plan) are set on every call.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  enforceOrgRateLimit,
  rpsFor,
  HEADER_RPS_LIMIT,
  HEADER_RPS_REMAINING,
  HEADER_RPS_PLAN,
} = require('../src/middleware/enforce-org-rate-limit');

function fakeRes() {
  const headers = {};
  let statusCode = 200;
  let payload = null;
  return {
    setHeader(k, v) { headers[k] = v; },
    getHeader(k) { return headers[k]; },
    status(code) {
      statusCode = code;
      return {
        json(obj) {
          payload = obj;
          return this;
        },
      };
    },
    _state() {
      return { headers, statusCode, payload };
    },
  };
}

function makePrisma(plan) {
  return {
    organization: {
      findUnique: async () => ({ billingPlan: plan }),
    },
  };
}

function makeStore(responses) {
  let i = 0;
  return {
    consume: async () => {
      const r = responses[i] || responses[responses.length - 1];
      i += 1;
      return r;
    },
  };
}

describe('enforce-org-rate-limit', () => {
  test('rpsFor maps plans correctly', () => {
    assert.equal(rpsFor('FREE'), 1);
    assert.equal(rpsFor('PRO'), 10);
    assert.equal(rpsFor('PRO_MAX'), 10);
    assert.equal(rpsFor('ENTERPRISE'), 100);
    assert.equal(rpsFor(undefined), 1); // default → FREE
    assert.equal(rpsFor('garbage'), 1);
  });

  test('no orgId → pass-through (next called, no 429)', async () => {
    const mw = enforceOrgRateLimit({
      prisma: makePrisma('FREE'),
      store: makeStore([{ allowed: false, remaining: 0, resetAt: new Date() }]),
    });
    const res = fakeRes();
    let called = false;
    await mw({ headers: {}, body: {} }, res, () => { called = true; });
    assert.equal(called, true);
    assert.equal(res._state().statusCode, 200);
  });

  test('FREE: second hit within window → 429 with Retry-After', async () => {
    const mw = enforceOrgRateLimit({
      prisma: makePrisma('FREE'),
      store: makeStore([
        { allowed: false, remaining: 0, resetAt: new Date(Date.now() + 750) },
      ]),
    });
    const res = fakeRes();
    let called = false;
    await mw(
      { headers: { 'x-org-id': 'org_abc' }, body: {} },
      res,
      () => { called = true; },
    );
    const s = res._state();
    assert.equal(called, false);
    assert.equal(s.statusCode, 429);
    assert.equal(s.payload.error, 'organization rate limit exceeded');
    assert.equal(s.payload.orgId, 'org_abc');
    assert.equal(s.payload.plan, 'FREE');
    assert.equal(s.payload.limitRps, 1);
    assert.ok(s.payload.retryAfterMs > 0);
    assert.ok(Number(s.headers['Retry-After']) >= 1);
    assert.equal(s.headers[HEADER_RPS_PLAN], 'FREE');
    assert.equal(s.headers[HEADER_RPS_LIMIT], '1');
  });

  test('PRO: limit is 10 in headers', async () => {
    const mw = enforceOrgRateLimit({
      prisma: makePrisma('PRO'),
      store: makeStore([{ allowed: true, remaining: 9, resetAt: new Date() }]),
    });
    const res = fakeRes();
    let called = false;
    await mw({ headers: { 'x-org-id': 'o' }, body: {} }, res, () => { called = true; });
    assert.equal(called, true);
    assert.equal(res._state().headers[HEADER_RPS_LIMIT], '10');
    assert.equal(res._state().headers[HEADER_RPS_REMAINING], '9');
  });

  test('ENTERPRISE: limit is 100', async () => {
    const mw = enforceOrgRateLimit({
      prisma: makePrisma('ENTERPRISE'),
      store: makeStore([{ allowed: true, remaining: 99, resetAt: new Date() }]),
    });
    const res = fakeRes();
    await mw({ headers: { 'x-org-id': 'o' }, body: {} }, res, () => {});
    assert.equal(res._state().headers[HEADER_RPS_LIMIT], '100');
    assert.equal(res._state().headers[HEADER_RPS_PLAN], 'ENTERPRISE');
  });

  test('plan from req.orgContext skips DB hit', async () => {
    let dbHit = false;
    const mw = enforceOrgRateLimit({
      prisma: {
        organization: {
          findUnique: async () => { dbHit = true; return { billingPlan: 'FREE' }; },
        },
      },
      store: makeStore([{ allowed: true, remaining: 9, resetAt: new Date() }]),
    });
    const res = fakeRes();
    await mw(
      { headers: {}, body: {}, orgContext: { orgId: 'o', plan: 'PRO' } },
      res,
      () => {},
    );
    assert.equal(dbHit, false);
    assert.equal(res._state().headers[HEADER_RPS_PLAN], 'PRO');
  });

  test('store failure → fail-open (next called, no 429)', async () => {
    const mw = enforceOrgRateLimit({
      prisma: makePrisma('FREE'),
      store: { consume: async () => { throw new Error('redis down'); } },
    });
    const res = fakeRes();
    let called = false;
    await mw({ headers: { 'x-org-id': 'o' }, body: {} }, res, () => { called = true; });
    assert.equal(called, true);
    assert.equal(res._state().statusCode, 200);
  });

  test('orgId can come from body.organizationId', async () => {
    const mw = enforceOrgRateLimit({
      prisma: makePrisma('FREE'),
      store: makeStore([{ allowed: true, remaining: 0, resetAt: new Date() }]),
    });
    const res = fakeRes();
    let called = false;
    await mw(
      { headers: {}, body: { organizationId: 'from_body' } },
      res,
      () => { called = true; },
    );
    assert.equal(called, true);
    assert.equal(res._state().headers[HEADER_RPS_PLAN], 'FREE');
  });
});

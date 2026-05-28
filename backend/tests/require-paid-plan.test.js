'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const requirePaidPlan = require('../src/middleware/require-paid-plan');
const {
  DEFAULT_PAID_PLANS,
  normalizePlan,
} = require('../src/middleware/require-paid-plan');

function makeReqRes({ user } = {}) {
  let statusCode = 200;
  let jsonBody = null;
  let nextCalled = false;
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { jsonBody = payload; return this; },
    get statusCode() { return statusCode; },
    get jsonBody() { return jsonBody; },
  };
  const next = () => { nextCalled = true; };
  return {
    req: { user },
    res,
    next,
    get nextCalled() { return nextCalled; },
  };
}

test('normalizePlan: defaults blanks to FREE and uppercases real plans', () => {
  assert.equal(normalizePlan(), 'FREE');
  assert.equal(normalizePlan(''), 'FREE');
  assert.equal(normalizePlan(' pro_max '), 'PRO_MAX');
});

test('requirePaidPlan: blocks unauthenticated requests', () => {
  const ctx = makeReqRes();
  requirePaidPlan()(ctx.req, ctx.res, ctx.next);

  assert.equal(ctx.nextCalled, false);
  assert.equal(ctx.res.statusCode, 401);
  assert.equal(ctx.res.jsonBody.error, 'auth required');
});

test('requirePaidPlan: blocks FREE users with upgrade payload', () => {
  const ctx = makeReqRes({ user: { id: 'u1', plan: 'FREE' } });
  requirePaidPlan({ feature: 'image_generation' })(ctx.req, ctx.res, ctx.next);

  assert.equal(ctx.nextCalled, false);
  assert.equal(ctx.res.statusCode, 402);
  assert.equal(ctx.res.jsonBody.code, 'UPGRADE_REQUIRED');
  assert.equal(ctx.res.jsonBody.feature, 'image_generation');
  assert.equal(ctx.res.jsonBody.upgradeRequired, true);
  assert.deepEqual(ctx.res.jsonBody.requiredPlans, DEFAULT_PAID_PLANS);
});

test('requirePaidPlan: allows paid plans and super-admins', () => {
  const paid = makeReqRes({ user: { id: 'u1', plan: 'pro' } });
  requirePaidPlan()(paid.req, paid.res, paid.next);
  assert.equal(paid.nextCalled, true);
  assert.equal(paid.res.statusCode, 200);

  const admin = makeReqRes({ user: { id: 'admin', plan: 'FREE', isSuperAdmin: true } });
  requirePaidPlan()(admin.req, admin.res, admin.next);
  assert.equal(admin.nextCalled, true);
  assert.equal(admin.res.statusCode, 200);
});


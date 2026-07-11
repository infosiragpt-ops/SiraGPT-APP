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

test('requirePaidPlan: preserves paid legacy users with no subscription fields', () => {
  const paid = makeReqRes({ user: { id: 'u1', plan: 'pro' } });
  requirePaidPlan()(paid.req, paid.res, paid.next);
  assert.equal(paid.nextCalled, true);
  assert.equal(paid.res.statusCode, 200);
});

test('requirePaidPlan: allows active/trialing subscriptions and super-admins', () => {
  for (const subscriptionStatus of ['active', 'TRIALING']) {
    const paid = makeReqRes({
      user: {
        id: `u-${subscriptionStatus}`,
        plan: 'PRO',
        stripeSubscriptionId: `sub-${subscriptionStatus}`,
        subscriptionStatus,
      },
    });
    requirePaidPlan()(paid.req, paid.res, paid.next);
    assert.equal(paid.nextCalled, true, subscriptionStatus);
    assert.equal(paid.res.statusCode, 200, subscriptionStatus);
  }
  const admin = makeReqRes({
    user: {
      id: 'admin',
      plan: 'FREE',
      isSuperAdmin: true,
      stripeSubscriptionId: 'sub_admin_old',
      subscriptionStatus: 'canceled',
    },
  });
  requirePaidPlan()(admin.req, admin.res, admin.next);
  assert.equal(admin.nextCalled, true);
  assert.equal(admin.res.statusCode, 200);
});

test('requirePaidPlan: allows canceling subscriptions until their future period end', () => {
  const ctx = makeReqRes({
    user: {
      id: 'u-canceling-future',
      plan: 'PRO',
      stripeSubscriptionId: 'sub_canceling_future',
      subscriptionStatus: 'canceling',
      subscriptionEndDate: new Date('2999-01-01T00:00:00.000Z'),
    },
  });

  requirePaidPlan()(ctx.req, ctx.res, ctx.next);

  assert.equal(ctx.nextCalled, true);
  assert.equal(ctx.res.statusCode, 200);
});

test('requirePaidPlan: blocks canceling subscriptions once their period end expires', () => {
  const ctx = makeReqRes({
    user: {
      id: 'u-canceling-expired',
      plan: 'PRO',
      stripeSubscriptionId: 'sub_canceling_expired',
      subscriptionStatus: 'canceling',
      subscriptionEndDate: new Date('2000-01-01T00:00:00.000Z'),
    },
  });

  requirePaidPlan()(ctx.req, ctx.res, ctx.next);

  assert.equal(ctx.nextCalled, false);
  assert.equal(ctx.res.statusCode, 402);
  assert.equal(ctx.res.jsonBody.reason, 'SUBSCRIPTION_INACTIVE');
  assert.equal(ctx.res.jsonBody.subscriptionStatus, 'canceling');
});

test('requirePaidPlan: blocks paid plans whose subscription state is not active', () => {
  for (const subscriptionStatus of [
    'canceled',
    'past_due',
    'unpaid',
    'incomplete_expired',
  ]) {
    const ctx = makeReqRes({
      user: {
        id: `u-${subscriptionStatus}`,
        plan: 'PRO',
        stripeSubscriptionId: `sub-${subscriptionStatus}`,
        subscriptionStatus,
      },
    });
    requirePaidPlan({ feature: 'image_generation' })(ctx.req, ctx.res, ctx.next);

    assert.equal(ctx.nextCalled, false, subscriptionStatus);
    assert.equal(ctx.res.statusCode, 402, subscriptionStatus);
    assert.equal(ctx.res.jsonBody.code, 'UPGRADE_REQUIRED', subscriptionStatus);
    assert.equal(ctx.res.jsonBody.reason, 'SUBSCRIPTION_INACTIVE', subscriptionStatus);
    assert.equal(ctx.res.jsonBody.subscriptionStatus, subscriptionStatus);
  }
});

test('requirePaidPlan: fails closed when a subscription exists without a known state', () => {
  const ctx = makeReqRes({
    user: {
      id: 'u-unknown',
      plan: 'PRO_MAX',
      stripeSubscriptionId: 'sub_unknown',
      subscriptionStatus: null,
    },
  });

  requirePaidPlan()(ctx.req, ctx.res, ctx.next);

  assert.equal(ctx.nextCalled, false);
  assert.equal(ctx.res.statusCode, 402);
  assert.equal(ctx.res.jsonBody.reason, 'SUBSCRIPTION_INACTIVE');
  assert.equal(ctx.res.jsonBody.subscriptionStatus, 'unknown');
});


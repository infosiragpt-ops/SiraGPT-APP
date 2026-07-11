'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const prisma = require('../src/config/database');
const requirePaidPlan = require('../src/middleware/require-paid-plan');
const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
  mockResolvedModule,
} = require('./http-test-utils');

const STRIPE_PATH = require.resolve('../src/services/stripe');
const PAYMENTS_PATH = require.resolve('../src/routes/payments');

function paidAccessFor(user) {
  let nextCalled = false;
  let statusCode = 200;
  const req = { user };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  };
  requirePaidPlan()(req, res, () => {
    nextCalled = true;
  });
  return { nextCalled, statusCode };
}

describe('POST /payments/subscription/cancel · paid-period persistence', () => {
  let auth;
  let restoreStripe;
  let originalFindUnique;
  let originalUpdate;
  let stripeSubscription;
  let updates;

  beforeEach(() => {
    auth = installAuthSessionMock({
      plan: 'PRO',
      stripeSubscriptionId: 'sub_cancel_route',
      subscriptionStatus: 'active',
      subscriptionEndDate: null,
    });
    updates = [];
    stripeSubscription = {
      id: 'sub_cancel_route',
      status: 'active',
      cancel_at_period_end: true,
      current_period_end: 4_102_444_800,
    };
    originalFindUnique = prisma.user.findUnique;
    originalUpdate = prisma.user.update;
    prisma.user.findUnique = async ({ where }) => (
      where.id === auth.user.id ? { ...auth.user } : null
    );
    prisma.user.update = async ({ where, data }) => {
      assert.equal(where.id, auth.user.id);
      updates.push({ where, data });
      Object.assign(auth.user, data);
      return { ...auth.user };
    };
    restoreStripe = mockResolvedModule(STRIPE_PATH, {
      cancelSubscription: async (subscriptionId) => {
        assert.equal(subscriptionId, 'sub_cancel_route');
        return { ...stripeSubscription };
      },
      isStripeLikeError: () => false,
      isConfigured: true,
      demoAllowed: false,
    });
    delete require.cache[PAYMENTS_PATH];
  });

  afterEach(() => {
    auth.restore();
    restoreStripe();
    prisma.user.findUnique = originalFindUnique;
    prisma.user.update = originalUpdate;
    delete require.cache[PAYMENTS_PATH];
  });

  function cancelSubscription() {
    const app = buildRouteTestApp('/payments', reloadModule('../src/routes/payments'));
    return request(app)
      .post('/payments/subscription/cancel')
      .set('Authorization', auth.authHeader)
      .send({});
  }

  test('persists Stripe period end atomically with canceling status and keeps middleware access', async () => {
    const expectedEnd = new Date(stripeSubscription.current_period_end * 1000);

    const response = await cancelSubscription();

    assert.equal(response.status, 200);
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].data, {
      subscriptionStatus: 'canceling',
      subscriptionEndDate: expectedEnd,
    });
    assert.equal(auth.user.subscriptionStatus, 'canceling');
    assert.equal(auth.user.subscriptionEndDate.getTime(), expectedEnd.getTime());
    assert.equal(response.body.subscription.currentPeriodEnd, expectedEnd.toISOString());
    assert.deepEqual(paidAccessFor(auth.user), {
      nextCalled: true,
      statusCode: 200,
    });
  });

  test('invalid Stripe period end reuses a trusted future end in the same atomic update', async () => {
    const existingEnd = new Date('2999-01-01T00:00:00.000Z');
    auth.user.subscriptionEndDate = existingEnd;
    stripeSubscription.current_period_end = 'not-a-timestamp';

    const response = await cancelSubscription();

    assert.equal(response.status, 200);
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].data, {
      subscriptionStatus: 'canceling',
      subscriptionEndDate: existingEnd,
    });
    assert.equal(response.body.subscription.currentPeriodEnd, existingEnd.toISOString());
    assert.deepEqual(paidAccessFor(auth.user), {
      nextCalled: true,
      statusCode: 200,
    });
  });

  test('invalid Stripe period end without a safe fallback preserves active paid access', async () => {
    stripeSubscription.current_period_end = -1;

    const response = await cancelSubscription();

    assert.equal(response.status, 200);
    assert.equal(updates.length, 0);
    assert.equal(auth.user.subscriptionStatus, 'active');
    assert.equal(auth.user.subscriptionEndDate, null);
    assert.equal(response.body.subscription.currentPeriodEnd, null);
    assert.deepEqual(paidAccessFor(auth.user), {
      nextCalled: true,
      statusCode: 200,
    });
  });

  test('invalid Stripe period end never revives a terminal local entitlement', async () => {
    auth.user.subscriptionStatus = 'canceled';
    auth.user.subscriptionEndDate = new Date('2999-01-01T00:00:00.000Z');
    stripeSubscription.current_period_end = 'invalid';

    const response = await cancelSubscription();

    assert.equal(response.status, 200);
    assert.equal(updates.length, 0);
    assert.equal(auth.user.subscriptionStatus, 'canceled');
    assert.equal(response.body.subscription.currentPeriodEnd, null);
    assert.deepEqual(paidAccessFor(auth.user), {
      nextCalled: false,
      statusCode: 402,
    });
  });
});

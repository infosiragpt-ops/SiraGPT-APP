'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  buildRouteTestApp,
  reloadModule,
  mockResolvedModule,
} = require('./http-test-utils');

/**
 * Stripe redelivers webhooks on timeout/retry and can send the same event
 * twice. `checkout.session.completed` grants plan credits ADDITIVELY
 * (monthlyLimit += creditsForPlan), so a duplicate delivery used to
 * double-grant. The handler now claims the payment row with an atomic
 * compare-and-swap (PENDING→COMPLETED) and only the winning delivery grants.
 *
 * These tests drive the real /payments/stripe/webhook route with a fake
 * prisma + a stubbed Stripe event, asserting the grant fires exactly once
 * across two identical deliveries — and that flows without a local payment
 * row still grant (no regression).
 */

const DB_PATH = require.resolve('../src/config/database');
const STRIPE_PATH = require.resolve('../src/services/stripe');
const POSTHOG_PATH = require.resolve('../src/services/observability/posthog');

function makeFakePrisma({ payments, user }) {
  const userUpdates = [];
  return {
    _userUpdates: userUpdates,
    _payments: payments,
    payment: {
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const p of payments) {
          if (p.stripeSessionId !== where.stripeSessionId) continue;
          if (p.userId !== where.userId) continue;
          // Honour `status: { not: 'COMPLETED' }` so the CAS only claims rows
          // that have not already been completed.
          if (where.status && where.status.not !== undefined && p.status === where.status.not) continue;
          Object.assign(p, data);
          count += 1;
        }
        return { count };
      },
      findFirst: async ({ where }) => {
        const f = payments.find((p) =>
          p.stripeSessionId === where.stripeSessionId &&
          p.userId === where.userId &&
          (where.status === undefined || p.status === where.status));
        return f ? { id: f.id } : null;
      },
    },
    user: {
      findUnique: async ({ where }) => (where.id === user.id ? { ...user } : null),
      update: async ({ where, data }) => {
        assert.equal(where.id, user.id);
        userUpdates.push(data);
        Object.assign(user, data);
        return { ...user };
      },
    },
  };
}

function stripeEvent(sessionId, { userId = 'u1', plan = 'PRO' } = {}) {
  return {
    type: 'checkout.session.completed',
    data: { object: { id: sessionId, subscription: 'sub_123', metadata: { userId, plan } } },
  };
}

describe('POST /payments/stripe/webhook · checkout idempotency', () => {
  let restoreDb;
  let restoreStripe;
  let restorePosthog;
  let fake;

  function setup({ payments, user, event }) {
    fake = makeFakePrisma({ payments, user });
    restoreDb = mockResolvedModule(DB_PATH, fake);
    restoreStripe = mockResolvedModule(STRIPE_PATH, {
      constructWebhookEvent: () => event,
      toHttpError: (err) => ({ statusCode: 400, body: { message: err?.message || 'bad' } }),
    });
    restorePosthog = mockResolvedModule(POSTHOG_PATH, { capturePostHogEvent: () => {} });
    delete require.cache[require.resolve('../src/routes/payments')];
    return buildRouteTestApp('/payments', reloadModule('../src/routes/payments'));
  }

  afterEach(() => {
    restoreDb && restoreDb();
    restoreStripe && restoreStripe();
    restorePosthog && restorePosthog();
    delete require.cache[require.resolve('../src/routes/payments')];
  });

  async function deliver(app) {
    return request(app)
      .post('/payments/stripe/webhook')
      .set('stripe-signature', 'sig')
      .set('Content-Type', 'application/json')
      .send(Buffer.from('{}'));
  }

  test('a redelivered checkout event grants credits only once', async () => {
    const user = { id: 'u1', plan: 'FREE', monthlyLimit: 0n, gemaTokenLimit: 0n };
    const payments = [{ id: 'pay1', stripeSessionId: 'cs_1', userId: 'u1', status: 'PENDING' }];
    const app = setup({ payments, user, event: stripeEvent('cs_1') });

    const first = await deliver(app);
    assert.equal(first.status, 200);
    assert.equal(fake._userUpdates.length, 1, 'first delivery grants once');
    const grantedLimit = user.monthlyLimit;
    assert.ok(grantedLimit > 0n, 'credits were added');
    assert.equal(payments[0].status, 'COMPLETED');

    const second = await deliver(app);
    assert.equal(second.status, 200);
    assert.equal(fake._userUpdates.length, 1, 'redelivery must NOT grant again');
    assert.equal(user.monthlyLimit, grantedLimit, 'monthlyLimit unchanged on redelivery');
  });

  test('no local payment row → still grants (no regression for non-tracked flows)', async () => {
    const user = { id: 'u1', plan: 'FREE', monthlyLimit: 0n, gemaTokenLimit: 0n };
    const app = setup({ payments: [], user, event: stripeEvent('cs_orphan') });

    const res = await deliver(app);
    assert.equal(res.status, 200);
    assert.equal(fake._userUpdates.length, 1, 'grant still fires when no payment row exists');
    assert.ok(user.monthlyLimit > 0n);
  });
});

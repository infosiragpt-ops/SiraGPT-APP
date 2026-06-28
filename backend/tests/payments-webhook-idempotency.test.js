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

function makeFakePrisma({ payments, user, failUserUpdateTimes = 0 }) {
  const userUpdates = [];
  let remainingFailures = failUserUpdateTimes;
  const db = {
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
        if (remainingFailures > 0) { remainingFailures -= 1; throw new Error('simulated user.update failure'); }
        userUpdates.push(data);
        Object.assign(user, data);
        return { ...user };
      },
    },
  };
  // Rollback-capable interactive transaction: snapshot the mutable state and
  // restore it if the callback throws, mirroring Postgres rollback so the
  // claim-then-failed-grant case leaves the payment row claimable again.
  db.$transaction = async (fn) => {
    const snapPayments = payments.map((p) => ({ ...p }));
    const snapUser = { ...user };
    try {
      return await fn(db);
    } catch (err) {
      payments.splice(0, payments.length, ...snapPayments);
      Object.keys(user).forEach((k) => delete user[k]);
      Object.assign(user, snapUser);
      throw err;
    }
  };
  return db;
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

  function setup({ payments, user, event, failUserUpdateTimes = 0 }) {
    fake = makeFakePrisma({ payments, user, failUserUpdateTimes });
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

  test('a failed grant rolls back the COMPLETED claim and returns 500 (Stripe will retry)', async () => {
    const user = { id: 'u1', plan: 'FREE', monthlyLimit: 0n, gemaTokenLimit: 0n };
    const payments = [{ id: 'pay1', stripeSessionId: 'cs_2', userId: 'u1', status: 'PENDING' }];
    // First grant throws → transaction rolls back the claim; second succeeds.
    const app = setup({ payments, user, event: stripeEvent('cs_2'), failUserUpdateTimes: 1 });

    const first = await deliver(app);
    assert.equal(first.status, 500, 'failed grant surfaces as 500 so Stripe redelivers');
    assert.equal(fake._userUpdates.length, 0, 'no grant committed');
    assert.equal(payments[0].status, 'PENDING', 'COMPLETED claim was rolled back → still claimable');
    assert.equal(user.monthlyLimit, 0n, 'balance untouched');

    const second = await deliver(app);
    assert.equal(second.status, 200, 'redelivery succeeds once the grant works');
    assert.equal(fake._userUpdates.length, 1, 'granted exactly once across the retry');
    assert.ok(user.monthlyLimit > 0n, 'credits granted on the successful retry');
    assert.equal(payments[0].status, 'COMPLETED');
  });
});

// ── #E2/#E3: critical webhook writes must surface failures as 500 so Stripe
// retries (they used to be swallowed → silent 200 → lost renewal/downgrade) ──
const USAGE_MONITOR_PATH = require.resolve('../src/services/usage-monitor');
const TRIGGERS_PATH = require.resolve('../src/services/trigger-registry');
const INVOICE_SYNC_PATH = require.resolve('../src/services/invoice-sync');
const EMAIL_PATH = require.resolve('../src/services/email');

describe('POST /payments/stripe/webhook · subscription/invoice critical-write retry', () => {
  let restores = [];

  function setupSub({ event, user, failUserUpdate = false, subscriptionEvents = [], notifications = [], failNotification = false, failSubEvent = false }) {
    const userUpdates = [];
    const db = {
      _userUpdates: userUpdates,
      user: {
        findUnique: async ({ where }) =>
          (where.stripeCustomerId === user.stripeCustomerId || where.id === user.id ? { ...user } : null),
        update: async ({ data }) => {
          if (failUserUpdate) throw new Error('simulated user.update failure');
          userUpdates.push(data);
          Object.assign(user, data);
          return { ...user };
        },
      },
      subscriptionEvent: { create: async ({ data }) => { if (failSubEvent) throw new Error('simulated subscriptionEvent failure'); subscriptionEvents.push(data); return { id: 'evt1', ...data }; } },
      notification: { create: async ({ data }) => { if (failNotification) throw new Error('simulated notification failure'); notifications.push(data); return { id: 'notif1', ...data }; } },
    };
    restores = [
      mockResolvedModule(DB_PATH, db),
      mockResolvedModule(STRIPE_PATH, {
        constructWebhookEvent: () => event,
        toHttpError: (err) => ({ statusCode: 400, body: { message: err.message } }),
        retrieveSubscription: async () => ({ status: 'active', current_period_end: 1700000000 }),
      }),
      mockResolvedModule(POSTHOG_PATH, { capturePostHogEvent: () => {} }),
      mockResolvedModule(USAGE_MONITOR_PATH, { resetMonthlyUsage: async () => {} }),
      mockResolvedModule(TRIGGERS_PATH, { publish: async () => {} }),
      mockResolvedModule(INVOICE_SYNC_PATH, { syncInvoiceFromStripe: async () => {} }),
      // Keep the dunning path hermetic + fast — skip the real SMTP attempt.
      mockResolvedModule(EMAIL_PATH, { isConfigured: () => false, sendPaymentFailureAlert: async () => {} }),
    ];
    delete require.cache[require.resolve('../src/routes/payments')];
    return { app: buildRouteTestApp('/payments', reloadModule('../src/routes/payments')), db, subscriptionEvents };
  }

  afterEach(() => { restores.forEach((fn) => fn()); restores = []; delete require.cache[require.resolve('../src/routes/payments')]; });

  function deliver(app) {
    return request(app).post('/payments/stripe/webhook').set('stripe-signature', 'sig')
      .set('Content-Type', 'application/json').send(Buffer.from('{}'));
  }

  const subDeletedEvent = { type: 'customer.subscription.deleted', data: { object: { customer: 'cus_1', ended_at: 1700000000 } } };
  const invoicePaidEvent = { type: 'invoice.payment_succeeded', data: { object: { subscription: 'sub_1', customer: 'cus_1', id: 'in_1', amount_paid: 1000, currency: 'usd' } } };

  test('subscription.deleted: a failed downgrade returns 500 (Stripe retries)', async () => {
    const user = { id: 'u1', stripeCustomerId: 'cus_1', plan: 'PRO', monthlyLimit: 100000n };
    const { app } = setupSub({ event: subDeletedEvent, user, failUserUpdate: true });
    const res = await deliver(app);
    assert.equal(res.status, 500);
  });

  test('subscription.deleted: a successful downgrade returns 200 and reverts to FREE', async () => {
    const user = { id: 'u1', stripeCustomerId: 'cus_1', plan: 'PRO', monthlyLimit: 100000n };
    const { app } = setupSub({ event: subDeletedEvent, user });
    const res = await deliver(app);
    assert.equal(res.status, 200);
    assert.equal(user.plan, 'FREE');
  });

  test('invoice.payment_succeeded: a failed status update returns 500 (Stripe retries)', async () => {
    const user = { id: 'u1', stripeCustomerId: 'cus_1', plan: 'PRO' };
    const { app } = setupSub({ event: invoicePaidEvent, user, failUserUpdate: true });
    const res = await deliver(app);
    assert.equal(res.status, 500);
  });

  test('invoice.payment_succeeded: success returns 200 and records exactly one audit event', async () => {
    const user = { id: 'u1', stripeCustomerId: 'cus_1', plan: 'PRO' };
    const subscriptionEvents = [];
    const { app } = setupSub({ event: invoicePaidEvent, user, subscriptionEvents });
    const res = await deliver(app);
    assert.equal(res.status, 200);
    assert.equal(subscriptionEvents.length, 1, 'one payment_succeeded audit row');
  });

  // ── subscription.updated: idempotent state write must surface failures ──
  const subUpdatedEvent = { type: 'customer.subscription.updated', data: { object: { customer: 'cus_1', status: 'past_due', current_period_end: 1700000000 } } };

  test('subscription.updated: a failed status update returns 500 (Stripe retries)', async () => {
    const user = { id: 'u1', stripeCustomerId: 'cus_1', plan: 'PRO' };
    const { app } = setupSub({ event: subUpdatedEvent, user, failUserUpdate: true });
    assert.equal((await deliver(app)).status, 500);
  });

  test('subscription.updated: success returns 200 and persists the new status', async () => {
    const user = { id: 'u1', stripeCustomerId: 'cus_1', plan: 'PRO' };
    const { app } = setupSub({ event: subUpdatedEvent, user });
    assert.equal((await deliver(app)).status, 200);
    assert.equal(user.subscriptionStatus, 'past_due');
  });

  // ── subscription.created: persisting stripeSubscriptionId is critical ──
  const subCreatedEvent = { type: 'customer.subscription.created', data: { object: { id: 'sub_new', customer: 'cus_1', status: 'active', current_period_end: 1700000000, items: { data: [{ price: { nickname: 'Pro' } }] } } } };

  test('subscription.created: a failed user update returns 500 (Stripe retries)', async () => {
    const user = { id: 'u1', stripeCustomerId: 'cus_1', plan: 'PRO' };
    const { app } = setupSub({ event: subCreatedEvent, user, failUserUpdate: true });
    assert.equal((await deliver(app)).status, 500);
  });

  test('subscription.created: success returns 200, persists subId, records one audit event', async () => {
    const user = { id: 'u1', stripeCustomerId: 'cus_1', plan: 'PRO' };
    const subscriptionEvents = [];
    const { app } = setupSub({ event: subCreatedEvent, user, subscriptionEvents });
    assert.equal((await deliver(app)).status, 200);
    assert.equal(user.stripeSubscriptionId, 'sub_new');
    assert.equal(subscriptionEvents.length, 1, 'one created audit row');
  });

  test('subscription.created: a failed audit-row write is ISOLATED → still 200, subId persisted', async () => {
    const user = { id: 'u1', stripeCustomerId: 'cus_1', plan: 'PRO' };
    const { app } = setupSub({ event: subCreatedEvent, user, failSubEvent: true });
    assert.equal((await deliver(app)).status, 200, 'non-idempotent audit failure must not 500/retry');
    assert.equal(user.stripeSubscriptionId, 'sub_new', 'critical subId write still committed');
  });

  // ── invoice.payment_failed: past_due is revenue-critical; notification/audit isolated ──
  const invoiceFailedEvent = { type: 'invoice.payment_failed', data: { object: { customer: 'cus_1', id: 'in_1', amount_due: 1500, currency: 'usd' } } };

  test('invoice.payment_failed: a failed past_due update returns 500 (Stripe retries)', async () => {
    const user = { id: 'u1', stripeCustomerId: 'cus_1', plan: 'PRO' };
    const { app } = setupSub({ event: invoiceFailedEvent, user, failUserUpdate: true });
    assert.equal((await deliver(app)).status, 500);
  });

  test('invoice.payment_failed: success returns 200, sets past_due, one notification + one event', async () => {
    const user = { id: 'u1', stripeCustomerId: 'cus_1', plan: 'PRO' };
    const subscriptionEvents = [];
    const notifications = [];
    const { app } = setupSub({ event: invoiceFailedEvent, user, subscriptionEvents, notifications });
    assert.equal((await deliver(app)).status, 200);
    assert.equal(user.subscriptionStatus, 'past_due');
    assert.equal(notifications.length, 1, 'one in-app dunning notification');
    assert.equal(subscriptionEvents.length, 1, 'one payment_failed audit row');
  });

  test('invoice.payment_failed: a failed notification write is ISOLATED → still 200, past_due set', async () => {
    const user = { id: 'u1', stripeCustomerId: 'cus_1', plan: 'PRO' };
    const { app } = setupSub({ event: invoiceFailedEvent, user, failNotification: true });
    assert.equal((await deliver(app)).status, 200, 'non-idempotent notification failure must not 500/retry');
    assert.equal(user.subscriptionStatus, 'past_due', 'critical past_due write still committed');
  });
});

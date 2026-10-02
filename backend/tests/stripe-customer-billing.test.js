'use strict';

process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { StripeService } = require('../src/services/stripe');
const { createCustomerCheckout, createCustomerPortal } = require('../src/services/stripe-customer-billing');

const env = Object.freeze({ NODE_ENV: 'production', FRONTEND_URL: 'https://siragpt.com/' });
const clone = value => structuredClone(value);
const safePortal = () => ({ id: 'bpc_safe', active: true, livemode: true, metadata: { siragpt_billing: 'v1' }, features: {
  invoice_history: { enabled: true }, payment_method_update: { enabled: true },
  subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' }, subscription_update: { enabled: false },
} });

function harness({ user: userChanges = {}, payments: initialPayments = [], subscriptions = [], hasMore = false, sessions = {}, portalConfigurations = [safePortal()], checkoutUrl, portalUrl } = {}) {
  const user = { id: 'owner', email: 'owner@example.test', name: 'Owner', plan: 'FREE', stripeCustomerId: 'cus_owner', stripeSubscriptionId: null, subscriptionStatus: null, ...userChanges };
  const payments = clone(initialPayments);
  const calls = { customers: [], checkouts: [], retrieves: [], subscriptions: [], portalConfigs: [], portalSessions: [], userReads: [], locks: [] };
  const customerResources = new Map();
  const checkoutResources = new Map();
  let customerCount = 0;
  let checkoutCount = 0;
  let lockTail = Promise.resolve();
  const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value);
  const prisma = {
    user: {
      findUnique: async ({ where }) => { calls.userReads.push(clone(where)); return where.id === user.id ? clone(user) : null; },
      update: async ({ where, data }) => { assert.equal(where.id, user.id); Object.assign(user, data); return clone(user); },
    },
    payment: {
      findFirst: async ({ where }) => clone(payments.filter(row => matches(row, where)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null),
      create: async ({ data }) => { const row = { id: `payment_${payments.length + 1}`, createdAt: new Date(), ...clone(data) }; payments.push(row); return clone(row); },
      updateMany: async ({ where, data }) => { let count = 0; for (const row of payments) if (matches(row, where)) { Object.assign(row, clone(data)); count++; } return { count }; },
    },
    $transaction: async fn => {
      let release;
      const tx = { ...prisma, $queryRawUnsafe: async (sql, lockedUser) => {
        assert.match(sql, /FOR NO KEY UPDATE/);
        assert.equal(lockedUser, user.id);
        const previous = lockTail;
        lockTail = new Promise(resolve => { release = resolve; });
        await previous;
        calls.locks.push(lockedUser);
        return [{ id: lockedUser }];
      } };
      try { return await fn(tx); } finally { release?.(); }
    },
  };
  const sdk = {
    customers: { create: async (params, options) => {
      calls.customers.push({ params: clone(params), options: clone(options) });
      assert.ok(options?.idempotencyKey);
      if (!customerResources.has(options.idempotencyKey)) customerResources.set(options.idempotencyKey, { id: `cus_created_${++customerCount}` });
      await Promise.resolve();
      return clone(customerResources.get(options.idempotencyKey));
    } },
    subscriptions: { list: async params => { calls.subscriptions.push(clone(params)); return { data: clone(subscriptions), has_more: hasMore }; } },
    prices: { retrieve: async id => ({ id, active: true, type: 'recurring', livemode: false, unit_amount: id === 'price_old' ? 2900 : 1000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 }, metadata: { plan: 'PRO_MAX' }, product: { id: 'prod_pro', active: true } }) },
    checkout: { sessions: {
      create: async (params, options) => {
        calls.checkouts.push({ params: clone(params), options: clone(options) });
        assert.ok(options?.idempotencyKey);
        if (!checkoutResources.has(options.idempotencyKey)) checkoutResources.set(options.idempotencyKey, {
          id: `cs_new_${++checkoutCount}`, status: 'open', customer: params.customer,
          mode: 'subscription', currency: 'usd', amount_subtotal: 1000,
          metadata: clone(params.metadata), url: checkoutUrl || 'https://checkout.stripe.com/c/pay/cs_synthetic',
        });
        await Promise.resolve();
        return clone(checkoutResources.get(options.idempotencyKey));
      },
      retrieve: async id => { calls.retrieves.push(id); return clone(sessions[id] || [...checkoutResources.values()].find(session => session.id === id)); },
    } },
    billingPortal: {
      configurations: {
        list: async () => ({ data: clone(portalConfigurations), has_more: false }),
        create: async (params, options) => { calls.portalConfigs.push({ params: clone(params), options: clone(options) }); return { id: 'bpc_new', ...clone(params) }; },
      },
      sessions: { create: async params => { calls.portalSessions.push(clone(params)); return { url: portalUrl || 'https://billing.stripe.com/p/session/synthetic' }; } },
    },
  };
  const stripeService = new StripeService({ env: { NODE_ENV: 'test', STRIPE_SECRET_KEY: ['sk', 'test', 'A'.repeat(24)].join('_') }, stripeFactory: () => sdk, logger: { info() {}, warn() {}, error() {} } });
  const args = { prisma, stripeService, getPriceIdForPlan: async plan => { assert.equal(plan, 'PRO_MAX'); return 'price_current'; }, userId: user.id, env };
  return { user, payments, calls, customerResources, checkoutResources, args, checkout: () => createCustomerCheckout(args), portal: () => createCustomerPortal(args) };
}

const pending = changes => ({ id: 'pending_1', createdAt: new Date(), userId: 'owner', amount: 10, currency: 'USD', plan: 'PRO_MAX', provider: 'STRIPE', status: 'PENDING', stripeCustomerId: 'cus_owner', stripePriceId: 'price_current', metadata: { billingOrigin: 'https://siragpt.com' }, ...changes });
const openSession = changes => ({ id: 'cs_existing', status: 'open', customer: 'cus_owner', mode: 'subscription', currency: 'usd', amount_subtotal: 1000, metadata: { userId: 'owner', plan: 'PRO_MAX' }, url: 'https://checkout.stripe.com/c/pay/existing', ...changes });

test('new checkout uses advertised Pro price, authenticated owner and fixed redirect URLs', async () => {
  const h = harness();
  const result = await h.checkout();
  assert.equal(result.sessionId, 'cs_new_1');
  assert.equal(h.payments.length, 1);
  assert.equal(h.payments[0].amount, 10);
  assert.equal(h.payments[0].currency, 'USD');
  const { params, options } = h.calls.checkouts[0];
  assert.equal(params.customer, 'cus_owner');
  assert.deepEqual(params.line_items, [{ price: 'price_current', quantity: 1 }]);
  assert.equal(params.metadata.userId, 'owner');
  assert.equal(params.metadata.plan, 'PRO_MAX');
  assert.equal(params.success_url, 'https://siragpt.com/payment/success?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(params.cancel_url, 'https://siragpt.com/payment/cancel?plan=PRO_MAX');
  assert.equal(options.idempotencyKey, `sira-checkout-${h.payments[0].id}`);
});

test('concurrent first checkouts share one durable payment, customer and Stripe session', async () => {
  const h = harness({ user: { stripeCustomerId: null } });
  const results = await Promise.all([h.checkout(), h.checkout(), h.checkout()]);
  assert.equal(new Set(results.map(result => result.sessionId)).size, 1);
  assert.equal(h.payments.length, 1);
  assert.equal(h.customerResources.size, 1);
  assert.equal(h.checkoutResources.size, 1);
  assert.ok(h.calls.customers.every(call => call.options.idempotencyKey === 'sira-customer-owner'));
  assert.equal(new Set(h.calls.checkouts.map(call => call.options.idempotencyKey)).size, 1);
  assert.equal(h.calls.locks.length, 3);
});

test('an open pending session is reused without creating another payment or session', async () => {
  const h = harness({ payments: [pending({ stripeSessionId: 'cs_existing' })], sessions: { cs_existing: openSession() } });
  assert.equal((await h.checkout()).sessionId, 'cs_existing');
  assert.equal(h.calls.checkouts.length, 0);
  assert.equal(h.payments.length, 1);
  assert.deepEqual(h.calls.retrieves, ['cs_existing']);
});

test('an expired session is closed locally and the next deliberate attempt uses a new idempotency key', async () => {
  const h = harness({ payments: [pending({ stripeSessionId: 'cs_existing' })], sessions: { cs_existing: openSession({ status: 'expired', url: null }) } });
  await assert.rejects(h.checkout(), error => error.code === 'CHECKOUT_EXPIRED');
  assert.equal(h.payments[0].status, 'CANCELLED');
  assert.equal(h.calls.checkouts.length, 0);
  await h.checkout();
  assert.equal(h.payments.length, 2);
  assert.equal(h.calls.checkouts[0].options.idempotencyKey, 'sira-checkout-payment_2');
});

test('a completed session never starts a second checkout while fulfillment is pending', async () => {
  const h = harness({ payments: [pending({ stripeSessionId: 'cs_existing' })], sessions: { cs_existing: openSession({ status: 'complete', url: null }) } });
  await assert.rejects(h.checkout(), error => error.code === 'CHECKOUT_ALREADY_COMPLETED');
  assert.equal(h.calls.checkouts.length, 0);
  assert.equal(h.payments.length, 1);
});

test('existing subscriptions and incomplete provider inventory block duplicate purchases', async () => {
  for (const status of ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete']) {
    const h = harness({ subscriptions: [{ id: 'sub_existing', status }] });
    await assert.rejects(h.checkout(), error => error.code === 'SUBSCRIPTION_EXISTS');
    assert.equal(h.payments.length, 0);
    assert.equal(h.calls.checkouts.length, 0);
  }
  const h = harness({ hasMore: true });
  await assert.rejects(h.checkout(), error => error.code === 'SUBSCRIPTION_EXISTS');
});

test('pending attempts cannot bypass current price, currency, amount or customer ownership', async () => {
  for (const changes of [{ stripePriceId: 'price_old', amount: 29 }, { amount: 29 }, { currency: 'EUR' }, { stripeCustomerId: 'cus_foreign' }, { plan: 'PRO', amount: 5 }]) {
    const h = harness({ payments: [pending(changes)] });
    await assert.rejects(h.checkout(), error => error.code === 'CHECKOUT_REQUIRES_REVIEW', JSON.stringify(changes));
    assert.equal(h.calls.checkouts.length, 0);
  }
});

test('a sessionless attempt older than the provider idempotency window requires review', async () => {
  const h = harness({ payments: [pending({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })] });
  await assert.rejects(h.checkout(), error => error.code === 'CHECKOUT_REQUIRES_REVIEW');
  assert.equal(h.calls.checkouts.length, 0);
});

test('an existing provider session must match owner, subscription mode, plan and displayed amount', async () => {
  for (const changes of [
    { customer: 'cus_foreign' }, { mode: 'payment' }, { currency: 'eur' }, { amount_subtotal: 2900 },
    { metadata: { userId: 'other', plan: 'PRO_MAX' } }, { metadata: { userId: 'owner', plan: 'PRO' } },
  ]) {
    const h = harness({ payments: [pending({ stripeSessionId: 'cs_existing' })], sessions: { cs_existing: openSession(changes) } });
    await assert.rejects(h.checkout(), error => error.code === 'CHECKOUT_REQUIRES_REVIEW', JSON.stringify(changes));
    assert.equal(h.calls.checkouts.length, 0);
    assert.equal(h.payments.length, 1);
  }
});

test('portal binds the stored customer to a fixed return URL and restricted configuration', async () => {
  const h = harness();
  const result = await h.portal();
  assert.equal(result.url, 'https://billing.stripe.com/p/session/synthetic');
  assert.deepEqual(h.calls.portalSessions, [{ customer: 'cus_owner', configuration: 'bpc_safe', return_url: 'https://siragpt.com/billing', locale: 'es' }]);
  assert.equal(h.calls.portalConfigs.length, 0);
});

test('portal does not reuse a configuration that changes plan or cancels immediately', async () => {
  for (const feature of [
    { subscription_update: { enabled: true } },
    { subscription_cancel: { enabled: true, mode: 'immediately' } },
  ]) {
    const unsafe = safePortal();
    Object.assign(unsafe.features, feature);
    const h = harness({ portalConfigurations: [unsafe] });
    await h.portal();
    assert.equal(h.calls.portalConfigs.length, 1);
    const created = h.calls.portalConfigs[0].params;
    assert.equal(created.features.subscription_update.enabled, false);
    assert.deepEqual(created.features.subscription_cancel, { enabled: true, mode: 'at_period_end', proration_behavior: 'none' });
    assert.equal(created.default_return_url, 'https://siragpt.com/billing');
    assert.equal(h.calls.portalSessions[0].configuration, 'bpc_new');
  }
});

test('portal without a stored customer fails without creating Stripe resources', async () => {
  const h = harness({ user: { stripeCustomerId: null } });
  await assert.rejects(h.portal(), error => error.code === 'BILLING_CUSTOMER_NOT_FOUND' && error.statusCode === 404);
  assert.equal(h.calls.portalConfigs.length, 0);
  assert.equal(h.calls.portalSessions.length, 0);
  assert.equal(h.calls.customers.length, 0);
});

test('checkout and portal reject provider URLs outside their exact HTTPS origins', async () => {
  for (const value of ['http://checkout.stripe.com/c/pay/a', 'https://checkout.stripe.com.evil.example/', 'https://user:pass@checkout.stripe.com/', 'https://checkout.stripe.com:8443/']) {
    await assert.rejects(harness({ checkoutUrl: value }).checkout(), error => error.code === 'BILLING_REDIRECT_INVALID');
  }
  for (const value of ['http://billing.stripe.com/p/a', 'https://billing.stripe.com.evil.example/', 'https://user:pass@billing.stripe.com/', 'https://billing.stripe.com:8443/']) {
    await assert.rejects(harness({ portalUrl: value }).portal(), error => error.code === 'BILLING_REDIRECT_INVALID');
  }
});

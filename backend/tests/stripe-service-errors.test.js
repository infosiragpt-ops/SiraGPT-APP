'use strict';

const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');

const ORIGINAL_ENV = {
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  NODE_ENV: process.env.NODE_ENV,
  ALLOW_STRIPE_DEMO: process.env.ALLOW_STRIPE_DEMO,
};

process.env.STRIPE_SECRET_KEY = 'sk_test_validkey1234567890';
process.env.NODE_ENV = 'test';
delete process.env.ALLOW_STRIPE_DEMO;

const {
  StripeService,
  STRIPE_API_VERSION,
  sanitizeStripeError,
} = require('../src/services/stripe');

after(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function captureLogger() {
  const entries = [];
  return {
    entries,
    error(payload, message) { entries.push({ level: 'error', payload, message }); },
    warn(payload, message) { entries.push({ level: 'warn', payload, message }); },
    info(payload, message) { entries.push({ level: 'info', payload, message }); },
  };
}

function makeStripeAuthError() {
  const message = 'Invalid API Key provided: sk_live_testfixture';
  const err = new Error(message);
  err.name = 'StripeAuthenticationError';
  err.type = 'StripeAuthenticationError';
  err.statusCode = 401;
  err.requestId = 'req_stripe_123';
  err.raw = {
    message,
    type: 'invalid_request_error',
    statusCode: 401,
    headers: {
      authorization: 'Bearer should-never-log',
      'request-id': 'req_raw_456',
      'content-type': 'application/json',
    },
  };
  return err;
}

describe('StripeService error handling', () => {
  it('sends stable customer and caller-owned checkout idempotency keys to Stripe', async () => {
    const calls = [];
    const service = new StripeService({
      env: { NODE_ENV: 'test', STRIPE_SECRET_KEY: 'sk_test_synthetic_fixture' },
      logger: captureLogger(),
      stripeFactory: () => ({
        customers: { create: async (params, options) => { calls.push({ type: 'customer', params, options }); return { id: 'cus_fixture' }; } },
        checkout: { sessions: { create: async (params, options) => { calls.push({ type: 'checkout', params, options }); return { id: 'cs_fixture' }; } } },
      }),
    });
    await service.createCustomer('synthetic@example.test', 'Synthetic', 'user_fixture');
    await service.createCheckoutSession('price_fixture', 'cus_fixture', 'user_fixture', 'PRO_MAX', 'https://example.test/success', 'https://example.test/cancel', { idempotencyKey: 'sira-checkout-payment_fixture' });
    assert.deepEqual(calls[0].options, { idempotencyKey: 'sira-customer-user_fixture' });
    assert.deepEqual(calls[1].options, { idempotencyKey: 'sira-checkout-payment_fixture' });
    assert.equal(calls[1].params.mode, 'subscription');
    assert.equal(calls[0].params.metadata.application, 'siragpt');
    assert.equal(calls[1].params.metadata.application, 'siragpt');
    assert.equal(calls[1].params.subscription_data.metadata.application, 'siragpt');
  });

  it('only reuses an active monthly USD price with interval_count one', async () => {
    const valid = { id: 'price_valid', active: true, livemode: false, type: 'recurring', currency: 'usd', unit_amount: 1000, recurring: { interval: 'month', interval_count: 1 } };
    const invalid = [
      { ...valid, id: 'price_eur', currency: 'eur' },
      { ...valid, id: 'price_quarter', recurring: { interval: 'month', interval_count: 3 } },
      { ...valid, id: 'price_archived', active: false },
      { ...valid, id: 'price_other_mode', livemode: true },
    ];
    const service = new StripeService({
      env: { NODE_ENV: 'test', STRIPE_SECRET_KEY: 'sk_test_synthetic_fixture' },
      logger: captureLogger(),
      stripeFactory: () => ({ products: { list: async () => ({ data: [{ id: 'prod_fixture', metadata: { plan: 'PRO_MAX' } }] }) }, prices: { list: async () => ({ data: [...invalid, valid] }) } }),
    });
    assert.equal((await service.ensurePriceForPlan('PRO_MAX')).price.id, 'price_valid');
  });

  it('concurrent cold catalog setup shares one product and monthly USD price', async () => {
    const products = new Map();
    const prices = new Map();
    const requests = [];
    const create = (resources, prefix) => async (params, options) => {
      requests.push({ prefix, params, options });
      const key = options?.idempotencyKey || `unkeyed-${resources.size}`;
      if (!resources.has(key)) resources.set(key, { id: `${prefix}_${resources.size + 1}`, ...params });
      return resources.get(key);
    };
    const service = new StripeService({
      env: { NODE_ENV: 'test', STRIPE_SECRET_KEY: 'sk_test_synthetic_fixture' },
      logger: captureLogger(),
      stripeFactory: () => ({
        products: { list: async () => ({ data: [] }), create: create(products, 'prod') },
        prices: { list: async () => ({ data: [] }), create: create(prices, 'price') },
      }),
    });
    const results = await Promise.all([1, 2, 3].map(() => service.ensurePriceForPlan('PRO_MAX')));
    assert.equal(products.size, 1, 'cold concurrent requests must share a product idempotency key');
    assert.equal(prices.size, 1, 'cold concurrent requests must share a price idempotency key');
    assert.equal(new Set(results.map(result => result.price.id)).size, 1);
    for (const request of requests) {
      assert.deepEqual(request.options, { idempotencyKey: request.prefix === 'prod'
        ? 'sira-product-PRO_MAX-v1' : 'sira-price-prod_1-PRO_MAX-1000-usd-month-v1' });
      if (request.prefix === 'price') {
        assert.equal(request.params.unit_amount, 1000);
        assert.equal(request.params.currency, 'usd');
        assert.equal(request.params.recurring.interval, 'month');
      }
    }
  });

  it('validates cached prices against the current account and catalogue before checkout', async () => {
    let returnedPrice = { id: 'price_cached', active: true, livemode: false, type: 'recurring', currency: 'usd', unit_amount: 1000, recurring: { interval: 'month', interval_count: 1 } };
    const service = new StripeService({
      env: { NODE_ENV: 'test', STRIPE_SECRET_KEY: 'sk_test_synthetic_fixture' },
      logger: captureLogger(),
      stripeFactory: () => ({ prices: { retrieve: async id => { assert.equal(id, 'price_cached'); return returnedPrice; } } }),
    });
    assert.equal((await service.validatePriceForPlan('price_cached', 'PRO_MAX')).id, 'price_cached');
    for (const wrong of [{ currency: 'eur' }, { unit_amount: 2000 }, { active: false }, { livemode: true }, { recurring: { interval: 'year', interval_count: 1 } }]) {
      const original = returnedPrice;
      returnedPrice = { ...original, ...wrong };
      await assert.rejects(() => service.validatePriceForPlan('price_cached', 'PRO_MAX'), { code: 'STRIPE_PRICE_MISMATCH' });
      returnedPrice = original;
    }
  });

  it('uses the supported invoice preview API without an obsolete SDK method', async () => {
    let seen;
    const service = new StripeService({
      env: { NODE_ENV: 'test', STRIPE_SECRET_KEY: 'sk_test_synthetic_fixture' },
      logger: captureLogger(),
      stripeFactory: () => ({ invoices: { createPreview: async params => { seen = params; return { id: 'upcoming_in_fixture' }; } } }),
    });
    assert.equal((await service.getUpcomingInvoice('cus_fixture')).id, 'upcoming_in_fixture');
    assert.deepEqual(seen, { customer: 'cus_fixture' });
  });

  it('uses the current Stripe API version when creating the SDK client', () => {
    let configSeen = null;
    const service = new StripeService({
      env: { NODE_ENV: 'test', STRIPE_SECRET_KEY: 'sk_test_validkey1234567890' },
      logger: captureLogger(),
      stripeFactory: (_secret, config) => {
        configSeen = config;
        return { products: { list: async () => ({ data: [] }) } };
      },
    });

    assert.equal(service.isConfigured, true);
    assert.equal(configSeen.apiVersion, STRIPE_API_VERSION);
  });

  it('treats masked Stripe keys as unconfigured and never builds a client', () => {
    const logger = captureLogger();
    let factoryCalled = false;
    const service = new StripeService({
      env: { NODE_ENV: 'production', STRIPE_SECRET_KEY: 'sk_live_****************tlKU' },
      logger,
      stripeFactory: () => {
        factoryCalled = true;
        return {};
      },
    });

    assert.equal(service.isConfigured, false);
    assert.equal(service.configurationState, 'invalid');
    assert.equal(factoryCalled, false);
    assert.match(JSON.stringify(logger.entries), /masked|redacted/i);
  });

  it('logs Stripe auth failures without raw headers or API keys', async () => {
    const logger = captureLogger();
    const authError = makeStripeAuthError();
    const service = new StripeService({
      env: { NODE_ENV: 'production', STRIPE_SECRET_KEY: 'sk_live_unitfixture' },
      logger,
      stripeFactory: () => ({
        customers: {
          create: async () => { throw authError; },
        },
      }),
    });

    await assert.rejects(
      () => service.createCustomer('user@example.com', 'Test User', 'user_1'),
      (err) => {
        assert.equal(err.isStripeOperationalError, true);
        assert.equal(err.code, 'STRIPE_AUTHENTICATION_FAILED');
        assert.equal(err.statusCode, 503);
        return true;
      },
    );

    assert.equal(service.isConfigured, false);
    const serialized = JSON.stringify(logger.entries);
    assert.doesNotMatch(serialized, /sk_live_testfixture/);
    assert.doesNotMatch(serialized, /authorization/i);
    assert.doesNotMatch(serialized, /Bearer should-never-log/);
    assert.doesNotMatch(serialized, /headers/);
    assert.match(serialized, /stripe-key-redacted/);
  });

  it('builds public HTTP errors without leaking provider secrets', () => {
    const service = new StripeService({
      env: { NODE_ENV: 'production', STRIPE_SECRET_KEY: 'sk_live_unitfixture' },
      logger: captureLogger(),
      stripeFactory: () => ({ products: { list: async () => ({ data: [] }) } }),
    });

    const response = service.toHttpError(makeStripeAuthError(), {
      operation: 'createCustomer',
      requestId: 'req_public_1',
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'STRIPE_AUTHENTICATION_FAILED');
    assert.equal(response.body.requestId, 'req_public_1');
    assert.doesNotMatch(JSON.stringify(response), /sk_live_/);
  });

  it('sanitizes standalone Stripe error summaries', () => {
    const summary = sanitizeStripeError(makeStripeAuthError());
    const serialized = JSON.stringify(summary);
    assert.match(serialized, /stripe-key-redacted/);
    assert.doesNotMatch(serialized, /authorization/i);
    assert.doesNotMatch(serialized, /Bearer should-never-log/);
  });

  it('redacts Stripe keys even when Stripe already masked them with asterisks', () => {
    const err = new Error('Invalid API Key provided: sk_live_****************tlKU');
    err.name = 'StripeAuthenticationError';
    err.type = 'StripeAuthenticationError';

    const serialized = JSON.stringify(sanitizeStripeError(err));
    assert.match(serialized, /stripe-key-redacted/);
    assert.doesNotMatch(serialized, /tlKU/);
    assert.doesNotMatch(serialized, /sk_live_/);
  });
});

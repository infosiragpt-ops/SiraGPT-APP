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

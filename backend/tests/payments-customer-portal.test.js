'use strict';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_STORE = 'memory';
process.env.RATE_LIMIT_SENSITIVE_POLICY = 'memory';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const prisma = require('../src/config/database');
const { buildRouteTestApp, installAuthSessionMock, reloadModule, mockResolvedModule } = require('./http-test-utils');
const STRIPE_PATH = require.resolve('../src/services/stripe');
const PAYMENTS_PATH = require.resolve('../src/routes/payments');
let counter = 0;

describe('customer portal HTTP authorization and redirects', () => {
  let auth;
  let restoreStripe;
  let originalFindUnique;
  let originalOrigin;
  let calls;
  let providerUrl;

  beforeEach(() => {
    auth = installAuthSessionMock({ id: `portal-owner-${++counter}`, plan: 'PRO_MAX', stripeCustomerId: 'cus_authenticated_owner' });
    originalOrigin = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = 'https://siragpt.com';
    originalFindUnique = prisma.user.findUnique;
    calls = { userReads: [], sessions: [], configurations: 0 };
    providerUrl = 'https://billing.stripe.com/p/session/synthetic';
    prisma.user.findUnique = async ({ where }) => {
      calls.userReads.push(where);
      return where.id === auth.user.id ? { ...auth.user } : null;
    };
    restoreStripe = mockResolvedModule(STRIPE_PATH, {
      isConfigured: true, demoAllowed: false,
      callStripe: async (_operation, fn) => fn(),
      toHttpError: () => ({ statusCode: 502, body: { code: 'STRIPE_REQUEST_FAILED', message: 'No se pudo abrir facturación.' } }),
      isStripeLikeError: () => false,
      stripe: { billingPortal: {
        configurations: {
          list: async () => ({ data: [{ id: 'bpc_owned', metadata: { siragpt_billing: 'v1' }, features: {
            subscription_update: { enabled: false }, subscription_cancel: { enabled: true, mode: 'at_period_end' },
            payment_method_update: { enabled: true }, invoice_history: { enabled: true },
          } }], has_more: false }),
          create: async () => { calls.configurations++; throw new Error('unexpected configuration creation'); },
        },
        sessions: { create: async params => { calls.sessions.push(params); return { url: providerUrl }; } },
      } },
    });
    delete require.cache[PAYMENTS_PATH];
  });

  afterEach(() => {
    auth.restore();
    restoreStripe();
    prisma.user.findUnique = originalFindUnique;
    if (originalOrigin === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = originalOrigin;
    delete require.cache[PAYMENTS_PATH];
  });

  function post(body = {}, authenticated = true) {
    const app = buildRouteTestApp('/payments', reloadModule('../src/routes/payments'));
    const action = request(app).post('/payments/portal');
    if (authenticated) action.set('Authorization', auth.authHeader);
    return action.send(body);
  }

  test('unauthenticated callers cannot read a customer or create a portal session', async () => {
    const res = await post({}, false);
    assert.equal(res.status, 401);
    assert.equal(calls.userReads.length, 0);
    assert.equal(calls.sessions.length, 0);
  });

  test('foreign customer IDs, return URLs and portal flows in the body are ignored', async () => {
    const res = await post({
      userId: 'foreign-user', customer: 'cus_foreign', stripeCustomerId: 'cus_foreign',
      configuration: 'bpc_foreign', return_url: 'https://evil.example/', returnUrl: 'https://evil.example/',
      flow_data: { type: 'subscription_update', subscription_update: { subscription: 'sub_foreign' } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(res.body, { url: providerUrl });
    assert.deepEqual(calls.userReads, [{ id: auth.user.id }]);
    assert.deepEqual(calls.sessions, [{ customer: 'cus_authenticated_owner', configuration: 'bpc_owned', return_url: 'https://siragpt.com/billing', locale: 'es' }]);
    assert.equal(calls.configurations, 0);
  });

  test('a missing billing customer returns an actionable 404 without creating anything', async () => {
    auth.user.stripeCustomerId = null;
    const res = await post({ stripeCustomerId: 'cus_foreign' });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'BILLING_CUSTOMER_NOT_FOUND');
    assert.match(res.body.message, /Planes/);
    assert.equal(calls.sessions.length, 0);
    assert.equal(calls.configurations, 0);
  });

  test('a provider URL pointing elsewhere never becomes a browser redirect', async () => {
    providerUrl = 'https://billing.stripe.com.evil.example/p/steal';
    const res = await post();
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'BILLING_REDIRECT_INVALID');
    assert.equal(res.body.url, undefined);
    assert.equal(res.headers.location, undefined);
    assert.equal(JSON.stringify(res.body).includes('evil.example'), false);
  });
});

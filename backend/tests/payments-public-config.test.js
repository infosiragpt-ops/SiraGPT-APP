'use strict';

/**
 * Public payments configuration + checkout-unavailable contract.
 *
 * The /planes page reads GET /api/payments/config at runtime to decide
 * whether to send the user to Stripe Checkout or to WhatsApp, and to learn
 * the sales number without a frontend rebuild. These tests pin:
 *   · the response shape (no secrets, only booleans + public number)
 *   · WhatsApp number normalisation (SIRAGPT_WHATSAPP_NUMBER wins, digits only)
 *   · POST /stripe answering 503 in Spanish (with code + number) when the
 *     Stripe key is absent, instead of the old English "demo mode" text.
 */

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_STORE = 'memory';
process.env.RATE_LIMIT_SENSITIVE_POLICY = 'memory';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
  mockResolvedModule,
} = require('./http-test-utils');

const STRIPE_PATH = require.resolve('../src/services/stripe');
const PAYMENTS_PATH = require.resolve('../src/routes/payments');

const ENV_KEYS = ['SIRAGPT_WHATSAPP_NUMBER', 'NEXT_PUBLIC_WHATSAPP_NUMBER'];

function withEnv(values, fn) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

describe('payments · public config + checkout availability', () => {
  let restoreStripe;
  let stripeState;

  beforeEach(() => {
    stripeState = { isConfigured: false, demoAllowed: false };
    restoreStripe = mockResolvedModule(STRIPE_PATH, {
      get isConfigured() { return stripeState.isConfigured; },
      get demoAllowed() { return stripeState.demoAllowed; },
      isStripeLikeError: () => false,
      plans: { PRO: {}, PRO_MAX: {}, ENTERPRISE: {} },
    });
    delete require.cache[PAYMENTS_PATH];
  });

  afterEach(() => {
    restoreStripe();
    delete require.cache[PAYMENTS_PATH];
  });

  function app() {
    return buildRouteTestApp('/payments', reloadModule('../src/routes/payments'));
  }

  test('GET /config is public and reports checkout OFF + no number when nothing is configured', async () => {
    await withEnv({}, async () => {
      const res = await request(app()).get('/payments/config');
      assert.equal(res.status, 200);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.body.stripeConfigured, false);
      assert.equal(res.body.checkoutAvailable, false);
      assert.equal(res.body.whatsappNumber, null);
      assert.deepEqual(res.body.paidPlan, {
        code: 'PRO_MAX',
        name: 'Pro',
        priceUsd: 10,
        interval: 'month',
        currency: 'usd',
      });
      assert.equal(res.body.contactPlan.name, 'Hablemos');
      assert.equal(res.body.contactPlan.channel, 'support');
      // Never leak anything that looks like a key.
      assert.equal(JSON.stringify(res.body).includes('sk_'), false);
    });
  });

  test('GET /config reports checkout ON and the normalised sales number', async () => {
    stripeState.isConfigured = true;
    await withEnv({ SIRAGPT_WHATSAPP_NUMBER: '+51 999 123 456' }, async () => {
      const res = await request(app()).get('/payments/config');
      assert.equal(res.status, 200);
      assert.equal(res.body.stripeConfigured, true);
      assert.equal(res.body.checkoutAvailable, true);
      assert.equal(res.body.whatsappNumber, '51999123456');
      assert.equal(res.body.contactPlan.channel, 'whatsapp');
    });
  });

  test('SIRAGPT_WHATSAPP_NUMBER wins over NEXT_PUBLIC_WHATSAPP_NUMBER; too-short numbers are rejected', async () => {
    const { salesWhatsAppNumber } = reloadModule('../src/routes/payments');
    assert.equal(
      salesWhatsAppNumber({ SIRAGPT_WHATSAPP_NUMBER: '51 911 111 111', NEXT_PUBLIC_WHATSAPP_NUMBER: '51900000000' }),
      '51911111111',
    );
    assert.equal(salesWhatsAppNumber({ NEXT_PUBLIC_WHATSAPP_NUMBER: '(51) 900-000-000' }), '51900000000');
    assert.equal(salesWhatsAppNumber({ SIRAGPT_WHATSAPP_NUMBER: '12345' }), null);
    assert.equal(salesWhatsAppNumber({}), null);
  });

  test('POST /stripe answers 503 in Spanish with a machine code and the WhatsApp number when Stripe is off', async () => {
    const auth = installAuthSessionMock({ plan: 'FREE' });
    try {
      await withEnv({ SIRAGPT_WHATSAPP_NUMBER: '51999123456' }, async () => {
        const res = await request(app())
          .post('/payments/stripe')
          .set('Authorization', auth.authHeader)
          .send({ plan: 'PRO_MAX' });
        assert.equal(res.status, 503);
        assert.equal(res.body.code, 'STRIPE_NOT_CONFIGURED');
        assert.equal(res.body.fallbackAvailable, true);
        assert.equal(res.body.whatsappNumber, '51999123456');
        assert.match(res.body.message, /WhatsApp/);
        assert.doesNotMatch(res.body.message, /demo mode/i);
      });
    } finally {
      auth.restore();
    }
  });

  test('POST /stripe still validates the plan before touching Stripe', async () => {
    const auth = installAuthSessionMock({ plan: 'FREE' });
    try {
      const res = await request(app())
        .post('/payments/stripe')
        .set('Authorization', auth.authHeader)
        .send({ plan: 'FREE' });
      assert.equal(res.status, 400);
      assert.ok(Array.isArray(res.body.errors));
    } finally {
      auth.restore();
    }
  });
});

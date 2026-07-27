'use strict';

/**
 * Chaos: Stripe webhook with a bad signature — exercised against the REAL
 * `/payments/stripe/webhook` route (not a local re-implementation).
 *
 * The route does:
 *   try { event = stripeService.constructWebhookEvent(req.body, sig); }
 *   catch (err) {
 *     const r = stripeService.toHttpError(err, {...});
 *     return res.status(r.statusCode).send(`Webhook Error: ${r.body.message}`);
 *   }
 *   switch (event.type) { … }  res.json({ received: true });
 *
 * We mock only the Stripe SDK seam (constructWebhookEvent / toHttpError) plus
 * prisma + posthog so no network/DB is touched, and assert the route's real
 * behavior: bad signature → 400 with the `Webhook Error:` prefix and no secret
 * leak; valid event → 200 { received: true }.
 */

const assert = require('node:assert/strict');
const { describe, it, afterEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const Stripe = require('stripe');

const {
  buildRouteTestApp,
  reloadModule,
  mockResolvedModule,
} = require('../http-test-utils');
const { requireCsrf } = require('../../src/middleware/csrf');
const { createInputSanitizer } = require('../../src/middleware/input-sanitizer');
const xssSanitize = require('../../src/middleware/xss-sanitize');
const {
  STRIPE_WEBHOOK_PATH,
  createPaymentsCsrfMiddleware,
  createStripeWebhookRawBodyMiddleware,
} = require('../../src/middleware/stripe-webhook-ingress');

const DB_PATH = require.resolve('../../src/config/database');
const STRIPE_PATH = require.resolve('../../src/services/stripe');
const POSTHOG_PATH = require.resolve('../../src/services/observability/posthog');

let restores = [];

function setup(stripeStub) {
  restores = [
    mockResolvedModule(DB_PATH, { /* no DB op reached on these paths */ }),
    mockResolvedModule(STRIPE_PATH, stripeStub),
    mockResolvedModule(POSTHOG_PATH, { capturePostHogEvent: () => {} }),
  ];
  delete require.cache[require.resolve('../../src/routes/payments')];
  // reloadModule resolves relative to http-test-utils.js (in tests/), so this
  // path is tests/-relative — both resolve to the same absolute module.
  return buildRouteTestApp('/payments', reloadModule('../src/routes/payments'));
}

function post(app, sig) {
  const r = request(app).post('/payments/stripe/webhook').set('Content-Type', 'application/json');
  if (sig !== undefined) r.set('stripe-signature', sig);
  return r.send(Buffer.from('{}'));
}

describe('chaos: Stripe webhook bad signature (real route)', () => {
  afterEach(() => {
    restores.forEach((fn) => fn());
    restores = [];
    delete require.cache[require.resolve('../../src/routes/payments')];
  });

  it('returns 400 with the Webhook Error prefix and no secret leak when verification throws', async () => {
    const app = setup({
      constructWebhookEvent: () => {
        const err = new Error('No signatures found matching the expected signature for payload.');
        err.type = 'StripeSignatureVerificationError';
        throw err;
      },
      toHttpError: (err) => ({ statusCode: 400, body: { message: err.message } }),
    });
    const res = await post(app, 't=1,v1=deadbeef');
    assert.equal(res.status, 400);
    assert.match(res.text, /^Webhook Error:/);
    assert.ok(!/STRIPE_WEBHOOK_SECRET/.test(res.text), 'response must not leak the secret name');
    assert.ok(!/sk_(live|test)_/.test(res.text), 'response must not leak an API key');
  });

  it('returns 400 when the signature header is missing', async () => {
    const app = setup({
      constructWebhookEvent: (_payload, sig) => {
        if (!sig) throw new Error('Missing stripe-signature header');
        return { type: 'noop' };
      },
      toHttpError: (err) => ({ statusCode: 400, body: { message: err.message } }),
    });
    const res = await post(app, undefined);
    assert.equal(res.status, 400);
    assert.match(res.text, /Missing stripe-signature/);
  });

  it('returns 200 { received: true } for a verified (unhandled) event', async () => {
    const app = setup({
      constructWebhookEvent: () => ({ type: 'some.unhandled.event', data: { object: {} } }),
    });
    const res = await post(app, 't=1,v1=good');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { received: true });
  });
});

const WEBHOOK_SECRET = 'whsec_test_ingress_contract';
const stripe = new Stripe('sk_test_webhook_ingress_contract');
const previousCsrfDisabled = process.env.CSRF_DISABLED;
const previousWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

function signedHeader(payload) {
  return stripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
    timestamp: Math.floor(Date.now() / 1000),
  });
}

function buildProductionOrderApp({ paymentRouter = null } = {}) {
  const app = express();

  // Keep this order identical to index.js: exact webhook raw parser first,
  // generic JSON parser second, then the payments-scoped CSRF selector.
  app.use(createStripeWebhookRawBodyMiddleware());
  app.use(express.json({ limit: '50mb' }));
  app.use(cookieParser());
  app.use(createInputSanitizer({ mode: 'block' }));
  app.use('/api/payments', createPaymentsCsrfMiddleware(requireCsrf));
  app.use(xssSanitize);

  app.post(`${STRIPE_WEBHOOK_PATH}/child`, (req, res) => {
    res.json({ isBuffer: Buffer.isBuffer(req.body), body: req.body });
  });
  app.post('/api/payments/create-checkout', (_req, res) => res.json({ reached: true }));
  app.get(STRIPE_WEBHOOK_PATH, (req, res) => res.json({ isBuffer: Buffer.isBuffer(req.body) }));
  if (paymentRouter) {
    app.use('/api/payments', paymentRouter);
  } else {
    app.post(STRIPE_WEBHOOK_PATH, (req, res) => {
      assert.equal(Buffer.isBuffer(req.body), true, 'signature verifier must receive raw bytes');
      const verified = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        WEBHOOK_SECRET,
      );
      res.json({ id: verified.id, type: verified.type });
    });
  }
  return app;
}

afterEach(() => {
  if (previousCsrfDisabled === undefined) delete process.env.CSRF_DISABLED;
  else process.env.CSRF_DISABLED = previousCsrfDisabled;
  if (previousWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = previousWebhookSecret;
  delete require.cache[require.resolve('../../src/routes/payments')];
  delete require.cache[STRIPE_PATH];
});

describe('production Stripe webhook ingress order', () => {
  it('index.js wires exact raw parsing before JSON and the scoped CSRF selector', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
    const rawIndex = source.indexOf('app.use(createStripeWebhookRawBodyMiddleware());');
    const jsonIndex = source.indexOf("app.use(express.json({ limit: '50mb' }));");
    const csrfIndex = source.indexOf(
      "app.use('/api/payments', createPaymentsCsrfMiddleware(requireCsrf));",
    );

    assert.ok(rawIndex >= 0, 'production must mount the exact raw-body selector');
    assert.ok(jsonIndex > rawIndex, 'raw-body selector must run before generic JSON parsing');
    assert.ok(csrfIndex > jsonIndex, 'payments CSRF selector must run after body/cookie parsing');
    assert.doesNotMatch(
      source,
      /app\.use\(['"]\/api\/payments\/stripe\/webhook['"],\s*express\.raw/,
      'prefix-mounted raw parsing would also capture child paths',
    );
  });

  it('exact POST preserves raw bytes and accepts a real Stripe signature without CSRF', async () => {
    delete process.env.CSRF_DISABLED;
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    delete require.cache[require.resolve('../../src/routes/payments')];
    delete require.cache[STRIPE_PATH];
    const app = buildProductionOrderApp({
      paymentRouter: require('../../src/routes/payments'),
    });
    const payload = JSON.stringify({
      id: 'evt_raw_body_1',
      type: 'customer.tax_id.created',
      data: { object: { id: 'txi_1' } },
    });

    const response = await request(app)
      .post(`${STRIPE_WEBHOOK_PATH}?delivery=retry`)
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signedHeader(payload))
      .send(payload);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { received: true });
  });

  it('only the exact POST is exempt; sibling payment paths remain CSRF protected', async () => {
    delete process.env.CSRF_DISABLED;
    const app = buildProductionOrderApp();

    const child = await request(app)
      .post(`${STRIPE_WEBHOOK_PATH}/child`)
      .set('Content-Type', 'application/json')
      .send({ test: true });
    const checkout = await request(app)
      .post('/api/payments/create-checkout')
      .set('Content-Type', 'application/json')
      .send({ plan: 'PRO' });
    const trailingSlash = await request(app)
      .post(`${STRIPE_WEBHOOK_PATH}/`)
      .set('Content-Type', 'application/json')
      .send({ test: true });

    assert.equal(child.status, 403);
    assert.equal(child.body.error, 'csrf_invalid');
    assert.equal(checkout.status, 403);
    assert.equal(checkout.body.error, 'csrf_invalid');
    assert.equal(trailingSlash.status, 403);
    assert.equal(trailingSlash.body.error, 'csrf_invalid');
  });

  it('raw parsing is scoped to exact POST, not child or GET requests', async () => {
    delete process.env.CSRF_DISABLED;
    const app = buildProductionOrderApp();

    const child = await request(app)
      .post(`${STRIPE_WEBHOOK_PATH}/child`)
      .set('Authorization', 'Bearer test-token')
      .set('Content-Type', 'application/json')
      .send({ test: true });
    const get = await request(app).get(STRIPE_WEBHOOK_PATH);

    assert.equal(child.status, 200);
    assert.equal(child.body.isBuffer, false);
    assert.deepEqual(child.body.body, { test: true });
    assert.equal(get.status, 200);
    assert.equal(get.body.isBuffer, false);
  });
});

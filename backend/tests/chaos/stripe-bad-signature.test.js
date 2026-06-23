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
const request = require('supertest');

const {
  buildRouteTestApp,
  reloadModule,
  mockResolvedModule,
} = require('../http-test-utils');

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

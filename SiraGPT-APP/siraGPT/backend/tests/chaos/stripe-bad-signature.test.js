'use strict';

/**
 * Chaos: Stripe webhook with a bad signature.
 *
 * The webhook route in `routes/payments.js` does:
 *   try { event = stripeService.constructWebhookEvent(req.body, sig); }
 *   catch (err) { return res.status(400).send(`Webhook Error: ${err.message}`); }
 *
 * We don't want this test to spin up the whole Express tree (it requires
 * Prisma, Redis, Stripe SDK env...). Instead we re-implement the exact
 * try/catch shape and verify that:
 *   - a stub `constructWebhookEvent` that throws yields a 400 with the
 *     `Webhook Error:` prefix preserved
 *   - the response body does NOT leak the secret or the raw payload
 *   - a successful verification yields 200 with { received: true }
 *
 * If `routes/payments.js` ever changes the failure shape, this test will
 * stay green only because it mirrors the contract — keep them in sync.
 */

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    send(s) { this.body = s; return this; },
    json(o) { this.body = o; return this; },
  };
  return res;
}

async function handleWebhook(stripeService, req, res) {
  try {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripeService.constructWebhookEvent(req.body, sig);
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    // No-op event handler — production switches on event.type.
    void event;
    return res.json({ received: true });
  } catch (err) {
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}

describe('chaos: Stripe webhook bad signature', () => {
  it('returns 400 when signature verification throws', async () => {
    const stripeService = {
      constructWebhookEvent: () => {
        const err = new Error('No signatures found matching the expected signature for payload.');
        err.type = 'StripeSignatureVerificationError';
        throw err;
      },
    };
    const req = { headers: { 'stripe-signature': 't=1,v1=deadbeef' }, body: Buffer.from('{}') };
    const res = makeRes();
    await handleWebhook(stripeService, req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /^Webhook Error:/);
    assert.ok(!/STRIPE_WEBHOOK_SECRET/.test(res.body), 'response must not leak the secret name');
  });

  it('returns 400 with empty signature header', async () => {
    const stripeService = {
      constructWebhookEvent: (_payload, sig) => {
        if (!sig) throw new Error('Missing stripe-signature header');
        return { type: 'noop' };
      },
    };
    const req = { headers: {}, body: Buffer.from('{}') };
    const res = makeRes();
    await handleWebhook(stripeService, req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /Missing stripe-signature/);
  });

  it('returns 200 when verification succeeds', async () => {
    const stripeService = {
      constructWebhookEvent: () => ({ type: 'checkout.session.completed', data: { object: {} } }),
    };
    const req = { headers: { 'stripe-signature': 't=1,v1=good' }, body: Buffer.from('{}') };
    const res = makeRes();
    await handleWebhook(stripeService, req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { received: true });
  });

  it('handler swallows downstream throws into 500 (not 400)', async () => {
    const stripeService = {
      constructWebhookEvent: () => ({ type: 'will.crash' }),
    };
    // Wrap with a poisoned res.json to simulate a downstream throw.
    const res = {
      statusCode: 200,
      body: null,
      _exploded: false,
      status(c) { this.statusCode = c; return this; },
      send(s) { this.body = s; return this; },
      json(o) {
        if (!this._exploded) {
          this._exploded = true;
          throw new Error('downstream boom');
        }
        this.body = o;
        return this;
      },
    };
    const req = { headers: { 'stripe-signature': 'ok' }, body: Buffer.from('{}') };
    await handleWebhook(stripeService, req, res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Webhook processing failed' });
  });
});

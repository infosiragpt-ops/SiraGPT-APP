'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-stripe');
const { extractStripe, buildStripeForFiles, renderStripeBlock, _internal } = engine;
const { maskId } = _internal;

const STRIPE_FIXTURE = `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_KEY);

// Create a customer
const customer = await stripe.customers.create({
  email: 'a@b.com',
  name: 'Alice',
});
// customer.id === 'cus_NffrFeUfNV2Hib'

// Create a payment intent
const pi = await stripe.paymentIntents.create({
  amount: 2000,
  currency: 'usd',
  customer: 'cus_NffrFeUfNV2Hib',
  payment_method: 'pm_1MqLiBLkdIwHu7ixUM4vG2hM',
});

await stripe.paymentIntents.confirm('pi_3MqLiBLkdIwHu7ix0Vqxv0jq', {
  payment_method: 'pm_card_visa',
});

// Subscription
const sub = await stripe.subscriptions.create({
  customer: 'cus_NffrFeUfNV2Hib',
  items: [{ price: 'price_1Mc6mfLkdIwHu7ix7vWJV6kM' }],
});

// Webhook event handling
if (event.type === 'payment_intent.succeeded') {
  console.log('payment succeeded');
}
if (event.type === 'customer.subscription.deleted') {
  console.log('sub cancelled');
}

// Charge methods
await stripe.charges.retrieve('ch_3MqLiBLkdIwHu7ix0xRrLwBd');
await stripe.charges.list({ limit: 10 });

// Refund
await stripe.refunds.create({ charge: 'ch_3MqLiBLkdIwHu7ix0xRrLwBd' });

// Test mode
const testCustomer = 'cus_test_NffrFeUfNV2Hib';
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractStripe('').total, 0);
  assert.equal(extractStripe(null).total, 0);
});

test('non-Stripe text returns empty', () => {
  const r = extractStripe('Just regular code without Stripe references');
  assert.equal(r.total, 0);
});

test('maskId truncates long IDs', () => {
  assert.equal(maskId('cus', 'NffrFeUfNV2Hib'), 'cus_…2Hib');
  assert.equal(maskId('pi', 'short'), 'pi_short');
});

test('detects customer IDs (cus_)', () => {
  const r = extractStripe(STRIPE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'customer' && /^cus_/.test(e.name)));
});

test('detects paymentIntent IDs (pi_)', () => {
  const r = extractStripe(STRIPE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'paymentIntent' && /^pi_/.test(e.name)));
});

test('detects charge IDs (ch_)', () => {
  const r = extractStripe(STRIPE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'charge' && /^ch_/.test(e.name)));
});

test('detects subscription IDs implicitly through resource', () => {
  const r = extractStripe(STRIPE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'resource' && e.name === 'stripe.subscriptions'));
});

test('detects price IDs (price_)', () => {
  const r = extractStripe(STRIPE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'price' && /^price_/.test(e.name)));
});

test('detects payment method IDs (pm_)', () => {
  const r = extractStripe(STRIPE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'paymentMethod' && /^pm_/.test(e.name)));
});

test('masks long IDs (does not emit full)', () => {
  const r = extractStripe(STRIPE_FIXTURE);
  const fullIds = r.entries.filter((e) => /^cus_NffrFeUfNV2Hib$/.test(e.name));
  assert.equal(fullIds.length, 0);
});

test('flags test-mode IDs', () => {
  const r = extractStripe(STRIPE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'customer' && e.detail === 'test'));
});

test('detects stripe.X resources', () => {
  const r = extractStripe(STRIPE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'resource' && e.name === 'stripe.customers'));
  assert.ok(r.entries.some((e) => e.kind === 'resource' && e.name === 'stripe.paymentIntents'));
  assert.ok(r.entries.some((e) => e.kind === 'resource' && e.name === 'stripe.charges'));
});

test('detects methods .create / .retrieve / .confirm / .list', () => {
  const r = extractStripe(STRIPE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'method' && e.name === '.create'));
  assert.ok(r.entries.some((e) => e.kind === 'method' && e.name === '.retrieve'));
  assert.ok(r.entries.some((e) => e.kind === 'method' && e.name === '.confirm'));
});

test('detects webhook events', () => {
  const r = extractStripe(STRIPE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'webhookEvent' && e.name === 'payment_intent.succeeded'));
});

test('dedupes identical objects', () => {
  const r = extractStripe('const a = "cus_NffrFeUfNV2Hib"; const b = "cus_NffrFeUfNV2Hib";');
  assert.equal(r.entries.filter((e) => e.kind === 'customer').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `"cus_NffrFeUfNV2Hi${i}", `;
  text += ' stripe.customers.create();';
  const r = extractStripe(text);
  assert.ok(r.entries.length <= 24);
});

test('counts totals by kind', () => {
  const r = extractStripe(STRIPE_FIXTURE);
  assert.ok(r.totals.customer >= 1);
  assert.ok(r.totals.paymentIntent >= 1);
  assert.ok(r.totals.resource >= 3);
  assert.ok(r.totals.method >= 3);
});

test('buildStripeForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.ts', extractedText: 'stripe.customers.create({}); "cus_aaaaaaaaaaaaaa"' },
    { name: 'b.ts', extractedText: 'stripe.charges.retrieve("ch_aaaaaaaaaaaaaa")' },
  ];
  const r = buildStripeForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderStripeBlock returns markdown when entries exist', () => {
  const files = [{ name: 'billing.ts', extractedText: STRIPE_FIXTURE }];
  const r = buildStripeForFiles(files);
  const md = renderStripeBlock(r);
  assert.match(md, /^## STRIPE/);
});

test('renderStripeBlock empty when nothing surfaces', () => {
  assert.equal(renderStripeBlock({ perFile: [] }), '');
  assert.equal(renderStripeBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildStripeForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: STRIPE_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});

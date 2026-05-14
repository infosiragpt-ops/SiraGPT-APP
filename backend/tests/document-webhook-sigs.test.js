'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-webhook-sigs');
const { extractWebhookSigs, buildWebhookSigsForFiles, renderWebhookSigsBlock, _internal } = engine;
const { isWebhookSigLike } = _internal;

const WEBHOOK_FIXTURE = `import crypto from 'crypto';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_KEY);

// Stripe webhook verification
function verifyStripeWebhook(req) {
  const sig = req.headers['stripe-signature'] || req.headers['Stripe-Signature'];
  return stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
}

// GitHub webhook verification
function verifyGithubSignature(req) {
  const signature = req.headers['x-hub-signature-256'] || req.headers['X-Hub-Signature-256'];
  const hmac = crypto.createHmac('sha256', process.env.GH_WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

// Slack webhook verification
function verifySlackRequest(req) {
  const timestamp = req.headers['X-Slack-Request-Timestamp'];
  const slackSig = req.headers['X-Slack-Signature'];
  const baseString = 'v0:' + timestamp + ':' + req.rawBody;
  const h = crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET);
  const computed = 'v0=' + h.update(baseString).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(slackSig));
}

// Shopify webhook verification
function verifyShopify(req) {
  const hmac = req.headers['X-Shopify-Hmac-SHA256'];
  const computed = crypto.createHmac('sha256', secret).update(req.rawBody).digest('base64');
  return computed === hmac;
}

// Twilio webhook
function verifyTwilio(req) {
  const sig = req.headers['X-Twilio-Signature'];
  return verifySignature(authToken, sig, url, req.body);
}

// Discord webhook (Ed25519)
function verifyDiscordRequest(req) {
  const signature = req.headers['X-Signature-Ed25519'];
  const timestamp = req.headers['X-Signature-Timestamp'];
  return nacl.sign.detached.verify(Buffer.from(timestamp + req.rawBody), signature, publicKey);
}
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractWebhookSigs('').total, 0);
  assert.equal(extractWebhookSigs(null).total, 0);
});

test('non-webhook text returns empty', () => {
  const r = extractWebhookSigs('Just regular text without webhooks');
  assert.equal(r.total, 0);
});

test('isWebhookSigLike heuristic', () => {
  assert.ok(isWebhookSigLike('crypto.createHmac("sha256", s)'));
  assert.ok(isWebhookSigLike('Stripe-Signature'));
  assert.ok(!isWebhookSigLike('plain text'));
});

test('detects Stripe-Signature header + provider', () => {
  const r = extractWebhookSigs(WEBHOOK_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'header' && /stripe-signature/i.test(e.name)));
  assert.ok(r.entries.some((e) => e.kind === 'provider' && e.name === 'stripe'));
});

test('detects X-Hub-Signature-256 + github provider', () => {
  const r = extractWebhookSigs(WEBHOOK_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'header' && /x-hub-signature-256/i.test(e.name)));
  assert.ok(r.entries.some((e) => e.kind === 'provider' && e.name === 'github'));
});

test('detects X-Slack-Signature + slack provider', () => {
  const r = extractWebhookSigs(WEBHOOK_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'provider' && e.name === 'slack'));
});

test('detects Shopify, Twilio, Discord providers', () => {
  const r = extractWebhookSigs(WEBHOOK_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'provider' && e.name === 'shopify'));
  assert.ok(r.entries.some((e) => e.kind === 'provider' && e.name === 'twilio'));
  assert.ok(r.entries.some((e) => e.kind === 'provider' && e.name === 'discord'));
});

test('detects HMAC algorithm (sha256)', () => {
  const r = extractWebhookSigs(WEBHOOK_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'hmacAlgo' && e.name === 'sha256'));
});

test('detects digest encoding (hex/base64)', () => {
  const r = extractWebhookSigs(WEBHOOK_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'digestEncoding' && e.name === 'hex'));
  assert.ok(r.entries.some((e) => e.kind === 'digestEncoding' && e.name === 'base64'));
});

test('detects crypto.timingSafeEqual', () => {
  const r = extractWebhookSigs(WEBHOOK_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'timingSafe'));
});

test('detects verifier function names', () => {
  const r = extractWebhookSigs(WEBHOOK_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'verifierFn' && /verifyShopify|verifyTwilio|verifySignature|verifySlackRequest/.test(e.name)));
});

test('detects stripe.webhooks.constructEvent', () => {
  const r = extractWebhookSigs(WEBHOOK_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'providerSdk' && /constructEvent/.test(e.name)));
});

test('detects nacl Ed25519 verification', () => {
  const r = extractWebhookSigs(WEBHOOK_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'edSig' && /nacl/.test(e.name)));
});

test('dedupes identical headers', () => {
  const r = extractWebhookSigs('Stripe-Signature: x\nStripe-Signature: y');
  assert.equal(r.entries.filter((e) => e.kind === 'header' && /stripe-signature/i.test(e.name)).length, 1);
});

test('caps entries per file', () => {
  let text = 'X-Hub-Signature-256\n';
  for (let i = 0; i < 50; i++) text += `crypto.createHmac('sha${256+i}', s)\n`;
  const r = extractWebhookSigs(text);
  assert.ok(r.entries.length <= 28);
});

test('counts totals by kind', () => {
  const r = extractWebhookSigs(WEBHOOK_FIXTURE);
  assert.ok(r.totals.header >= 5);
  assert.ok(r.totals.provider >= 4);
});

test('buildWebhookSigsForFiles aggregates across batch', () => {
  const files = [
    { name: 'stripe.ts', extractedText: 'Stripe-Signature: x\ncrypto.createHmac("sha256", s)' },
    { name: 'github.ts', extractedText: 'X-Hub-Signature-256: y\nverifySignature(req)' },
  ];
  const r = buildWebhookSigsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderWebhookSigsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'webhooks.ts', extractedText: WEBHOOK_FIXTURE }];
  const r = buildWebhookSigsForFiles(files);
  const md = renderWebhookSigsBlock(r);
  assert.match(md, /^## WEBHOOK/);
});

test('renderWebhookSigsBlock empty when nothing surfaces', () => {
  assert.equal(renderWebhookSigsBlock({ perFile: [] }), '');
  assert.equal(renderWebhookSigsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildWebhookSigsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: WEBHOOK_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});

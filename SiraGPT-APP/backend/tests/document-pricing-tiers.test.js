'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-pricing-tiers');
const { extractPricingTiers, buildPricingTiersForFiles, renderPricingTiersBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractPricingTiers('').total, 0);
  assert.equal(extractPricingTiers(null).total, 0);
});

test('detects "Pro plan"', () => {
  const r = extractPricingTiers('Choose the Pro plan for advanced features.');
  assert.ok(r.entries.some((e) => e.kind === 'tier' && /pro/.test(e.normalised)));
});

test('detects "Enterprise tier"', () => {
  const r = extractPricingTiers('The Enterprise tier offers SSO.');
  assert.ok(r.entries.some((e) => /enterprise/.test(e.normalised)));
});

test('detects Free tier', () => {
  const r = extractPricingTiers('Start with our Free plan.');
  assert.ok(r.entries.some((e) => /free/.test(e.normalised)));
});

test('detects price next to tier name', () => {
  const r = extractPricingTiers('Pro $20/user/month');
  assert.ok(r.entries.some((e) => /pro@20/.test(e.normalised)));
});

test('detects monthly billing', () => {
  const r = extractPricingTiers('Billed monthly');
  assert.ok(r.entries.some((e) => e.kind === 'billing'));
});

test('detects annual billing', () => {
  const r = extractPricingTiers('annual subscription');
  assert.ok(r.entries.some((e) => e.kind === 'billing'));
});

test('detects "per seat"', () => {
  const r = extractPricingTiers('Pricing: per seat model');
  assert.ok(r.entries.some((e) => e.kind === 'billing'));
});

test('detects free trial', () => {
  const r = extractPricingTiers('Start your 14-day free trial');
  assert.ok(r.entries.some((e) => e.kind === 'trial'));
});

test('detects "30 day trial"', () => {
  const r = extractPricingTiers('30 day trial available');
  assert.ok(r.entries.some((e) => e.kind === 'trial'));
});

test('detects "contact sales"', () => {
  const r = extractPricingTiers('Contact sales for enterprise pricing');
  assert.ok(r.entries.some((e) => e.kind === 'contactSales'));
});

test('detects "Business plan"', () => {
  const r = extractPricingTiers('Try our Business plan with team features.');
  assert.ok(r.entries.some((e) => /business/.test(e.normalised)));
});

test('dedupes identical entries', () => {
  const r = extractPricingTiers('Pro plan and Pro plan again');
  assert.equal(r.entries.filter((e) => /pro/.test(e.normalised) && !/@/.test(e.normalised)).length, 1);
});

test('caps entries per file', () => {
  let text = '';
  const tiers = ['Free', 'Starter', 'Pro', 'Plus', 'Premium', 'Business', 'Enterprise', 'Custom'];
  for (let i = 0; i < 20; i++) text += `${tiers[i % tiers.length]} plan `;
  const r = extractPricingTiers(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by kind', () => {
  const r = extractPricingTiers('Pro plan, billed monthly, 14-day free trial, contact sales');
  assert.ok(r.totals.tier >= 1);
  assert.ok(r.totals.billing >= 1);
  assert.ok(r.totals.trial >= 1);
  assert.ok(r.totals.contactSales >= 1);
});

test('buildPricingTiersForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'Pro plan' },
    { name: 'b', extractedText: 'Enterprise tier' },
  ];
  const r = buildPricingTiersForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderPricingTiersBlock returns markdown when entries exist', () => {
  const files = [{ name: 'pricing.html', extractedText: 'Pro plan $20/month' }];
  const r = buildPricingTiersForFiles(files);
  const md = renderPricingTiersBlock(r);
  assert.match(md, /^## PRICING TIERS/);
});

test('renderPricingTiersBlock empty when nothing surfaces', () => {
  assert.equal(renderPricingTiersBlock({ perFile: [] }), '');
  assert.equal(renderPricingTiersBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildPricingTiersForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Pro plan' },
  ]);
  assert.equal(r.perFile.length, 1);
});

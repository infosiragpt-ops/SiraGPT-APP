'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-pricing-extractor');
const { extractPricing, buildPricingForFiles, renderPricingBlock, _internal } = engine;
const { symbolToCurrency, detectCadence, splitSentences } = _internal;

test('empty / non-string input tolerated', () => {
  assert.equal(extractPricing('').total, 0);
  assert.equal(extractPricing(null).total, 0);
});

test('symbolToCurrency maps known symbols', () => {
  assert.equal(symbolToCurrency('$'), 'USD');
  assert.equal(symbolToCurrency('€'), 'EUR');
  assert.equal(symbolToCurrency('US$'), 'USD');
  assert.equal(symbolToCurrency('MXN'), 'MXN');
});

test('detectCadence: per hour / monthly / annual / per user / one-time', () => {
  assert.equal(detectCadence('Fees are billed per hour.'), 'per-hour');
  assert.equal(detectCadence('Charges apply monthly.'), 'monthly');
  assert.equal(detectCadence('Annual subscription.'), 'annual');
  assert.equal(detectCadence('Pricing is per user.'), 'per-user');
  assert.equal(detectCadence('A setup fee applies.'), 'one-time');
});

test('detectCadence: Spanish forms', () => {
  assert.equal(detectCadence('La tarifa es por hora.'), 'per-hour');
  assert.equal(detectCadence('Mensualmente se cobra el servicio.'), 'monthly');
  assert.equal(detectCadence('Es un pago único.'), 'one-time');
});

test('extracts $-anchored amount with cadence', () => {
  const text = 'The cloud platform costs $4,200 per month.';
  const r = extractPricing(text);
  assert.ok(r.items.length >= 1);
  assert.equal(r.items[0].currency, 'USD');
  assert.equal(r.items[0].cadence, 'monthly');
});

test('extracts currency-code amount', () => {
  const text = 'Service fees: USD 1,200 monthly.';
  const r = extractPricing(text);
  assert.ok(r.items.some((i) => i.currency === 'USD' && /1[,.]200/.test(i.amount)));
});

test('extracts Spanish pricing', () => {
  const text = 'La plataforma cuesta €4,200 mensual.';
  const r = extractPricing(text);
  assert.ok(r.items.some((i) => i.currency === 'EUR' && i.cadence === 'monthly'));
});

test('captures multiple items in same sentence', () => {
  const text = 'Setup fee $500 one-time, then $99 per month per user.';
  const r = extractPricing(text);
  assert.ok(r.items.length >= 2);
});

test('dedupes identical items', () => {
  const text = 'Service costs $99 per month. Service costs $99 per month.';
  const r = extractPricing(text);
  assert.equal(r.items.length, 1);
});

test('buildPricingForFiles aggregates across files', () => {
  const files = [
    { name: 'plan-a.md', extractedText: 'Pricing: $99 per month.' },
    { name: 'plan-b.md', extractedText: 'Premium: €199 monthly.' },
  ];
  const r = buildPricingForFiles(files);
  assert.equal(r.perFile.length, 2);
  assert.ok(r.aggregate.length >= 2);
});

test('renderPricingBlock returns markdown when items exist', () => {
  const files = [{ name: 'demo.md', extractedText: 'The platform costs $99 monthly.' }];
  const r = buildPricingForFiles(files);
  const md = renderPricingBlock(r);
  assert.match(md, /^## PRICING & FEES/);
});

test('renderPricingBlock empty when nothing surfaces', () => {
  assert.equal(renderPricingBlock({ perFile: [] }), '');
  assert.equal(renderPricingBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildPricingForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'Cost: $5.' }]);
  assert.ok(Array.isArray(r.perFile));
});

test('caps total items per file', () => {
  let text = '';
  for (let i = 1; i <= 30; i++) text += `Tier ${i} costs $${i * 10} monthly. `;
  const r = extractPricing(text);
  assert.ok(r.items.length <= 16);
});

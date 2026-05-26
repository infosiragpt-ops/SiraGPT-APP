'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { estimateCost, listFeatures, FEATURE_COSTS } = require('../src/services/feature-cost-estimator');

test('listFeatures: includes paraphrase + image_* + generate', () => {
  const f = listFeatures();
  assert.ok(f.includes('paraphrase'));
  assert.ok(f.includes('image_generation'));
  assert.ok(f.includes('image_variation'));
  assert.ok(f.includes('image_upscale'));
  assert.ok(f.includes('generate'));
});

test('estimateCost: unknown feature returns null', () => {
  assert.equal(estimateCost('mystery_feature'), null);
});

test('estimateCost: paraphrase respects minCost when text is empty', () => {
  const r = estimateCost('paraphrase', { textLength: 0 });
  assert.equal(r.credits, 1, 'min cost is 1 even with no text');
});

test('estimateCost: paraphrase scales with text length (1 credit / 1k chars)', () => {
  const r1k = estimateCost('paraphrase', { textLength: 1000 });
  const r5k = estimateCost('paraphrase', { textLength: 5000 });
  // base (1) + length cost (1 per 1k chars)
  assert.equal(r1k.credits, 2);
  assert.equal(r5k.credits, 6);
});

test('estimateCost: image_generation always >= minCost (5) regardless of payload', () => {
  assert.equal(estimateCost('image_generation', { textLength: 0 }).credits, 5);
  assert.equal(estimateCost('image_generation', { textLength: 50000 }).credits, 5);
});

test('estimateCost: env override changes perKChars (paraphrase)', () => {
  const r = estimateCost('paraphrase', {
    textLength: 1000,
    env: { CREDITS_PARAPHRASE_PER_1K_CHARS: '3' },
  });
  // base (1) + 3 per 1k chars
  assert.equal(r.credits, 4);
});

test('estimateCost: returns a breakdown for the UI to render', () => {
  const r = estimateCost('paraphrase', { textLength: 2000 });
  assert.ok(r.breakdown);
  assert.equal(r.breakdown.base, 1);
  assert.equal(r.breakdown.minCost, 1);
  assert.equal(r.breakdown.perKChars, 1);
});

test('FEATURE_COSTS is frozen — accidental mutation refused', () => {
  assert.ok(Object.isFrozen(FEATURE_COSTS));
});

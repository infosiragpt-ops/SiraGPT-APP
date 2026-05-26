'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { estimateCost, estimateCostBatch, listFeatures, FEATURE_COSTS } = require('../src/services/feature-cost-estimator');

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

test('estimateCostBatch: returns parallel estimates for valid features', () => {
  const out = estimateCostBatch([
    { feature: 'paraphrase', textLength: 1000 },
    { feature: 'image_generation' },
    { feature: 'image_upscale' },
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[0].feature, 'paraphrase');
  assert.equal(out[0].credits, 2);
  assert.equal(out[1].credits, 5);
  assert.equal(out[2].credits, 3);
});

test('estimateCostBatch: silently drops unknown features', () => {
  const out = estimateCostBatch([
    { feature: 'paraphrase', textLength: 0 },
    { feature: 'mystery_feature' },
    { feature: 'image_generation' },
  ]);
  assert.equal(out.length, 2);
  assert.ok(!out.find((r) => r.feature === 'mystery_feature'));
});

test('estimateCostBatch: non-array input returns []', () => {
  assert.deepEqual(estimateCostBatch(null), []);
  assert.deepEqual(estimateCostBatch('not an array'), []);
});

test('estimateCostBatch: env override applies to all batch items', () => {
  const out = estimateCostBatch(
    [
      { feature: 'paraphrase', textLength: 1000 },
      { feature: 'paraphrase', textLength: 2000 },
    ],
    { env: { CREDITS_PARAPHRASE_PER_1K_CHARS: '4' } },
  );
  // base (1) + length × 4 per 1k chars
  assert.equal(out[0].credits, 5);
  assert.equal(out[1].credits, 9);
});

test('estimateCostBatch: items with missing/null feature dropped', () => {
  const out = estimateCostBatch([
    { feature: 'paraphrase' },
    { feature: null },
    {},
    null,
  ]);
  assert.equal(out.length, 1);
});

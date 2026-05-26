'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { estimateCost, estimateCostBatch, estimateMonthlyCost, getRecommendedPlan, getCostDelta, listFeatures, FEATURE_COSTS, PLAN_BUDGETS, PLAN_PRICES_USD } = require('../src/services/feature-cost-estimator');

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

test('estimateMonthlyCost: typical user usage projection', () => {
  const result = estimateMonthlyCost({
    paraphrase: { calls: 10, avgTextLength: 2000 },     // 10 × (1+2) = 30 credits
    image_generation: { calls: 5 },                       // 5 × 5 = 25 credits
    image_upscale: { calls: 3 },                          // 3 × 3 = 9 credits
  });
  assert.equal(result.totalMonthly, 64);
  assert.equal(result.perFeature.paraphrase.monthlyCredits, 30);
  assert.equal(result.perFeature.image_generation.monthlyCredits, 25);
  assert.equal(result.perFeature.image_upscale.monthlyCredits, 9);
});

test('estimateMonthlyCost: zero calls / missing usage returns 0 + skip', () => {
  const result = estimateMonthlyCost({
    paraphrase: { calls: 0, avgTextLength: 5000 },
    image_generation: { calls: 0 },
  });
  assert.equal(result.totalMonthly, 0);
  assert.deepEqual(result.perFeature, {});
});

test('estimateMonthlyCost: null/garbage input returns empty projection', () => {
  assert.deepEqual(estimateMonthlyCost(null), { totalMonthly: 0, perFeature: {} });
  assert.deepEqual(estimateMonthlyCost('garbage'), { totalMonthly: 0, perFeature: {} });
  assert.deepEqual(estimateMonthlyCost({}), { totalMonthly: 0, perFeature: {} });
});

test('getRecommendedPlan: no usage → FREE', () => {
  const r = getRecommendedPlan({});
  assert.equal(r.plan, 'FREE');
  assert.equal(r.monthlyCredits, 0);
});

test('getRecommendedPlan: small usage → PRO', () => {
  const r = getRecommendedPlan({
    paraphrase: { calls: 100, avgTextLength: 1000 },
  });
  // 100 × (1+1) = 200 → fits in PRO (100k)
  assert.equal(r.plan, 'PRO');
});

test('getRecommendedPlan: medium usage → PRO_MAX', () => {
  // 50_000 calls × 3 = 150_000 credits → exceeds PRO (100k), fits PRO_MAX (300k)
  const r = getRecommendedPlan({
    paraphrase: { calls: 50000, avgTextLength: 2000 },
  });
  assert.equal(r.plan, 'PRO_MAX');
});

test('getRecommendedPlan: huge usage → ENTERPRISE', () => {
  // 100_000 calls × 11 = 1_100_000 credits → exceeds PRO_MAX (300k)
  const r = getRecommendedPlan({
    paraphrase: { calls: 100000, avgTextLength: 10000 },
  });
  assert.equal(r.plan, 'ENTERPRISE');
});

test('getCostDelta: FREE → PRO is +$5 upgrade', () => {
  const d = getCostDelta('FREE', 'PRO');
  assert.equal(d.deltaUsd, 5);
  assert.equal(d.upgrade, true);
  assert.equal(d.fromPlan, 'FREE');
  assert.equal(d.toPlan, 'PRO');
});

test('getCostDelta: same plan returns 0 and upgrade=false', () => {
  const d = getCostDelta('PRO', 'PRO');
  assert.equal(d.deltaUsd, 0);
  assert.equal(d.upgrade, false);
});

test('getCostDelta: PRO_MAX → PRO is -$5 (downgrade)', () => {
  const d = getCostDelta('PRO_MAX', 'PRO');
  assert.equal(d.deltaUsd, -5);
  assert.equal(d.upgrade, false);
});

test('getCostDelta: case-insensitive plan names', () => {
  const d = getCostDelta('free', 'PRO');
  assert.equal(d.deltaUsd, 5);
  assert.equal(d.upgrade, true);
});

test('getCostDelta: unknown plan returns deltaUsd=null', () => {
  const d = getCostDelta('MYSTERY', 'PRO');
  assert.equal(d.deltaUsd, null);
  assert.equal(d.reason, 'unknown_plan');
});

test('PLAN_PRICES_USD: matches spec values ($0/$5/$10/$2)', () => {
  assert.equal(PLAN_PRICES_USD.FREE, 0);
  assert.equal(PLAN_PRICES_USD.PRO, 5);
  assert.equal(PLAN_PRICES_USD.PRO_MAX, 10);
  assert.equal(PLAN_PRICES_USD.ENTERPRISE, 2);
});

test('PLAN_BUDGETS: matches the values plan-credits-catalog grants', () => {
  // FREE has no premium tokens
  assert.equal(PLAN_BUDGETS.FREE, 0);
  // PRO grants 100k premium tokens per the spec
  assert.equal(PLAN_BUDGETS.PRO, 100_000);
  // PRO_MAX grants 300k
  assert.equal(PLAN_BUDGETS.PRO_MAX, 300_000);
  // ENTERPRISE is unlimited (null)
  assert.equal(PLAN_BUDGETS.ENTERPRISE, null);
});

test('estimateMonthlyCost: drops unknown features silently', () => {
  const result = estimateMonthlyCost({
    paraphrase: { calls: 1, avgTextLength: 0 },
    mystery_feature: { calls: 100 },
  });
  assert.equal(result.totalMonthly, 1);
  assert.ok(!result.perFeature.mystery_feature);
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

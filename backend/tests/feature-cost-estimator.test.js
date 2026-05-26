'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { estimateCost, estimateCostBatch, estimateMonthlyCost, getRecommendedPlan, getCostDelta, formatCreditsAsUsd, enrichPlanWithPricing, listFeatures, FEATURE_COSTS, PLAN_BUDGETS, PLAN_PRICES_USD, USD_PER_CREDIT } = require('../src/services/feature-cost-estimator');

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

test('estimateCostBatch: each estimate now includes a usdLabel', () => {
  const out = estimateCostBatch([
    { feature: 'image_generation' },
    { feature: 'paraphrase', textLength: 0 },
  ]);
  assert.equal(out[0].feature, 'image_generation');
  assert.match(out[0].usdLabel, /^≈/);
  assert.equal(out[1].feature, 'paraphrase');
  // Both fall well below $0.01 at the default rate, so the label is
  // "≈ <$0.01" — locked down so we catch unintended rate changes.
  assert.equal(out[0].usdLabel, '≈ <$0.01');
  assert.equal(out[1].usdLabel, '≈ <$0.01');
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
  assert.deepEqual(estimateMonthlyCost(null), { totalMonthly: 0, totalMonthlyUsd: '', perFeature: {} });
  assert.deepEqual(estimateMonthlyCost('garbage'), { totalMonthly: 0, totalMonthlyUsd: '', perFeature: {} });
  assert.deepEqual(estimateMonthlyCost({}), { totalMonthly: 0, totalMonthlyUsd: '', perFeature: {} });
});

test('getRecommendedPlan: no usage → FREE + priceUsd=0 + monthlyUsd=""', () => {
  const r = getRecommendedPlan({});
  assert.equal(r.plan, 'FREE');
  assert.equal(r.monthlyCredits, 0);
  assert.equal(r.priceUsd, 0);
  assert.equal(r.monthlyUsd, '');
});

test('getRecommendedPlan: PRO recommendation ships priceUsd=5 + monthlyUsd', () => {
  const r = getRecommendedPlan({
    paraphrase: { calls: 100, avgTextLength: 1000 },
  });
  assert.equal(r.plan, 'PRO');
  assert.equal(r.priceUsd, 5);
  assert.match(r.monthlyUsd, /^≈/);
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

test('creditsToUsdCents: returns integer cents, 0 for non-positive input', () => {
  const { creditsToUsdCents } = require('../src/services/feature-cost-estimator');
  assert.equal(creditsToUsdCents(0), 0);
  assert.equal(creditsToUsdCents(-1), 0);
  assert.equal(creditsToUsdCents(NaN), 0);
  // 1000 credits × $0.00005 × 100 = 5 cents
  assert.equal(creditsToUsdCents(1000), 5);
  // 100_000 credits = $5.00 = 500 cents
  assert.equal(creditsToUsdCents(100_000), 500);
  // Sub-cent rounds to 0
  assert.equal(creditsToUsdCents(1), 0);
  // Always integer
  const n = creditsToUsdCents(12345);
  assert.equal(n, Math.round(n));
});

test('formatCreditsAsUsd: 0 or negative → empty string', () => {
  assert.equal(formatCreditsAsUsd(0), '');
  assert.equal(formatCreditsAsUsd(-1), '');
  assert.equal(formatCreditsAsUsd(NaN), '');
});

test('formatCreditsAsUsd: small N renders "≈ <$0.01"', () => {
  // 1 credit = $0.00005 → below 1 cent
  assert.equal(formatCreditsAsUsd(1), '≈ <$0.01');
  assert.equal(formatCreditsAsUsd(100), '≈ <$0.01');
});

test('formatCreditsAsUsd: 1000 credits → "≈ $0.05"', () => {
  assert.equal(formatCreditsAsUsd(1000), '≈ $0.05');
});

test('formatCreditsAsUsd: 100k credits → "≈ $5.00" (matches PRO plan price)', () => {
  assert.equal(formatCreditsAsUsd(100_000), '≈ $5.00');
});

test('USD_PER_CREDIT: matches PRO plan rate ($5 / 100k tokens)', () => {
  assert.equal(USD_PER_CREDIT, 5 / 100_000);
});

test('enrichPlanWithPricing: FREE → priceLabel="Free", budgetLabel="0 credits"', () => {
  const r = enrichPlanWithPricing('FREE');
  assert.equal(r.plan, 'FREE');
  assert.equal(r.priceUsd, 0);
  assert.equal(r.priceLabel, 'Free');
  assert.equal(r.unlimited, false);
});

test('enrichPlanWithPricing: PRO → priceLabel="$5/mo", budgetLabel="100,000 credits", popular=true', () => {
  const r = enrichPlanWithPricing('PRO');
  assert.equal(r.plan, 'PRO');
  assert.equal(r.priceUsd, 5);
  assert.equal(r.priceLabel, '$5/mo');
  assert.equal(r.budgetCredits, 100_000);
  assert.equal(r.budgetLabel, '100,000 credits');
  assert.equal(r.popular, true, 'PRO is marked popular per product');
});

test('enrichPlanWithPricing: non-PRO plans have popular=false', () => {
  assert.equal(enrichPlanWithPricing('FREE').popular, false);
  assert.equal(enrichPlanWithPricing('PRO_MAX').popular, false);
  assert.equal(enrichPlanWithPricing('ENTERPRISE').popular, false);
});

test('enrichPlanWithPricing: ENTERPRISE → unlimited=true, budgetLabel="Unlimited"', () => {
  const r = enrichPlanWithPricing('ENTERPRISE');
  assert.equal(r.unlimited, true);
  assert.equal(r.budgetCredits, null);
  assert.equal(r.budgetLabel, 'Unlimited');
});

test('validatePlanName: returns true for known plans (case-insensitive)', () => {
  const { validatePlanName } = require('../src/services/feature-cost-estimator');
  assert.equal(validatePlanName('FREE'), true);
  assert.equal(validatePlanName('pro'), true);
  assert.equal(validatePlanName('PRO_MAX'), true);
  assert.equal(validatePlanName('enterprise'), true);
});

test('validatePlanName: returns false for unknown/invalid input', () => {
  const { validatePlanName } = require('../src/services/feature-cost-estimator');
  assert.equal(validatePlanName(''), false);
  assert.equal(validatePlanName('mystery'), false);
  assert.equal(validatePlanName(null), false);
  assert.equal(validatePlanName(123), false);
  assert.equal(validatePlanName(undefined), false);
  assert.equal(validatePlanName({}), false);
  assert.equal(validatePlanName([]), false);
  assert.equal(validatePlanName(true), false);
});

test('enrichPlanWithPricing: case-insensitive, unknown plan returns null', () => {
  assert.equal(enrichPlanWithPricing('pro').plan, 'PRO');
  assert.equal(enrichPlanWithPricing('mystery'), null);
  assert.equal(enrichPlanWithPricing(null), null);
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

test('estimateMonthlyCost: includes totalMonthlyUsd label + per-feature monthlyUsd', () => {
  const r = estimateMonthlyCost({
    paraphrase: { calls: 100, avgTextLength: 1000 },
  });
  // 100 × 2 = 200 credits → $0.01
  assert.equal(r.totalMonthly, 200);
  assert.equal(r.totalMonthlyUsd, '≈ $0.01');
  assert.equal(r.perFeature.paraphrase.monthlyUsd, '≈ $0.01');
});

test('estimateMonthlyCost: zero usage returns totalMonthlyUsd=""', () => {
  const r = estimateMonthlyCost({});
  assert.equal(r.totalMonthly, 0);
  assert.equal(r.totalMonthlyUsd, '');
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

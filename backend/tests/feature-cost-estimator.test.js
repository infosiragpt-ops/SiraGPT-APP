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

test('monthlyBreakdownAsCsv: header-only when projection is null/garbage', () => {
  const { monthlyBreakdownAsCsv } = require('../src/services/feature-cost-estimator');
  const expectedHeader = 'feature,calls,perCallCredits,monthlyCredits,monthlyUsd\n';
  assert.equal(monthlyBreakdownAsCsv(null), expectedHeader);
  assert.equal(monthlyBreakdownAsCsv(undefined), expectedHeader);
  assert.equal(monthlyBreakdownAsCsv('garbage'), expectedHeader);
  assert.equal(monthlyBreakdownAsCsv(42), expectedHeader);
});

test('monthlyBreakdownAsCsv: renders header + per-feature rows + TOTAL', () => {
  const { monthlyBreakdownAsCsv } = require('../src/services/feature-cost-estimator');
  const projection = estimateMonthlyCost({
    paraphrase: { calls: 10, avgTextLength: 2000 },
    image_generation: { calls: 5 },
  });
  const csv = monthlyBreakdownAsCsv(projection);
  const lines = csv.trimEnd().split('\n');
  // header + 2 features + TOTAL
  assert.equal(lines.length, 4);
  assert.equal(lines[0], 'feature,calls,perCallCredits,monthlyCredits,monthlyUsd');
  // Each feature row begins with quoted feature name
  assert.ok(lines[1].startsWith('"paraphrase",10,3,30,'));
  assert.ok(lines[2].startsWith('"image_generation",5,5,25,'));
  // TOTAL row: empty calls + perCallCredits + total credits + USD label
  assert.ok(lines[3].startsWith('"TOTAL",,,55,'));
});

test('monthlyBreakdownAsCsv: empty projection renders header + TOTAL=0 only', () => {
  const { monthlyBreakdownAsCsv } = require('../src/services/feature-cost-estimator');
  const csv = monthlyBreakdownAsCsv(estimateMonthlyCost({}));
  const lines = csv.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'feature,calls,perCallCredits,monthlyCredits,monthlyUsd');
  assert.equal(lines[1], '"TOTAL",,,0,""');
});

test('monthlyBreakdownAsCsv: feature names with quotes are doubled-up per RFC 4180', () => {
  const { monthlyBreakdownAsCsv } = require('../src/services/feature-cost-estimator');
  // Simulate a hand-crafted projection — the estimator wouldn't normally
  // produce a feature with quotes, but the CSV writer must still escape
  // them safely if upstream code ever does.
  const projection = {
    totalMonthly: 12,
    totalMonthlyUsd: '≈ <$0.01',
    perFeature: {
      'weird"feature"': { calls: 1, perCallCredits: 12, monthlyCredits: 12, monthlyUsd: '≈ <$0.01' },
    },
  };
  const csv = monthlyBreakdownAsCsv(projection);
  assert.ok(csv.includes('"weird""feature""",1,12,12,'));
});

test('monthlyBreakdownAsCsv: trailing newline so Excel/Sheets stops cleanly', () => {
  const { monthlyBreakdownAsCsv } = require('../src/services/feature-cost-estimator');
  const csv = monthlyBreakdownAsCsv(estimateMonthlyCost({
    paraphrase: { calls: 1, avgTextLength: 0 },
  }));
  assert.ok(csv.endsWith('\n'));
});

test('pricingTable: returns all 4 known plans sorted by price', () => {
  const { pricingTable } = require('../src/services/feature-cost-estimator');
  const table = pricingTable();
  assert.equal(table.length, 4);
  // FREE ($0) → ENTERPRISE ($2) → PRO ($5) → PRO_MAX ($10)
  assert.equal(table[0].plan, 'FREE');
  assert.equal(table[1].plan, 'ENTERPRISE');
  assert.equal(table[2].plan, 'PRO');
  assert.equal(table[3].plan, 'PRO_MAX');
});

test('pricingTable: each row is a fully-enriched plan record', () => {
  const { pricingTable } = require('../src/services/feature-cost-estimator');
  const proRow = pricingTable().find((p) => p.plan === 'PRO');
  assert.equal(proRow.priceUsd, 5);
  assert.equal(proRow.priceLabel, '$5/mo');
  assert.equal(proRow.budgetCredits, 100_000);
  assert.equal(proRow.budgetLabel, '100,000 credits');
  assert.equal(proRow.popular, true);
  assert.equal(proRow.unlimited, false);
});

test('pricingTable: monotonically non-decreasing prices', () => {
  const { pricingTable } = require('../src/services/feature-cost-estimator');
  const prices = pricingTable().map((p) => p.priceUsd);
  for (let i = 1; i < prices.length; i++) {
    assert.ok(prices[i] >= prices[i - 1], `prices not sorted ascending at index ${i}`);
  }
});

test('pricingTable: ENTERPRISE row is unlimited', () => {
  const { pricingTable } = require('../src/services/feature-cost-estimator');
  const ent = pricingTable().find((p) => p.plan === 'ENTERPRISE');
  assert.equal(ent.unlimited, true);
  assert.equal(ent.budgetCredits, null);
  assert.equal(ent.budgetLabel, 'Unlimited');
});

test('creditsForUsd: 0 / negative / invalid → 0 credits', () => {
  const { creditsForUsd } = require('../src/services/feature-cost-estimator');
  assert.equal(creditsForUsd(0), 0);
  assert.equal(creditsForUsd(-1), 0);
  assert.equal(creditsForUsd(NaN), 0);
  assert.equal(creditsForUsd('abc'), 0);
  assert.equal(creditsForUsd(null), 0);
});

test('creditsForUsd: $5 → 100,000 credits (matches PRO plan)', () => {
  const { creditsForUsd } = require('../src/services/feature-cost-estimator');
  assert.equal(creditsForUsd(5), 100_000);
});

test('creditsForUsd: small USD amounts round down — never gives more than paid for', () => {
  const { creditsForUsd } = require('../src/services/feature-cost-estimator');
  // 0.001 USD → 20 credits (clean)
  assert.equal(creditsForUsd(0.001), 20);
  // Always integer
  const n = creditsForUsd(2.345);
  assert.equal(n, Math.floor(n));
});

test('creditsForUsd ↔ creditsToUsdCents: round-trips for whole-cent amounts', () => {
  const { creditsForUsd, creditsToUsdCents } = require('../src/services/feature-cost-estimator');
  // $0.05 → 1000 credits → 5 cents → $0.05 ✓
  assert.equal(creditsToUsdCents(creditsForUsd(0.05)), 5);
  // $5.00 → 100k credits → 500 cents → $5.00 ✓
  assert.equal(creditsToUsdCents(creditsForUsd(5)), 500);
});

test('comparePlans: FREE → PRO is an upgrade with $5 + 100k credit delta', () => {
  const { comparePlans } = require('../src/services/feature-cost-estimator');
  const cmp = comparePlans('FREE', 'PRO');
  assert.equal(cmp.direction, 'upgrade');
  assert.equal(cmp.priceDeltaUsd, 5);
  assert.equal(cmp.budgetDeltaCredits, 100_000);
  assert.equal(cmp.from.plan, 'FREE');
  assert.equal(cmp.to.plan, 'PRO');
});

test('comparePlans: PRO_MAX → PRO is a downgrade with negative deltas', () => {
  const { comparePlans } = require('../src/services/feature-cost-estimator');
  const cmp = comparePlans('PRO_MAX', 'PRO');
  assert.equal(cmp.direction, 'downgrade');
  assert.equal(cmp.priceDeltaUsd, -5);
  assert.equal(cmp.budgetDeltaCredits, -200_000);
});

test('comparePlans: same plan is direction "same" with zero deltas', () => {
  const { comparePlans } = require('../src/services/feature-cost-estimator');
  const cmp = comparePlans('PRO', 'PRO');
  assert.equal(cmp.direction, 'same');
  assert.equal(cmp.priceDeltaUsd, 0);
  assert.equal(cmp.budgetDeltaCredits, 0);
});

test('comparePlans: PRO → ENTERPRISE — budget delta = null when gaining unlimited', () => {
  const { comparePlans } = require('../src/services/feature-cost-estimator');
  const cmp = comparePlans('PRO', 'ENTERPRISE');
  // ENTERPRISE is $2 < PRO $5, so this is technically a downgrade in price
  assert.equal(cmp.direction, 'downgrade');
  assert.equal(cmp.priceDeltaUsd, -3);
  // Budget goes 100k → unlimited, so delta is null (special-cased)
  assert.equal(cmp.budgetDeltaCredits, null);
});

test('comparePlans: ENTERPRISE → PRO — budget delta = null when losing unlimited', () => {
  const { comparePlans } = require('../src/services/feature-cost-estimator');
  const cmp = comparePlans('ENTERPRISE', 'PRO');
  assert.equal(cmp.budgetDeltaCredits, null);
});

test('comparePlans: unknown plan returns null', () => {
  const { comparePlans } = require('../src/services/feature-cost-estimator');
  assert.equal(comparePlans('FREE', 'MYSTERY'), null);
  assert.equal(comparePlans('MYSTERY', 'PRO'), null);
  assert.equal(comparePlans(null, 'PRO'), null);
});

test('comparePlans: case-insensitive plan names', () => {
  const { comparePlans } = require('../src/services/feature-cost-estimator');
  const cmp = comparePlans('free', 'pro');
  assert.equal(cmp.direction, 'upgrade');
  assert.equal(cmp.from.plan, 'FREE');
  assert.equal(cmp.to.plan, 'PRO');
});

test('recommendUpgradeFromUsage: FREE user with PRO-sized usage → shouldUpgrade=true', () => {
  const { recommendUpgradeFromUsage } = require('../src/services/feature-cost-estimator');
  const result = recommendUpgradeFromUsage(
    { paraphrase: { calls: 100, avgTextLength: 1000 } }, // 200 credits → PRO
    'FREE',
  );
  assert.equal(result.shouldUpgrade, true);
  assert.equal(result.recommendation.plan, 'PRO');
  assert.equal(result.comparison.direction, 'upgrade');
  assert.equal(result.comparison.priceDeltaUsd, 5);
});

test('recommendUpgradeFromUsage: user already on right plan → shouldUpgrade=false', () => {
  const { recommendUpgradeFromUsage } = require('../src/services/feature-cost-estimator');
  const result = recommendUpgradeFromUsage(
    { paraphrase: { calls: 100, avgTextLength: 1000 } },
    'PRO',
  );
  assert.equal(result.shouldUpgrade, false);
  assert.equal(result.recommendation.plan, 'PRO');
  assert.equal(result.comparison.direction, 'same');
});

test('recommendUpgradeFromUsage: PRO_MAX user with FREE-sized usage → shouldUpgrade=false (downgrade)', () => {
  const { recommendUpgradeFromUsage } = require('../src/services/feature-cost-estimator');
  const result = recommendUpgradeFromUsage(
    {}, // no usage → FREE
    'PRO_MAX',
  );
  assert.equal(result.shouldUpgrade, false);
  assert.equal(result.recommendation.plan, 'FREE');
  assert.equal(result.comparison.direction, 'downgrade');
});

test('recommendUpgradeFromUsage: unknown current plan returns null', () => {
  const { recommendUpgradeFromUsage } = require('../src/services/feature-cost-estimator');
  assert.equal(recommendUpgradeFromUsage({}, 'MYSTERY'), null);
  assert.equal(recommendUpgradeFromUsage({}, null), null);
});

test('recommendUpgradeFromUsage: case-insensitive currentPlan', () => {
  const { recommendUpgradeFromUsage } = require('../src/services/feature-cost-estimator');
  const result = recommendUpgradeFromUsage(
    { paraphrase: { calls: 100, avgTextLength: 1000 } },
    'free',
  );
  assert.equal(result.shouldUpgrade, true);
});

test('findCheapestPlanForBudget: $0 → FREE', () => {
  const { findCheapestPlanForBudget } = require('../src/services/feature-cost-estimator');
  assert.equal(findCheapestPlanForBudget(0).plan, 'FREE');
});

test('findCheapestPlanForBudget: $3 → ENTERPRISE (unlimited, $2 ≤ $3, largest budget)', () => {
  const { findCheapestPlanForBudget } = require('../src/services/feature-cost-estimator');
  // ENTERPRISE = $2 unlimited → wins on budget despite $5 PRO being affordable
  const r = findCheapestPlanForBudget(3);
  assert.equal(r.plan, 'ENTERPRISE');
  assert.equal(r.unlimited, true);
});

test('findCheapestPlanForBudget: $5 → ENTERPRISE (unlimited beats PRO 100k)', () => {
  const { findCheapestPlanForBudget } = require('../src/services/feature-cost-estimator');
  assert.equal(findCheapestPlanForBudget(5).plan, 'ENTERPRISE');
});

test('findCheapestPlanForBudget: $10 → ENTERPRISE (still unlimited beats PRO_MAX 300k)', () => {
  const { findCheapestPlanForBudget } = require('../src/services/feature-cost-estimator');
  assert.equal(findCheapestPlanForBudget(10).plan, 'ENTERPRISE');
});

test('findCheapestPlanForBudget: $1 → FREE (ENTERPRISE costs $2 > $1)', () => {
  const { findCheapestPlanForBudget } = require('../src/services/feature-cost-estimator');
  assert.equal(findCheapestPlanForBudget(1).plan, 'FREE');
});

test('findCheapestPlanForBudget: negative → FREE (clamped to $0)', () => {
  const { findCheapestPlanForBudget } = require('../src/services/feature-cost-estimator');
  assert.equal(findCheapestPlanForBudget(-5).plan, 'FREE');
});

test('findCheapestPlanForBudget: non-numeric → null', () => {
  const { findCheapestPlanForBudget } = require('../src/services/feature-cost-estimator');
  assert.equal(findCheapestPlanForBudget('abc'), null);
  assert.equal(findCheapestPlanForBudget(NaN), null);
  assert.equal(findCheapestPlanForBudget(undefined), null);
});

test('quickEstimate: minCost for each feature regardless of payload size', () => {
  const { quickEstimate } = require('../src/services/feature-cost-estimator');
  const out = quickEstimate(['paraphrase', 'image_generation', 'image_upscale']);
  assert.equal(out.length, 3);
  assert.equal(out[0].feature, 'paraphrase');
  assert.equal(out[0].credits, 1);
  assert.equal(out[1].credits, 5);
  assert.equal(out[2].credits, 3);
});

test('quickEstimate: silently drops unknown features', () => {
  const { quickEstimate } = require('../src/services/feature-cost-estimator');
  const out = quickEstimate(['paraphrase', 'mystery_feature', 'image_generation']);
  assert.equal(out.length, 2);
});

test('quickEstimate: non-array input returns []', () => {
  const { quickEstimate } = require('../src/services/feature-cost-estimator');
  assert.deepEqual(quickEstimate(null), []);
  assert.deepEqual(quickEstimate('paraphrase'), []);
});

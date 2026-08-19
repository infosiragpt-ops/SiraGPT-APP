'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyPlanPricing, planMultiplier } = require('../src/services/codex/pricing-policy');

test('FREE plan → applied cost is 0 (original preserved for the strikethrough)', () => {
  const r = applyPlanPricing('FREE', 1.23, { env: {} });
  assert.equal(r.costOriginalUsd, 1.23);
  assert.equal(r.costAppliedUsd, 0);
});

test('PRO pays full list price (no strikethrough)', () => {
  const r = applyPlanPricing('PRO', 2, { env: {} });
  assert.equal(r.costOriginalUsd, 2);
  assert.equal(r.costAppliedUsd, 2);
});

test('PRO_MAX and ENTERPRISE get a discount perk', () => {
  assert.equal(applyPlanPricing('PRO_MAX', 1, { env: {} }).costAppliedUsd, 0.9);
  assert.equal(applyPlanPricing('ENTERPRISE', 1, { env: {} }).costAppliedUsd, 0.75);
});

test('a launch promo multiplier stacks on top of the plan multiplier', () => {
  const r = applyPlanPricing('PRO', 1, { env: { CODEX_COST_PROMO_MULTIPLIER: '0.5' } });
  assert.equal(r.costAppliedUsd, 0.5);
});

test('costAppliedUsd is never greater than costOriginalUsd', () => {
  for (const plan of ['FREE', 'PRO', 'PRO_MAX', 'ENTERPRISE', 'unknown']) {
    const r = applyPlanPricing(plan, 3.5, { env: {} });
    assert.ok(r.costAppliedUsd <= r.costOriginalUsd, `${plan}: applied ${r.costAppliedUsd} > original ${r.costOriginalUsd}`);
  }
});

test('zero or invalid original cost → 0/0', () => {
  assert.deepEqual(applyPlanPricing('PRO', 0, { env: {} }), { costOriginalUsd: 0, costAppliedUsd: 0, multiplier: 1 });
  assert.equal(applyPlanPricing('PRO', -5, { env: {} }).costOriginalUsd, 0);
});

test('unknown plan defaults to full price; planMultiplier defaults to 1', () => {
  assert.equal(planMultiplier('whatever'), 1);
  assert.equal(applyPlanPricing('whatever', 1, { env: {} }).costAppliedUsd, 1);
});

'use strict';

/**
 * Unit tests for the org billing helpers (cycle 46):
 *   - quotaForPlan / mrrForPlan / isUpgradablePlan
 *   - firstOfNextMonth (UTC, rolls year over December)
 *   - computePercentUsed (BigInt + Number inputs, clamping)
 *
 * Pure-JS: imports the orgs router only for the `__billing` testing
 * surface; no prisma client / express bind required.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const orgsRouter = require('../src/routes/orgs');
const {
  PLAN_QUOTAS,
  PLAN_MRR_USD,
  quotaForPlan,
  mrrForPlan,
  isUpgradablePlan,
  firstOfNextMonth,
  computePercentUsed,
  toBigIntString,
} = orgsRouter.__billing;

// ─── plan → quota mapping ────────────────────────────────────────────
test('PLAN_QUOTAS: matches the cycle-46 ladder', () => {
  assert.equal(PLAN_QUOTAS.FREE, 50_000);
  assert.equal(PLAN_QUOTAS.PRO, 100_000);
  assert.equal(PLAN_QUOTAS.PRO_MAX, 300_000);
  assert.equal(PLAN_QUOTAS.ENTERPRISE, 10_000_000);
});

test('quotaForPlan: returns the matching tier', () => {
  assert.equal(quotaForPlan('FREE'), 50_000);
  assert.equal(quotaForPlan('PRO'), 100_000);
  assert.equal(quotaForPlan('PRO_MAX'), 300_000);
  assert.equal(quotaForPlan('ENTERPRISE'), 10_000_000);
});

test('quotaForPlan: falls back to FREE for unknown plans', () => {
  assert.equal(quotaForPlan('GOLD'), 50_000);
  assert.equal(quotaForPlan(undefined), 50_000);
  assert.equal(quotaForPlan(null), 50_000);
});

test('mrrForPlan: USD revenue per plan', () => {
  assert.equal(mrrForPlan('FREE'), 0);
  assert.equal(mrrForPlan('PRO'), PLAN_MRR_USD.PRO);
  assert.equal(mrrForPlan('PRO_MAX'), PLAN_MRR_USD.PRO_MAX);
  assert.equal(mrrForPlan('ENTERPRISE'), PLAN_MRR_USD.ENTERPRISE);
  assert.equal(mrrForPlan('mystery'), 0);
});

// ─── isUpgradablePlan ────────────────────────────────────────────────
test('isUpgradablePlan: only paid tiers', () => {
  assert.equal(isUpgradablePlan('PRO'), true);
  assert.equal(isUpgradablePlan('PRO_MAX'), true);
  assert.equal(isUpgradablePlan('ENTERPRISE'), true);
  assert.equal(isUpgradablePlan('FREE'), false);
  assert.equal(isUpgradablePlan(''), false);
  assert.equal(isUpgradablePlan(null), false);
});

// ─── firstOfNextMonth ────────────────────────────────────────────────
test('firstOfNextMonth: mid-month rolls to next month at UTC midnight', () => {
  const d = firstOfNextMonth(new Date(Date.UTC(2026, 4, 19, 14, 30, 0))); // May 19
  assert.equal(d.toISOString(), '2026-06-01T00:00:00.000Z');
});

test('firstOfNextMonth: December rolls into next January', () => {
  const d = firstOfNextMonth(new Date(Date.UTC(2026, 11, 31, 23, 59, 59)));
  assert.equal(d.toISOString(), '2027-01-01T00:00:00.000Z');
});

test('firstOfNextMonth: first-of-month input rolls to following month', () => {
  const d = firstOfNextMonth(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)));
  assert.equal(d.toISOString(), '2026-02-01T00:00:00.000Z');
});

// ─── computePercentUsed ──────────────────────────────────────────────
test('computePercentUsed: basic ratio', () => {
  assert.equal(computePercentUsed(25_000, 100_000), 25);
  assert.equal(computePercentUsed(0, 100_000), 0);
});

test('computePercentUsed: clamps over-usage to 100', () => {
  assert.equal(computePercentUsed(200_000, 100_000), 100);
});

test('computePercentUsed: zero / missing quota → 0', () => {
  assert.equal(computePercentUsed(5_000, 0), 0);
  assert.equal(computePercentUsed(5_000, null), 0);
});

test('computePercentUsed: accepts BigInt for both args', () => {
  assert.equal(computePercentUsed(BigInt(125_000), BigInt(500_000)), 25);
  assert.equal(computePercentUsed(BigInt(1), BigInt(4)), 25);
});

test('computePercentUsed: rounds to 2 decimals', () => {
  // 1 / 3 = 33.333... -> 33.33
  assert.equal(computePercentUsed(1, 3), 33.33);
});

// ─── toBigIntString ──────────────────────────────────────────────────
test('toBigIntString: handles bigint, number, null', () => {
  assert.equal(toBigIntString(BigInt(42)), '42');
  assert.equal(toBigIntString(42), '42');
  assert.equal(toBigIntString(null), '0');
  assert.equal(toBigIntString(undefined), '0');
});

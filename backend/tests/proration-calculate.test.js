'use strict';

// Unit tests for ProrationService.calculateProration — the actual proration
// arithmetic (unused-current vs prorated-new → net charge/credit). prisma.user
// and stripeService are injected via require.cache before the service loads so
// the math runs offline with deterministic period boundaries.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SERVICES_DIR = path.join(__dirname, '..', 'src', 'services');
function inject(reqPath, exportsValue) {
  const resolved = require.resolve(reqPath, { paths: [SERVICES_DIR] });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue };
}

let userRow = null;
let subscription = null;
inject('../config/database', { user: { findUnique: async () => userRow } });
inject('./stripe', { retrieveSubscription: async () => subscription });

const proration = require(path.join(SERVICES_DIR, 'proration.js'));

const SEC = (iso) => Math.floor(new Date(iso).getTime() / 1000);
// 30-day cycle (Jun 1 → Jul 1), change mid-cycle on Jun 15 → 16 days remaining.
const FULL_CYCLE = { current_period_start: SEC('2026-06-01T00:00:00Z'), current_period_end: SEC('2026-07-01T00:00:00Z') };
const CHANGE_DATE = new Date('2026-06-15T00:00:00Z');

test('PRO→PRO_MAX mid-cycle → positive net charge ($8.00) + isUpgrade', async () => {
  userRow = { id: 'u1', plan: 'PRO', stripeSubscriptionId: 'sub_1' };
  subscription = FULL_CYCLE;
  const r = await proration.calculateProration('u1', 'PRO_MAX', CHANGE_DATE);
  assert.equal(r.totalPeriodDays, 30);
  assert.equal(r.remainingDays, 16);
  assert.equal(r.isUpgrade, true);
  assert.equal(r.isDowngrade, false);
  // (2000-500) * 16/30 / 100 = 8.00 exactly
  assert.ok(Math.abs(r.netAmount - 8) < 0.001, `expected ~+8.00, got ${r.netAmount}`);
  assert.equal(r.currentPlanPrice, 5);
  assert.equal(r.newPlanPrice, 20);
});

test('PRO_MAX→PRO mid-cycle → negative net (credit) + isDowngrade', async () => {
  userRow = { id: 'u1', plan: 'PRO_MAX', stripeSubscriptionId: 'sub_1' };
  subscription = FULL_CYCLE;
  const r = await proration.calculateProration('u1', 'PRO', CHANGE_DATE);
  assert.equal(r.isDowngrade, true);
  assert.equal(r.isUpgrade, false);
  assert.ok(Math.abs(r.netAmount + 8) < 0.001, `expected ~-8.00, got ${r.netAmount}`);
});

test('same plan → net ~0 (no charge), neither up nor downgrade', async () => {
  userRow = { id: 'u1', plan: 'PRO', stripeSubscriptionId: 'sub_1' };
  subscription = FULL_CYCLE;
  const r = await proration.calculateProration('u1', 'PRO', CHANGE_DATE);
  assert.ok(Math.abs(r.netAmount) < 0.001);
  assert.equal(r.isUpgrade, false);
  assert.equal(r.isDowngrade, false);
});

test('throws when the user has no active subscription', async () => {
  userRow = { id: 'u1', plan: 'PRO', stripeSubscriptionId: null };
  await assert.rejects(() => proration.calculateProration('u1', 'PRO_MAX', CHANGE_DATE), /no active subscription/i);
});

test('throws when the user is missing entirely', async () => {
  userRow = null;
  await assert.rejects(() => proration.calculateProration('ghost', 'PRO', CHANGE_DATE), /no active subscription/i);
});

test('degenerate zero-length billing period does not divide by zero', async () => {
  // current_period_start === current_period_end → totalPeriodDays would be 0,
  // and (price * remainingDays) / 0 produced Infinity/NaN net amounts.
  userRow = { id: 'u1', plan: 'PRO', stripeSubscriptionId: 'sub_1' };
  const T = SEC('2026-06-15T00:00:00Z');
  subscription = { current_period_start: T, current_period_end: T };
  const r = await proration.calculateProration('u1', 'PRO_MAX', new Date('2026-06-15T00:00:00Z'));
  assert.equal(r.totalPeriodDays, 1, 'a degenerate period clamps to 1 day');
  assert.ok(Number.isFinite(r.netAmount), `netAmount must be finite, got ${r.netAmount}`);
  assert.ok(Number.isFinite(r.unusedAmount), `unusedAmount must be finite, got ${r.unusedAmount}`);
  assert.ok(Number.isFinite(r.newPlanProrated), `newPlanProrated must be finite, got ${r.newPlanProrated}`);
});

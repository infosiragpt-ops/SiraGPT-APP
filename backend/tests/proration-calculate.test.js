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
const invoiceRequests = [];
inject('../config/database', { user: { findUnique: async () => userRow } });
inject('./stripe', {
  retrieveSubscription: async () => subscription,
  plans: { PRO: { price: 500 }, PRO_MAX: { price: 1000 }, ENTERPRISE: { price: 20000 } },
  retrieveUpcomingInvoice: async params => {
    invoiceRequests.push(params);
    // createPreview accepts subscription_details, not retrieveUpcoming's
    // removed subscription_items/subscription_proration_behavior arguments.
    if (params.subscription_items || params.subscription_proration_behavior) {
      throw new Error('Received unknown parameter: subscription_items');
    }
    return { subtotal: 1267, total: 1267, amount_due: 1267, lines: { data: [{
      description: 'Proration and renewal', amount: 1267,
      period: { start: 1781481600, end: 1782864000 },
    }] } };
  },
});
inject('../utils/stripe-setup', { getPriceIdForPlan: async plan => {
  assert.equal(plan, 'PRO_MAX');
  return 'price_pro_monthly';
} });

const proration = require(path.join(SERVICES_DIR, 'proration.js'));

const SEC = (iso) => Math.floor(new Date(iso).getTime() / 1000);
// 30-day cycle (Jun 1 → Jul 1), change mid-cycle on Jun 15 → 16 days remaining.
const FULL_CYCLE = { current_period_start: SEC('2026-06-01T00:00:00Z'), current_period_end: SEC('2026-07-01T00:00:00Z') };
const CHANGE_DATE = new Date('2026-06-15T00:00:00Z');

test('PRO→PRO_MAX mid-cycle uses the $10 monthly checkout price', async () => {
  userRow = { id: 'u1', plan: 'PRO', stripeSubscriptionId: 'sub_1' };
  subscription = FULL_CYCLE;
  const r = await proration.calculateProration('u1', 'PRO_MAX', CHANGE_DATE);
  assert.equal(r.totalPeriodDays, 30);
  assert.equal(r.remainingDays, 16);
  assert.equal(r.isUpgrade, true);
  assert.equal(r.isDowngrade, false);
  // (1000-500) * 16/30 / 100 = 2.666...
  assert.ok(Math.abs(r.netAmount - 8 / 3) < 0.001, `expected ~+2.67, got ${r.netAmount}`);
  assert.equal(r.currentPlanPrice, 5);
  assert.equal(r.newPlanPrice, 10);
});

test('PRO_MAX→PRO mid-cycle → negative net (credit) + isDowngrade', async () => {
  userRow = { id: 'u1', plan: 'PRO_MAX', stripeSubscriptionId: 'sub_1' };
  subscription = FULL_CYCLE;
  const r = await proration.calculateProration('u1', 'PRO', CHANGE_DATE);
  assert.equal(r.isDowngrade, true);
  assert.equal(r.isUpgrade, false);
  assert.ok(Math.abs(r.netAmount + 8 / 3) < 0.001, `expected ~-2.67, got ${r.netAmount}`);
});

test('Clover item-level periods produce finite proration and the actual renewal date', async () => {
  userRow = { id: 'u1', plan: 'PRO', stripeSubscriptionId: 'sub_1' };
  subscription = { items: { data: [{ id: 'si_fixture', ...FULL_CYCLE }] } };
  const result = await proration.calculateProration('u1', 'PRO_MAX', CHANGE_DATE);
  assert.equal(result.totalPeriodDays, 30);
  assert.equal(result.remainingDays, 16);
  assert.equal(result.currentPeriodEnd, '2026-07-01T00:00:00.000Z');
  assert.ok(Math.abs(result.netAmount - 8 / 3) < 0.001);
});

test('plan-change preview sends Clover subscription_details and preserves the provider invoice', async () => {
  userRow = { id: 'u1', plan: 'PRO', stripeCustomerId: 'cus_owner', stripeSubscriptionId: 'sub_1' };
  subscription = { items: { data: [{ id: 'si_existing', ...FULL_CYCLE }] } };
  invoiceRequests.length = 0;
  const result = await proration.previewPlanChange('u1', 'PRO_MAX');
  assert.deepEqual(invoiceRequests, [{
    customer: 'cus_owner',
    subscription: 'sub_1',
    subscription_details: {
      items: [{ id: 'si_existing', price: 'price_pro_monthly' }],
      proration_behavior: 'create_prorations',
    },
  }]);
  assert.equal(result.upcomingInvoice.amountDue, 12.67);
  assert.equal(result.upcomingInvoice.total, 12.67);
  assert.equal(result.upcomingInvoice.lines[0].description, 'Proration and renewal');
});

test('ambiguous or absent item periods fail before reporting invented proration amounts', async () => {
  userRow = { id: 'u1', plan: 'PRO', stripeSubscriptionId: 'sub_1' };
  for (const candidate of [
    {},
    { items: { data: [{ ...FULL_CYCLE }, { ...FULL_CYCLE, current_period_end: FULL_CYCLE.current_period_end + 86400 }] } },
  ]) {
    subscription = candidate;
    await assert.rejects(() => proration.calculateProration('u1', 'PRO_MAX', CHANGE_DATE), /billing period is unavailable/);
  }
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

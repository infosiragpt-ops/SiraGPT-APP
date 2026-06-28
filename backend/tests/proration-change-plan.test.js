'use strict';

// Regression — ProrationService.changePlan must persist the new monthlyLimit
// without throwing. monthlyLimit is BigInt in Prisma; the route used to do
// `(currentUser.monthlyLimit || 0) + planLimits[newPlan].monthlyLimit`, mixing a
// BigInt with a plain Number, which throws `TypeError: Cannot mix BigInt and
// other types`. Because that line runs AFTER executeImmediatePlanChange has
// already charged the customer in Stripe, every immediate plan change left the
// user charged but the DB un-updated (handler returned 500). It also hard-coded
// 5×-divergent grants (PRO 500k vs the catalog/webhook's 100k).
//
// prisma + stripe are injected via require.cache before the service loads (same
// pattern as proration-calculate.test.js); the network-bound instance methods
// are stubbed so the test exercises only the post-charge DB arithmetic.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SERVICES_DIR = path.join(__dirname, '..', 'src', 'services');
function inject(reqPath, exportsValue) {
  const resolved = require.resolve(reqPath, { paths: [SERVICES_DIR] });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue };
}

let userRow = null;
let updateArgs = null;

inject('../config/database', {
  user: {
    findUnique: async () => userRow,
    update: async (args) => { updateArgs = args; return { id: 'u1', ...args.data }; },
  },
  subscriptionEvent: { create: async () => ({}) },
  notification: { create: async () => ({}) },
});
inject('./stripe', { isStripeLikeError: () => false });

const proration = require(path.join(SERVICES_DIR, 'proration.js'));
const { monthlyLimitForStripePlan } = require(path.join(SERVICES_DIR, 'plan-credits-catalog.js'));

// Stub the network-bound collaborators so only the post-charge DB arithmetic
// (the part that used to throw BigInt+Number) is exercised.
let stripeCharged = false;
proration.calculateProration = async () => ({ netAmount: 8, isUpgrade: true, isDowngrade: false });
proration.getPriceIdForPlan = async () => 'price_test';
proration.executeImmediatePlanChange = async () => { stripeCharged = true; return { id: 'sub_test', ok: true }; };

test('changePlan with a BigInt monthlyLimit does not throw and returns success', async () => {
  userRow = { id: 'u1', plan: 'PRO', stripeSubscriptionId: 'sub_1', monthlyLimit: 1000n };
  const res = await proration.changePlan('u1', 'PRO_MAX', true);
  assert.equal(res.success, true);
  assert.equal(stripeCharged, true, 'sanity: the (stubbed) Stripe charge path ran before the DB write');
});

test('changePlan ADDs the canonical catalog grant (matches the webhook), BigInt-safe', async () => {
  userRow = { id: 'u1', plan: 'PRO', stripeSubscriptionId: 'sub_1', monthlyLimit: 1000n };
  updateArgs = null;
  await proration.changePlan('u1', 'PRO_MAX', true);
  const expected = 1000n + monthlyLimitForStripePlan('PRO_MAX'); // 1000n + 200_000n
  assert.equal(typeof updateArgs.data.monthlyLimit, 'bigint', 'monthlyLimit must stay BigInt');
  assert.equal(updateArgs.data.monthlyLimit, expected);
  assert.equal(updateArgs.data.plan, 'PRO_MAX');
  // Guard against the historical 5× divergence: the grant must be the catalog's
  // 200k for PRO_MAX, never the old hard-coded 1_000_000.
  assert.equal(monthlyLimitForStripePlan('PRO_MAX'), 200_000n);
});

test('changePlan tolerates a legacy Number monthlyLimit without throwing', async () => {
  userRow = { id: 'u1', plan: 'PRO', stripeSubscriptionId: 'sub_1', monthlyLimit: 1000 }; // plain Number
  updateArgs = null;
  const res = await proration.changePlan('u1', 'PRO_MAX', true);
  assert.equal(res.success, true);
  assert.equal(updateArgs.data.monthlyLimit, 1000n + monthlyLimitForStripePlan('PRO_MAX'));
});

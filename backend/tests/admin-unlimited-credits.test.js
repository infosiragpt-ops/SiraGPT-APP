'use strict';

/**
 * Administrators own the platform: never gated by plan, never metered.
 *  - auth.applyAdminEntitlements presents admins as ENTERPRISE (top tier)
 *    while preserving billingPlan.
 *  - chargeCredits skips the ledger for admins / super-admins / ENTERPRISE.
 *  - /api/credits/me flags `unlimited` for them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { applyAdminEntitlements } = require('../src/middleware/auth');
const { hasUnlimitedCredits, chargeCredits } = require('../src/middleware/charge-credits');

test('applyAdminEntitlements: admins become ENTERPRISE with billingPlan kept; others untouched', () => {
  const admin = applyAdminEntitlements({ id: 'a', isAdmin: true, plan: 'FREE' });
  assert.equal(admin.plan, 'ENTERPRISE');
  assert.equal(admin.billingPlan, 'FREE');
  assert.equal(admin.unlimitedCredits, true);
  const superAdmin = applyAdminEntitlements({ id: 's', isSuperAdmin: true, plan: 'PRO' });
  assert.equal(superAdmin.plan, 'ENTERPRISE');
  assert.equal(superAdmin.billingPlan, 'PRO');
  const enterprise = applyAdminEntitlements({ id: 'e', isAdmin: true, plan: 'ENTERPRISE' });
  assert.equal(enterprise.plan, 'ENTERPRISE');
  assert.equal(enterprise.billingPlan, undefined, 'already top tier: nothing to remember');
  const user = applyAdminEntitlements({ id: 'u', isAdmin: false, plan: 'PRO' });
  assert.equal(user.plan, 'PRO');
  assert.equal(user.unlimitedCredits, undefined);
  assert.equal(applyAdminEntitlements(null), null);
});

test('hasUnlimitedCredits: admin, super-admin and ENTERPRISE only', () => {
  assert.equal(hasUnlimitedCredits({ isAdmin: true }), true);
  assert.equal(hasUnlimitedCredits({ isSuperAdmin: true }), true);
  assert.equal(hasUnlimitedCredits({ plan: 'ENTERPRISE' }), true);
  assert.equal(hasUnlimitedCredits({ plan: 'enterprise' }), true);
  assert.equal(hasUnlimitedCredits({ plan: 'PRO_MAX' }), false);
  assert.equal(hasUnlimitedCredits({ plan: 'FREE', isAdmin: false }), false);
  assert.equal(hasUnlimitedCredits(null), false);
});

test('chargeCredits: an admin request runs the feature without touching the ledger', async () => {
  const mw = chargeCredits({ feature: 'image_generation', cost: 5 });
  const headers = {};
  const req = { user: { id: 'admin-1', isAdmin: true, plan: 'ENTERPRISE' }, body: {}, headers: {}, method: 'POST', originalUrl: '/api/images' };
  const res = { set: (k, v) => { headers[k] = v; }, status: () => { throw new Error('must not respond'); } };
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req._creditsUnlimited, true);
  assert.equal(req._chargedCredits, null);
  assert.equal(headers['x-sira-credits'], 'unlimited');
});

test('wiring: auth applies entitlements on every req.user assignment; /me flags unlimited; badge shows ∞', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const auth = read('src/middleware/auth.js');
  assert.equal((auth.match(/req\.user = applyAdminEntitlements\(/g) || []).length, 3);
  assert.doesNotMatch(auth, /req\.user = (row|session|validated)\.user;/);
  const credits = read('src/routes/credits.js');
  assert.match(credits, /if \(credits && hasUnlimitedCredits\(req\.user\)\) credits\.unlimited = true;/);
  const badge = fs.readFileSync(path.join(__dirname, '..', '..', 'components', 'CreditsBadge.tsx'), 'utf8');
  assert.match(badge, /credits\.unlimited \? "∞"/);
  const svc = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'credits-service.ts'), 'utf8');
  assert.match(svc, /if \(credits\?\.unlimited\) return false/);
});

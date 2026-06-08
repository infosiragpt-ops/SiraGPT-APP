'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getPlanCatalog, premiumTokenGrant, gemaTokenGrant } = require('../src/services/plan-credits-catalog');
const {
  buildGema4VirtualModel,
  buildModelQuotaPolicy,
  getGema4RuntimeConfig,
  resolveModelForUser,
} = require('../src/services/model-quota-router');

test('plan catalog PRO grants 100k premium and 1M gema', () => {
  const catalog = getPlanCatalog('PRO');
  assert.equal(catalog.premiumTokens, 100_000);
  assert.equal(catalog.gemaTokenLimit, 1_000_000);
  assert.equal(String(premiumTokenGrant('PRO')), '100000');
  assert.equal(String(gemaTokenGrant('PRO')), '1000000');
});

test('plan catalog PRO_MAX grants 200k premium and 1M gema', () => {
  const catalog = getPlanCatalog('PRO_MAX');
  assert.equal(catalog.premiumTokens, 200_000);
  assert.equal(catalog.gemaTokenLimit, 1_000_000);
  assert.equal(String(premiumTokenGrant('PRO_MAX')), '200000');
  assert.equal(String(gemaTokenGrant('PRO_MAX')), '1000000');
});

test('model router falls back to default Gema4 model when premium exhausted', () => {
  const routed = resolveModelForUser({
    plan: 'PRO',
    apiUsage: 200_000n,
    monthlyLimit: 100_000n,
    gemaTokenUsage: 0n,
    gemaTokenLimit: 1_000_000n,
  }, 'gpt-4o');
  assert.equal(typeof routed.model, 'string');
  assert.equal(typeof routed.provider, 'string');
  assert.equal(routed.blocked, false);
});

test('model quota policy exposes free daily call state', () => {
  const policy = buildModelQuotaPolicy({
    plan: 'FREE',
    monthlyCallLimit: 2,
    apiUsage: 0n,
    monthlyLimit: 0n,
    gemaTokenUsage: 0n,
    gemaTokenLimit: 0n,
  });

  assert.equal(policy.currentPlan, 'FREE');
  assert.equal(policy.defaultModel, null);
  assert.equal(policy.calls.dailyLimit, 3);
  assert.equal(policy.calls.remaining, 2);
  assert.equal(policy.calls.used, 1);
  assert.equal(policy.calls.exhausted, false);
  assert.equal(policy.gemaTokens.unlimited, true);
  assert.equal(policy.routing.freeTierUsesFallback, false);
  assert.equal(policy.notices[0].code, 'free_tier_daily_limit');
});

test('model quota policy reports exhausted premium fallback separately from Gema pool', () => {
  const policy = buildModelQuotaPolicy({
    plan: 'PRO',
    apiUsage: 100_000n,
    monthlyLimit: 100_000n,
    gemaTokenUsage: 10_000n,
    gemaTokenLimit: 1_000_000n,
  });

  assert.equal(policy.currentPlan, 'PRO');
  assert.equal(policy.defaultModel, null);
  assert.equal(policy.premiumTokens.exhausted, true);
  assert.equal(policy.premiumTokens.remaining, '0');
  assert.equal(policy.gemaTokens.exhausted, false);
  assert.equal(policy.gemaTokens.remaining, '990000');
  assert.equal(policy.notices.some((n) => n.code === 'premium_pool_exhausted_fallback_available'), true);
});

test('Gema4 defaults can be overridden via GEMA4_* env vars', () => {
  const env = {
    GEMA4_MODEL_ID: 'gpt-4o-mini',
    GEMA4_DISPLAY_NAME: 'Fallback Model',
    GEMA4_PROVIDER: 'OpenAI',
  };
  const config = getGema4RuntimeConfig(env);
  const virtual = buildGema4VirtualModel(env);
  assert.equal(config.model, 'gpt-4o-mini');
  assert.equal(config.displayName, 'Fallback Model');
  assert.equal(config.provider, 'OpenAI');
  assert.equal(virtual.name, 'gpt-4o-mini');
  assert.equal(virtual.displayName, 'Fallback Model');
});

test('GEMA4_* env vars override defaults', () => {
  const env = {
    GEMA4_MODEL_ID: 'custom-fallback',
    GEMA4_DISPLAY_NAME: 'Custom Fallback',
  };
  const config = getGema4RuntimeConfig(env);
  assert.equal(config.model, 'custom-fallback');
  assert.equal(config.displayName, 'Custom Fallback');
});

test('userQuotaDigest: FREE user sees plan + fallback brand + dailyCalls', () => {
  const { userQuotaDigest } = require('../src/services/model-quota-router');
  const digest = userQuotaDigest({
    plan: 'FREE',
    monthlyCallLimit: 3,
    apiUsage: 0n,
    monthlyLimit: 0n,
    gemaTokenUsage: 0n,
    gemaTokenLimit: 0n,
  });
  assert.equal(digest.plan, 'FREE');
  assert.equal(digest.premium.remaining, '0', 'FREE plan has 0 premium tokens remaining');
  assert.equal(digest.premium.limit, '0');
  assert.equal(typeof digest.fallback.provider, 'string');
  assert.equal(digest.dailyCalls.dailyLimit, 3);
  assert.equal(digest.dailyCalls.remaining, 3);
});

test('userQuotaDigest: PRO user with 70% premium usage reports pctUsed=70', () => {
  const { userQuotaDigest } = require('../src/services/model-quota-router');
  const digest = userQuotaDigest({
    plan: 'PRO',
    apiUsage: 70_000n,
    monthlyLimit: 100_000n,
    gemaTokenUsage: 0n,
    gemaTokenLimit: 1_000_000n,
  });
  assert.equal(digest.plan, 'PRO');
  assert.equal(digest.premium.unlimited, false);
  assert.equal(digest.premium.pctUsed, 70);
  assert.equal(digest.premium.exhausted, false);
});

test('userQuotaDigest.flashGptStatus: inlined per-day quota check', () => {
  const { userQuotaDigest } = require('../src/services/model-quota-router');
  const digest = userQuotaDigest({
    plan: 'PRO',
    apiUsage: 0n,
    monthlyLimit: 100_000n,
    gemaTokenUsage: 0n,
    gemaTokenLimit: 1_000_000n,
  });
  assert.ok(digest.flashGptStatus, 'flashGptStatus should be inlined on the digest');
  assert.equal(typeof digest.flashGptStatus.ok, 'boolean');
});

test('userQuotaDigest.upgradeHint: inlined — FREE user sees PRO suggestion', () => {
  const { userQuotaDigest } = require('../src/services/model-quota-router');
  const digest = userQuotaDigest({
    plan: 'FREE',
    apiUsage: 0n,
    monthlyLimit: 0n,
    gemaTokenUsage: 0n,
    gemaTokenLimit: 0n,
  });
  assert.ok(digest.upgradeHint);
  assert.equal(digest.upgradeHint.from, 'FREE');
  assert.equal(digest.upgradeHint.to, 'PRO');
});

test('userQuotaDigest.upgradeHint: PRO under 80% — no hint inlined', () => {
  const { userQuotaDigest } = require('../src/services/model-quota-router');
  const digest = userQuotaDigest({
    plan: 'PRO',
    apiUsage: 50_000n,
    monthlyLimit: 100_000n,
    gemaTokenUsage: 0n,
    gemaTokenLimit: 1_000_000n,
  });
  assert.equal(digest.upgradeHint, null);
});

test('suggestUpgradePlan: FREE always suggests PRO', () => {
  const { suggestUpgradePlan } = require('../src/services/model-quota-router');
  const r = suggestUpgradePlan({ plan: 'FREE', premium: { remaining: '0' } });
  assert.equal(r.from, 'FREE');
  assert.equal(r.to, 'PRO');
});

test('suggestUpgradePlan: PRO under 80% returns null (no upgrade needed)', () => {
  const { suggestUpgradePlan } = require('../src/services/model-quota-router');
  assert.equal(suggestUpgradePlan({ plan: 'PRO', premium: { pctUsed: 50 } }), null);
});

test('suggestUpgradePlan: PRO at >=80% suggests PRO_MAX', () => {
  const { suggestUpgradePlan } = require('../src/services/model-quota-router');
  const r = suggestUpgradePlan({ plan: 'PRO', premium: { pctUsed: 85 } });
  assert.equal(r.from, 'PRO');
  assert.equal(r.to, 'PRO_MAX');
  assert.match(r.reason, /85/);
});

test('suggestUpgradePlan: PRO_MAX at >=80% suggests ENTERPRISE', () => {
  const { suggestUpgradePlan } = require('../src/services/model-quota-router');
  const r = suggestUpgradePlan({ plan: 'PRO_MAX', premium: { pctUsed: 90 } });
  assert.equal(r.from, 'PRO_MAX');
  assert.equal(r.to, 'ENTERPRISE');
});

test('suggestUpgradePlan: ENTERPRISE unlimited returns null', () => {
  const { suggestUpgradePlan } = require('../src/services/model-quota-router');
  assert.equal(
    suggestUpgradePlan({ plan: 'ENTERPRISE', premium: { unlimited: true } }),
    null,
  );
});

test('isWithinFreeIaQuota: paid plan returns ok=true + dailyLimit=null', () => {
  const { isWithinFreeIaQuota } = require('../src/services/model-quota-router');
  const r = isWithinFreeIaQuota({ plan: 'PRO' });
  assert.equal(r.ok, true);
  assert.equal(r.dailyLimit, null);
  assert.equal(r.remaining, null);
});

test('isWithinFreeIaQuota: handles null user (anonymous) gracefully', () => {
  const { isWithinFreeIaQuota } = require('../src/services/model-quota-router');
  const r = isWithinFreeIaQuota(null);
  assert.equal(typeof r.ok, 'boolean');
});

test('suggestUpgradePlan: null/empty digest returns null safely', () => {
  const { suggestUpgradePlan } = require('../src/services/model-quota-router');
  assert.equal(suggestUpgradePlan(null), null);
  assert.equal(suggestUpgradePlan({}), null);
});

test('userQuotaDigest: ENTERPRISE unlimited premium reports pctUsed=null', () => {
  const { userQuotaDigest } = require('../src/services/model-quota-router');
  const digest = userQuotaDigest({
    plan: 'ENTERPRISE',
    apiUsage: 999_999n,
    monthlyLimit: 0n,
    gemaTokenUsage: 0n,
    gemaTokenLimit: 0n,
  });
  assert.equal(digest.plan, 'ENTERPRISE');
  assert.equal(digest.premium.unlimited, true);
  assert.equal(digest.premium.pctUsed, null);
});

test('Gema4 fallback can be configured by environment without exposing secrets', () => {
  const env = {
    GEMA4_MODEL_ID: 'custom-gema4',
    GEMA4_PROVIDER: 'OpenRouter',
    GEMA4_DISPLAY_NAME: 'Gema4 Custom',
    GEMA4_ICON: 'CustomLogo',
  };
  const config = getGema4RuntimeConfig(env);
  const virtual = buildGema4VirtualModel(env);
  const routed = resolveModelForUser({
    plan: 'FREE',
    gemaTokenUsage: 0n,
    gemaTokenLimit: 0n,
  }, 'gpt-5', env);

  assert.deepEqual(config, {
    model: 'custom-gema4',
    provider: 'OpenRouter',
    displayName: 'Gema4 Custom',
    icon: 'CustomLogo',
  });
  assert.equal(virtual.name, 'custom-gema4');
  assert.equal(virtual.provider, 'OpenRouter');
  assert.equal(routed.model, 'gpt-5');
  assert.equal(routed.provider, null);
  assert.equal(routed.fallbackModel, 'custom-gema4');
});

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

test('plan catalog PRO grants 100k premium and 500k gema', () => {
  const catalog = getPlanCatalog('PRO');
  assert.equal(catalog.premiumTokens, 100_000);
  assert.equal(catalog.gemaTokenLimit, 500_000);
  assert.equal(String(premiumTokenGrant('PRO')), '100000');
  assert.equal(String(gemaTokenGrant('PRO')), '500000');
});

test('model router falls back to Gema4 when premium exhausted', () => {
  const routed = resolveModelForUser({
    plan: 'PRO',
    apiUsage: 200_000n,
    monthlyLimit: 100_000n,
    gemaTokenUsage: 0n,
    gemaTokenLimit: 500_000n,
  }, 'gpt-4o');
  assert.equal(routed.model, 'Gema4-31B');
  assert.equal(routed.provider, 'OpenAI');
  assert.equal(routed.blocked, false);
});

test('model quota policy exposes free default and daily call state', () => {
  const policy = buildModelQuotaPolicy({
    plan: 'FREE',
    monthlyCallLimit: 2,
    apiUsage: 0n,
    monthlyLimit: 0n,
    gemaTokenUsage: 0n,
    gemaTokenLimit: 0n,
  });

  assert.equal(policy.currentPlan, 'FREE');
  assert.equal(policy.defaultModel.name, 'Gema4-31B');
  assert.equal(policy.defaultModel.provider, 'OpenAI');
  assert.equal(policy.calls.dailyLimit, 3);
  assert.equal(policy.calls.remaining, 2);
  assert.equal(policy.calls.exhausted, false);
  assert.equal(policy.gemaTokens.unlimited, true);
  assert.equal(policy.notices[0].code, 'free_tier_default_model');
});

test('model quota policy reports exhausted premium fallback separately from Gema pool', () => {
  const policy = buildModelQuotaPolicy({
    plan: 'PRO',
    apiUsage: 100_000n,
    monthlyLimit: 100_000n,
    gemaTokenUsage: 10_000n,
    gemaTokenLimit: 500_000n,
  });

  assert.equal(policy.currentPlan, 'PRO');
  assert.equal(policy.defaultModel, null);
  assert.equal(policy.premiumTokens.exhausted, true);
  assert.equal(policy.premiumTokens.remaining, '0');
  assert.equal(policy.gemaTokens.exhausted, false);
  assert.equal(policy.gemaTokens.remaining, '490000');
  assert.equal(policy.notices.some((n) => n.code === 'premium_pool_exhausted_fallback_available'), true);
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
  assert.equal(routed.model, 'custom-gema4');
  assert.equal(routed.provider, 'OpenRouter');
});

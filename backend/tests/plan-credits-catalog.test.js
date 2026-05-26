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

test('model router falls back to FlashGPT (Cerebras Llama 3.1 8B) when premium exhausted', () => {
  const routed = resolveModelForUser({
    plan: 'PRO',
    apiUsage: 200_000n,
    monthlyLimit: 100_000n,
    gemaTokenUsage: 0n,
    gemaTokenLimit: 500_000n,
  }, 'gpt-4o');
  // Defaults updated to match the product spec (FlashGPT = Llama 3.1 8B
  // via Cerebras). Legacy `GEMA4_*` env vars still override.
  assert.equal(routed.model, 'llama3.1-8b');
  assert.equal(routed.provider, 'Cerebras');
  assert.equal(routed.blocked, false);
});

test('model quota policy exposes free default and unlimited call state', () => {
  const policy = buildModelQuotaPolicy({
    plan: 'FREE',
    monthlyCallLimit: 2,
    apiUsage: 0n,
    monthlyLimit: 0n,
    gemaTokenUsage: 0n,
    gemaTokenLimit: 0n,
  });

  assert.equal(policy.currentPlan, 'FREE');
  assert.equal(policy.defaultModel.name, 'llama3.1-8b');
  assert.equal(policy.defaultModel.provider, 'Cerebras');
  assert.equal(policy.calls.dailyLimit, null);
  assert.equal(policy.calls.remaining, null);
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

test('FlashGPT defaults can be overridden via FREE_IA_* env vars (new brand naming)', () => {
  const env = {
    FREE_IA_MODEL_ID: 'llama-3.1-70b',
    FREE_IA_DISPLAY_NAME: 'FlashGPT Pro',
  };
  const config = getGema4RuntimeConfig(env);
  const virtual = buildGema4VirtualModel(env);
  assert.equal(config.model, 'llama-3.1-70b');
  assert.equal(config.displayName, 'FlashGPT Pro');
  assert.equal(config.provider, 'Cerebras');
  assert.equal(virtual.name, 'llama-3.1-70b');
  assert.equal(virtual.displayName, 'FlashGPT Pro');
});

test('GEMA4_* env vars still override FREE_IA_* (backwards compatibility)', () => {
  const env = {
    GEMA4_MODEL_ID: 'legacy-gema4',
    FREE_IA_MODEL_ID: 'llama-3.1-70b',
    GEMA4_DISPLAY_NAME: 'Legacy Gema4',
    FREE_IA_DISPLAY_NAME: 'FlashGPT Pro',
  };
  const config = getGema4RuntimeConfig(env);
  assert.equal(config.model, 'legacy-gema4', 'GEMA4_MODEL_ID must win over FREE_IA_MODEL_ID');
  assert.equal(config.displayName, 'Legacy Gema4');
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

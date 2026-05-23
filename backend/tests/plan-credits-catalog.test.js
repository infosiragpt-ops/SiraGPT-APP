'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getPlanCatalog, premiumTokenGrant, gemaTokenGrant } = require('../src/services/plan-credits-catalog');
const { resolveModelForUser } = require('../src/services/model-quota-router');

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
  assert.equal(routed.blocked, false);
});

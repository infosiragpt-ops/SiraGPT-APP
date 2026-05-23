'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveModelForUser } = require('../src/services/model-fallback');

describe('model-fallback', () => {
  test('FREE users are routed to Gema4 when selecting premium model', () => {
    const result = resolveModelForUser({
      user: { plan: 'FREE', apiUsage: 0, monthlyLimit: 0 },
      requestedModel: 'gpt-5',
      requestedProvider: 'OpenAI',
    });
    assert.equal(result.model, 'gema4-31b');
    assert.equal(result.fallbackApplied, true);
    assert.equal(result.reason, 'free_plan_default');
  });

  test('PRO users keep premium model when quota available', () => {
    const result = resolveModelForUser({
      user: { plan: 'PRO', apiUsage: 1000, monthlyLimit: 100_000, gemmaTokenPool: 500_000, gemmaTokenUsage: 0 },
      requestedModel: 'gpt-5',
      requestedProvider: 'OpenAI',
    });
    assert.equal(result.model, 'gpt-5');
    assert.equal(result.fallbackApplied, false);
  });

  test('PRO users fall back to Gema4 when premium quota exhausted', () => {
    const result = resolveModelForUser({
      user: { plan: 'PRO', apiUsage: 100_000, monthlyLimit: 100_000, gemmaTokenPool: 500_000, gemmaTokenUsage: 0 },
      requestedModel: 'gpt-5',
      requestedProvider: 'OpenAI',
    });
    assert.equal(result.model, 'gema4-31b');
    assert.equal(result.fallbackApplied, true);
    assert.equal(result.reason, 'premium_quota_exhausted');
  });
});

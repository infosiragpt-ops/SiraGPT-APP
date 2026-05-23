'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FREE_DAILY_CALL_LIMIT,
  getPremiumCreditsForPlan,
  getGemmaCreditsForPlan,
  isFreeTierModel,
  computePlanCreditTotals,
} = require('../src/services/plan-credits');

describe('plan-credits', () => {
  test('FREE daily call limit is 3', () => {
    assert.equal(FREE_DAILY_CALL_LIMIT, 3);
  });

  test('PRO grants 100k premium + 500k Gema4', () => {
    assert.equal(getPremiumCreditsForPlan('PRO'), 100_000n);
    assert.equal(getGemmaCreditsForPlan('PRO'), 500_000n);
  });

  test('PRO_MAX grants 300k premium + 1M Gema4', () => {
    assert.equal(getPremiumCreditsForPlan('PRO_MAX'), 300_000n);
    assert.equal(getGemmaCreditsForPlan('PRO_MAX'), 1_000_000n);
  });

  test('isFreeTierModel recognizes Gema4 aliases', () => {
    assert.equal(isFreeTierModel('gema4-31b'), true);
    assert.equal(isFreeTierModel('gpt-5'), false);
  });

  test('computePlanCreditTotals adds to existing balances', () => {
    const totals = computePlanCreditTotals(
      { monthlyLimit: 50_000n, gemmaTokenPool: 10_000n },
      'PRO',
    );
    assert.equal(totals.monthlyLimit, 150_000n);
    assert.equal(totals.gemmaTokenPool, 510_000n);
  });
});

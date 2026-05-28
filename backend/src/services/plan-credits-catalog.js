'use strict';

/**
 * Central plan credits catalog — premium tokens, Gema4 pool, daily call limits.
 */

const PLANS = Object.freeze({
  FREE: {
    plan: 'FREE',
    premiumTokens: 0,
    gemaTokenLimit: 0,
    gemaUnlimited: true,
    dailyCalls: 3,
    priceUsd: 0,
  },
  PRO: {
    plan: 'PRO',
    premiumTokens: 100_000,
    gemaTokenLimit: 500_000,
    gemaUnlimited: false,
    dailyCalls: null,
    priceUsd: 5,
  },
  PRO_MAX: {
    plan: 'PRO_MAX',
    premiumTokens: 300_000,
    gemaTokenLimit: 1_000_000,
    gemaUnlimited: false,
    dailyCalls: null,
    priceUsd: 10,
  },
  ENTERPRISE: {
    plan: 'ENTERPRISE',
    premiumTokens: null,
    gemaTokenLimit: 0,
    gemaUnlimited: true,
    dailyCalls: null,
    priceUsd: 2,
    payAsYouGo: true,
  },
});

const GEMA4_MODEL_ID = 'Gema4-31B';

function getPlanCatalog(plan) {
  const key = String(plan || 'FREE').toUpperCase();
  return PLANS[key] || PLANS.FREE;
}

function premiumTokenGrant(plan) {
  const catalog = getPlanCatalog(plan);
  if (catalog.premiumTokens == null) return 10_000_000n;
  return BigInt(catalog.premiumTokens);
}

function gemaTokenGrant(plan) {
  const catalog = getPlanCatalog(plan);
  if (catalog.gemaUnlimited) return 0n;
  return BigInt(catalog.gemaTokenLimit || 0);
}

function monthlyLimitForStripePlan(plan) {
  return premiumTokenGrant(plan);
}

module.exports = {
  PLANS,
  GEMA4_MODEL_ID,
  getPlanCatalog,
  premiumTokenGrant,
  gemaTokenGrant,
  monthlyLimitForStripePlan,
};

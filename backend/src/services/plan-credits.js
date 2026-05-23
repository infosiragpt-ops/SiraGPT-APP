'use strict';

/**
 * plan-credits — single source of truth for plan token allocations.
 *
 * Business rules (siraGPT billing):
 *   FREE        — 3 calls/day on the default Gema4 model (no premium pool)
 *   PRO ($5)    — 100k premium tokens + 500k Gema4 pool
 *   PRO_MAX ($10) — 300k premium tokens + 1M Gema4 pool
 *   ENTERPRISE  — pay-as-you-go; credits added per top-up (min $2)
 *
 * Margin target (30%) is enforced upstream in pricing — not exposed
 * to end users in API responses.
 */

const FREE_DAILY_CALL_LIMIT = 3;

/** Premium (any catalog model) token grants on purchase / renewal */
const PREMIUM_TOKEN_CREDITS = Object.freeze({
  PRO: 100_000n,
  PRO_MAX: 300_000n,
  ENTERPRISE: 0n,
});

/** Dedicated Gema4 31B pool — consumed when premium quota is exhausted */
const GEMMA_TOKEN_CREDITS = Object.freeze({
  PRO: 500_000n,
  PRO_MAX: 1_000_000n,
  ENTERPRISE: 0n,
});

/** Default free-tier model — always available without premium credits */
const FREE_DEFAULT_MODEL = Object.freeze({
  name: 'gema4-31b',
  displayName: 'Gema4 31B',
  provider: 'Gemini',
  type: 'TEXT',
  icon: 'GeminiLogo',
  description: 'Modelo gratuito de frontera Gema4 31B — disponible para todos los planes.',
});

const FREE_MODEL_ALIASES = Object.freeze([
  FREE_DEFAULT_MODEL.name,
  'gemma-3-31b-it',
  'gemini-2.5-flash-lite',
]);

function getPremiumCreditsForPlan(plan) {
  return PREMIUM_TOKEN_CREDITS[plan] ?? 0n;
}

function getGemmaCreditsForPlan(plan) {
  return GEMMA_TOKEN_CREDITS[plan] ?? 0n;
}

function isFreeTierModel(modelName) {
  if (!modelName) return false;
  const normalized = String(modelName).toLowerCase();
  return FREE_MODEL_ALIASES.some((alias) => normalized === alias.toLowerCase());
}

function getPlanCreditBundle(plan) {
  return {
    premium: getPremiumCreditsForPlan(plan),
    gemma: getGemmaCreditsForPlan(plan),
  };
}

/**
 * computePlanCreditTotals — additive credit grant for checkout /
 * webhook handlers. Preserves existing balances.
 */
function computePlanCreditTotals(currentUser, plan) {
  const bundle = getPlanCreditBundle(plan);
  const currentLimit = typeof currentUser?.monthlyLimit === 'bigint'
    ? currentUser.monthlyLimit
    : BigInt(currentUser?.monthlyLimit ?? 0);
  const currentGemmaPool = typeof currentUser?.gemmaTokenPool === 'bigint'
    ? currentUser.gemmaTokenPool
    : BigInt(currentUser?.gemmaTokenPool ?? 0);

  return {
    monthlyLimit: currentLimit + bundle.premium,
    gemmaTokenPool: currentGemmaPool + bundle.gemma,
    premiumAdded: bundle.premium,
    gemmaAdded: bundle.gemma,
  };
}

module.exports = {
  FREE_DAILY_CALL_LIMIT,
  PREMIUM_TOKEN_CREDITS,
  GEMMA_TOKEN_CREDITS,
  FREE_DEFAULT_MODEL,
  FREE_MODEL_ALIASES,
  getPremiumCreditsForPlan,
  getGemmaCreditsForPlan,
  isFreeTierModel,
  getPlanCreditBundle,
  computePlanCreditTotals,
};

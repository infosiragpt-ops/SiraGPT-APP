'use strict';

const { getPlanCatalog, GEMA4_MODEL_ID } = require('./plan-credits-catalog');

function toBigInt(value) {
  if (value == null) return 0n;
  if (typeof value === 'bigint') return value;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * Resolve which model to use based on premium vs Gema pool exhaustion.
 */
function resolveModelForUser(user, requestedModel) {
  const plan = user?.plan || 'FREE';
  const catalog = getPlanCatalog(plan);
  const premiumUsage = toBigInt(user?.apiUsage);
  const premiumLimit = toBigInt(user?.monthlyLimit);
  const gemaUsage = toBigInt(user?.gemaTokenUsage);
  const gemaLimit = toBigInt(user?.gemaTokenLimit);

  const premiumExhausted = premiumLimit > 0n && premiumUsage >= premiumLimit;
  const gemaExhausted = !catalog.gemaUnlimited && gemaLimit > 0n && gemaUsage >= gemaLimit;

  if (plan === 'FREE' || premiumExhausted) {
    if (gemaExhausted && !catalog.gemaUnlimited) {
      return {
        model: requestedModel,
        blocked: true,
        reason: 'quota_exceeded',
        fallbackModel: GEMA4_MODEL_ID,
      };
    }
    return {
      model: GEMA4_MODEL_ID,
      blocked: false,
      reason: premiumExhausted ? 'premium_exhausted_gema_fallback' : 'free_tier_gema',
      fallbackModel: GEMA4_MODEL_ID,
      originalModel: requestedModel,
    };
  }

  return {
    model: requestedModel,
    blocked: false,
    reason: 'premium_available',
    fallbackModel: GEMA4_MODEL_ID,
  };
}

function persistModelPreference(settings, modelId) {
  const base = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? { ...settings }
    : {};
  base.lastResolvedModel = modelId;
  base.modelRouterUpdatedAt = new Date().toISOString();
  return base;
}

module.exports = {
  GEMA4_MODEL_ID,
  resolveModelForUser,
  persistModelPreference,
  toBigInt,
};

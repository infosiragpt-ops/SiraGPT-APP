'use strict';

const { getPlanQuotaSnapshot } = require('./plan-quota');
const {
  FREE_DEFAULT_MODEL,
  isFreeTierModel,
} = require('./plan-credits');

/**
 * resolveModelForUser — backend-only model resolution. When premium
 * credits are exhausted the caller transparently falls back to Gema4
 * 31B without changing the UI selection. FREE users are always routed
 * to the free-tier model unless they explicitly chose it already.
 *
 * @returns {{ model: string, provider: string, fallbackApplied: boolean, reason?: string }}
 */
function resolveModelForUser({ user, requestedModel, requestedProvider }) {
  const model = String(requestedModel || '').trim();
  const provider = String(requestedProvider || '').trim();

  if (!user) {
    return { model, provider, fallbackApplied: false };
  }

  if (user.plan === 'FREE') {
    if (!isFreeTierModel(model)) {
      return {
        model: FREE_DEFAULT_MODEL.name,
        provider: FREE_DEFAULT_MODEL.provider,
        fallbackApplied: true,
        reason: 'free_plan_default',
      };
    }
    return { model, provider: provider || FREE_DEFAULT_MODEL.provider, fallbackApplied: false };
  }

  if (isFreeTierModel(model)) {
    return { model, provider: provider || FREE_DEFAULT_MODEL.provider, fallbackApplied: false };
  }

  const snapshot = getPlanQuotaSnapshot(user);
  if (snapshot.exceeded) {
    const gemmaPool = Number(user.gemmaTokenPool ?? 0);
    const gemmaUsed = Number(user.gemmaTokenUsage ?? 0);
    const gemmaRemaining = Math.max(0, gemmaPool - gemmaUsed);

    if (gemmaRemaining > 0 || user.plan === 'ENTERPRISE') {
      return {
        model: FREE_DEFAULT_MODEL.name,
        provider: FREE_DEFAULT_MODEL.provider,
        fallbackApplied: true,
        reason: 'premium_quota_exhausted',
      };
    }

    return {
      model: FREE_DEFAULT_MODEL.name,
      provider: FREE_DEFAULT_MODEL.provider,
      fallbackApplied: true,
      reason: 'all_quota_exhausted',
    };
  }

  return { model, provider, fallbackApplied: false };
}

module.exports = {
  resolveModelForUser,
};

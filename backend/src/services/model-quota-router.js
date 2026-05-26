'use strict';

const { getPlanCatalog, GEMA4_MODEL_ID } = require('./plan-credits-catalog');
const {
  DEFAULT_MODEL: CEREBRAS_DEFAULT_MODEL,
  DEFAULT_DISPLAY_NAME: CEREBRAS_DEFAULT_DISPLAY_NAME,
  PROVIDER_NAME: CEREBRAS_PROVIDER_NAME,
} = require('./ai/cerebras-client');

// Defaults moved from OpenAI/Gema4-31B → Cerebras/Llama-3.1-8b/"FlashGPT" to
// match the product spec in docs/SIraGPT.docx (FlashGPT = Llama 3.1 8B via
// Cerebras). Legacy GEMA4_* env vars still override per deployment.
const DEFAULT_GEMA4_DISPLAY_NAME = CEREBRAS_DEFAULT_DISPLAY_NAME;
const DEFAULT_GEMA4_PROVIDER = CEREBRAS_PROVIDER_NAME;
const DEFAULT_GEMA4_ICON = 'CerebrasLogo';
const DEFAULT_GEMA4_MODEL_ID = CEREBRAS_DEFAULT_MODEL;

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizePlan(plan) {
  return String(plan || 'FREE').trim().toUpperCase() || 'FREE';
}

function toBigInt(value) {
  if (value == null) return 0n;
  if (typeof value === 'bigint') return value;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function toSafeNumber(value, fallback = 0) {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampBigInt(value, min = 0n) {
  return value < min ? min : value;
}

function finiteTokenPool({ used, limit }) {
  const safeUsed = clampBigInt(used);
  const safeLimit = clampBigInt(limit);
  const remaining = clampBigInt(safeLimit - safeUsed);
  return {
    used: safeUsed.toString(),
    limit: safeLimit.toString(),
    remaining: remaining.toString(),
    unlimited: false,
    exhausted: safeLimit > 0n && safeUsed >= safeLimit,
  };
}

function unlimitedTokenPool({ used }) {
  const safeUsed = clampBigInt(used);
  return {
    used: safeUsed.toString(),
    limit: null,
    remaining: null,
    unlimited: true,
    exhausted: false,
  };
}

function getGema4RuntimeConfig(env = process.env) {
  // Resolution order: explicit GEMA4_* env (legacy) → FREE_IA_* env (new
  // brand) → static defaults pointing at Cerebras Llama 3.1 8B.
  const model = cleanString(env.GEMA4_MODEL_ID)
    || cleanString(env.FREE_IA_MODEL_ID)
    || DEFAULT_GEMA4_MODEL_ID
    || GEMA4_MODEL_ID;
  const provider = cleanString(env.GEMA4_PROVIDER) || DEFAULT_GEMA4_PROVIDER;
  const displayName = cleanString(env.GEMA4_DISPLAY_NAME)
    || cleanString(env.FREE_IA_DISPLAY_NAME)
    || DEFAULT_GEMA4_DISPLAY_NAME;
  const icon = cleanString(env.GEMA4_ICON) || DEFAULT_GEMA4_ICON;
  return { model, provider, displayName, icon };
}

function buildGema4VirtualModel(env = process.env) {
  const config = getGema4RuntimeConfig(env);
  return {
    id: `__virtual_${config.model.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}__`,
    name: config.model,
    displayName: config.displayName,
    provider: config.provider,
    description: 'Modelo gratuito predeterminado configurado para el fallback de SiraGPT.',
    type: 'TEXT',
    icon: config.icon,
    virtual: true,
  };
}

function buildModelQuotaPolicy(user, env = process.env) {
  const currentPlan = normalizePlan(user?.plan);
  const catalog = getPlanCatalog(currentPlan);
  const fallbackConfig = getGema4RuntimeConfig(env);
  const premiumUsage = toBigInt(user?.apiUsage);
  const premiumLimit = toBigInt(user?.monthlyLimit);
  const gemaUsage = toBigInt(user?.gemaTokenUsage);
  const gemaLimit = toBigInt(user?.gemaTokenLimit);
  const freeDailyLimit = toSafeNumber(catalog.dailyCalls, null);
  const freeRemainingCalls = currentPlan === 'FREE' && freeDailyLimit != null
    ? Math.max(0, Math.min(freeDailyLimit || 0, toSafeNumber(user?.monthlyCallLimit, freeDailyLimit || 0)))
    : null;
  const premiumPool = currentPlan === 'ENTERPRISE' && premiumLimit <= 0n
    ? unlimitedTokenPool({ used: premiumUsage })
    : finiteTokenPool({ used: premiumUsage, limit: premiumLimit });
  const gemaPool = catalog.gemaUnlimited
    ? unlimitedTokenPool({ used: gemaUsage })
    : finiteTokenPool({ used: gemaUsage, limit: gemaLimit });

  const notices = [];
  if (currentPlan === 'FREE') {
    notices.push({
      code: 'free_tier_default_model',
      level: 'info',
      message: `${fallbackConfig.displayName} es el modelo predeterminado para el plan gratuito.`,
    });
  }
  if (premiumPool.exhausted && !gemaPool.exhausted) {
    notices.push({
      code: 'premium_pool_exhausted_fallback_available',
      level: 'warning',
      message: `Los tokens premium estan agotados; SiraGPT usara ${fallbackConfig.displayName} como fallback.`,
    });
  }
  if (gemaPool.exhausted) {
    notices.push({
      code: 'fallback_pool_exhausted',
      level: 'error',
      message: `El pool de ${fallbackConfig.displayName} esta agotado para el plan actual.`,
    });
  }

  return {
    currentPlan,
    defaultModel: currentPlan === 'FREE'
      ? { name: fallbackConfig.model, provider: fallbackConfig.provider, displayName: fallbackConfig.displayName }
      : null,
    fallbackModel: { name: fallbackConfig.model, provider: fallbackConfig.provider, displayName: fallbackConfig.displayName },
    calls: {
      dailyLimit: freeDailyLimit,
      remaining: freeRemainingCalls,
      exhausted: currentPlan === 'FREE' && freeDailyLimit != null ? freeRemainingCalls <= 0 : false,
    },
    premiumTokens: premiumPool,
    gemaTokens: gemaPool,
    routing: {
      freeTierUsesFallback: currentPlan === 'FREE',
      premiumExhaustionUsesFallback: true,
      blockedWhenFallbackExhausted: !catalog.gemaUnlimited,
    },
    notices,
  };
}

/**
 * Resolve which model to use based on premium vs Gema pool exhaustion.
 */
function resolveModelForUser(user, requestedModel, env = process.env) {
  const plan = normalizePlan(user?.plan);
  const catalog = getPlanCatalog(plan);
  const fallbackConfig = getGema4RuntimeConfig(env);
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
        fallbackModel: fallbackConfig.model,
        provider: fallbackConfig.provider,
      };
    }
    return {
      model: fallbackConfig.model,
      blocked: false,
      reason: premiumExhausted ? 'premium_exhausted_gema_fallback' : 'free_tier_gema',
      fallbackModel: fallbackConfig.model,
      provider: fallbackConfig.provider,
      originalModel: requestedModel,
    };
  }

  return {
    model: requestedModel,
    blocked: false,
    reason: 'premium_available',
    fallbackModel: fallbackConfig.model,
    provider: null,
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

/**
 * Combined plan + Free-IA descriptor for a user. Useful for the
 * frontend's account page where a single panel shows "you're on PRO,
 * 27% of premium pool spent, FlashGPT is your fallback".
 *
 * Doesn't replace buildModelQuotaPolicy (which is the full ledger
 * surface) — this is a smaller, friendlier projection.
 */
/**
 * Suggest the next plan tier when a user is close to their premium
 * quota. Pure mapping — returns null when no upgrade is needed.
 *
 *   FREE      (pctUsed N/A — premium is 0)  → suggest PRO  always
 *   PRO       (pctUsed >= 80%)              → suggest PRO_MAX
 *   PRO_MAX   (pctUsed >= 80%)              → suggest ENTERPRISE
 *   ENTERPRISE (unlimited)                  → null
 */
function suggestUpgradePlan(digest) {
  if (!digest || !digest.plan) return null;
  if (digest.plan === 'FREE') {
    return { from: 'FREE', to: 'PRO', reason: 'free_plan_has_no_premium_tokens' };
  }
  if (digest.premium && digest.premium.unlimited) return null;
  const pct = digest.premium && Number.isFinite(digest.premium.pctUsed)
    ? digest.premium.pctUsed
    : 0;
  if (pct < 80) return null;
  if (digest.plan === 'PRO') {
    return { from: 'PRO', to: 'PRO_MAX', reason: `premium_pool_${pct.toFixed(1)}pct_used` };
  }
  if (digest.plan === 'PRO_MAX') {
    return { from: 'PRO_MAX', to: 'ENTERPRISE', reason: `premium_pool_${pct.toFixed(1)}pct_used` };
  }
  return null;
}

function userQuotaDigest(user, env = process.env) {
  const policy = buildModelQuotaPolicy(user, env);
  const fallback = getGema4RuntimeConfig(env);
  const premiumPool = policy.premiumTokens;
  const premiumPct = (() => {
    if (premiumPool.unlimited) return null;
    const limit = Number(premiumPool.limit || 0);
    if (limit <= 0) return null;
    const used = Number(premiumPool.used || 0);
    return Math.min(100, Math.round((used / limit) * 1000) / 10);
  })();
  const digest = {
    plan: policy.currentPlan,
    premium: {
      unlimited: premiumPool.unlimited,
      remaining: premiumPool.remaining,
      used: premiumPool.used,
      limit: premiumPool.limit,
      pctUsed: premiumPct,
      exhausted: premiumPool.exhausted,
    },
    fallback: {
      model: fallback.model,
      displayName: fallback.displayName,
      provider: fallback.provider,
    },
    dailyCalls: policy.calls,
  };
  // Inline the upgrade hint so the UI doesn't need a second round-trip.
  digest.upgradeHint = suggestUpgradePlan(digest);
  return digest;
}

module.exports = {
  GEMA4_MODEL_ID,
  buildGema4VirtualModel,
  buildModelQuotaPolicy,
  getGema4RuntimeConfig,
  normalizePlan,
  resolveModelForUser,
  persistModelPreference,
  userQuotaDigest,
  suggestUpgradePlan,
  toBigInt,
};

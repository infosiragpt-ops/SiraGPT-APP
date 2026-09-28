'use strict';

const DEFAULT_PAID_PLANS = Object.freeze([
  'PRO',
  'PRO_MAX',
  'ENTERPRISE',
]);
const ACTIVE_SUBSCRIPTION_STATES = new Set(['active', 'trialing']);

function normalizePlan(plan) {
  return String(plan || 'FREE').trim().toUpperCase();
}

function normalizeSubscriptionStatus(status) {
  return String(status || '').trim().toLowerCase();
}

function hasSubscriptionFields(user) {
  if (!user || typeof user !== 'object') return false;
  return [
    user.stripeSubscriptionId,
    user.subscriptionStatus,
    user.subscriptionEndDate,
  ].some((value) => (
    value !== null
    && value !== undefined
    && (typeof value !== 'string' || value.trim() !== '')
  ));
}

function subscriptionAllowsPaidAccess(user) {
  // Compatibility contract: paid accounts created before subscription
  // tracking remain authorized only while all subscription fields are absent.
  // Once any field exists, Stripe state must explicitly be active/trialing,
  // or canceling with paid time remaining in the current period.
  if (!hasSubscriptionFields(user)) return true;
  const status = normalizeSubscriptionStatus(user.subscriptionStatus);
  if (ACTIVE_SUBSCRIPTION_STATES.has(status)) return true;
  if (status !== 'canceling') return false;
  const periodEnd = new Date(user.subscriptionEndDate).getTime();
  return Number.isFinite(periodEnd) && periodEnd > Date.now();
}

// What the feature is, in the user's words, for the Spanish 402 copy.
const FEATURE_LABELS_ES = Object.freeze({
  image_generation: 'La generación de imágenes',
  image_upscale: 'La mejora de resolución de imágenes',
  image_variation: 'La creación de variaciones de imágenes',
  music_generation: 'La generación de música',
  thesis_generation: 'La generación de tesis',
  video_generation: 'La generación de video',
  voice_generation: 'La generación de voz',
});
const DEFAULT_FEATURE_LABEL_ES = 'Esta función';
const UPGRADE_URL = '/planes';

function featureLabelEs(feature) {
  return FEATURE_LABELS_ES[String(feature || '')] || DEFAULT_FEATURE_LABEL_ES;
}

/**
 * Spanish copy for the 402 bodies. It keeps «Sube de plan» (the composer's
 * isMonthlyLimitError matcher lowercases the text and looks for it) and, for
 * an inactive subscription, says to renew it.
 */
function upgradeMessageEs(feature, { inactive = false } = {}) {
  const label = featureLabelEs(feature);
  if (inactive) {
    return `${label} necesita una suscripción activa y la tuya no lo está. Renueva tu suscripción o sube de plan en /planes para continuar.`;
  }
  return `${label} está disponible en los planes de pago. Sube de plan en /planes para usarla.`;
}

function requirePaidPlan(options = {}) {
  const feature = options.feature || 'premium_feature';
  const allowedPlans = new Set(
    (options.allowedPlans || DEFAULT_PAID_PLANS).map(normalizePlan),
  );

  return function requirePaidPlanMiddleware(req, res, next) {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'auth required' });
    }

    const plan = normalizePlan(req.user.plan);
    if (req.user.isSuperAdmin) {
      return next();
    }
    if (allowedPlans.has(plan)) {
      if (subscriptionAllowsPaidAccess(req.user)) return next();
      const inactiveMessage = upgradeMessageEs(feature, { inactive: true });
      return res.status(402).json({
        error: inactiveMessage,
        message: inactiveMessage,
        code: 'UPGRADE_REQUIRED',
        reason: 'SUBSCRIPTION_INACTIVE',
        feature,
        plan,
        subscriptionStatus: normalizeSubscriptionStatus(
          req.user.subscriptionStatus,
        ) || 'unknown',
        requiredPlans: Array.from(allowedPlans),
        upgradeRequired: true,
        upgradeUrl: UPGRADE_URL,
      });
    }

    const upgradeMessage = upgradeMessageEs(feature);
    return res.status(402).json({
      error: upgradeMessage,
      message: upgradeMessage,
      code: 'UPGRADE_REQUIRED',
      feature,
      plan,
      requiredPlans: Array.from(allowedPlans),
      upgradeRequired: true,
      upgradeUrl: UPGRADE_URL,
    });
  };
}

module.exports = requirePaidPlan;
module.exports.requirePaidPlan = requirePaidPlan;
module.exports.normalizePlan = normalizePlan;
module.exports.normalizeSubscriptionStatus = normalizeSubscriptionStatus;
module.exports.hasSubscriptionFields = hasSubscriptionFields;
module.exports.subscriptionAllowsPaidAccess = subscriptionAllowsPaidAccess;
module.exports.DEFAULT_PAID_PLANS = DEFAULT_PAID_PLANS;
module.exports.FEATURE_LABELS_ES = FEATURE_LABELS_ES;
module.exports.UPGRADE_URL = UPGRADE_URL;
module.exports.upgradeMessageEs = upgradeMessageEs;

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
      return res.status(402).json({
        error: 'Upgrade required',
        code: 'UPGRADE_REQUIRED',
        reason: 'SUBSCRIPTION_INACTIVE',
        feature,
        plan,
        subscriptionStatus: normalizeSubscriptionStatus(
          req.user.subscriptionStatus,
        ) || 'unknown',
        requiredPlans: Array.from(allowedPlans),
        upgradeRequired: true,
      });
    }

    return res.status(402).json({
      error: 'Upgrade required',
      code: 'UPGRADE_REQUIRED',
      feature,
      plan,
      requiredPlans: Array.from(allowedPlans),
      upgradeRequired: true,
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

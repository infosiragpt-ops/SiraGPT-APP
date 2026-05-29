'use strict';

const DEFAULT_PAID_PLANS = Object.freeze([
  'FREE',
  'PRO',
  'PRO_MAX',
  'ENTERPRISE',
]);

function normalizePlan(plan) {
  return String(plan || 'FREE').trim().toUpperCase();
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
    if (req.user.isSuperAdmin || allowedPlans.has(plan)) {
      return next();
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
module.exports.DEFAULT_PAID_PLANS = DEFAULT_PAID_PLANS;

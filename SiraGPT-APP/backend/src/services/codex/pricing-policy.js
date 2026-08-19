'use strict';

/**
 * codex/pricing-policy — turns an accumulated LIST price (costOriginalUsd) into
 * the APPLIED price after the user's plan multiplier (costAppliedUsd), feature
 * 08. The "Agent Usage" card shows the original struck through → the applied
 * price; the UI hides the strikethrough when they're equal.
 *
 * FREE → applied 0 (the free tier never bills agent usage; the original is
 * still shown so the user sees the value they got). Higher plans get a discount
 * perk. A global launch promo (CODEX_COST_PROMO_MULTIPLIER) stacks on top.
 * costAppliedUsd ≤ costOriginalUsd always (every multiplier ≤ 1).
 */

const PLAN_MULTIPLIERS = Object.freeze({
  FREE: 0,
  PRO: 1,
  PRO_MAX: 0.9,
  ENTERPRISE: 0.75,
});

function planMultiplier(plan) {
  const key = String(plan || 'FREE').toUpperCase();
  return Object.prototype.hasOwnProperty.call(PLAN_MULTIPLIERS, key) ? PLAN_MULTIPLIERS[key] : 1;
}

function promoMultiplier(env = process.env) {
  const raw = Number.parseFloat(env.CODEX_COST_PROMO_MULTIPLIER || '');
  if (!Number.isFinite(raw) || raw < 0 || raw > 1) return 1;
  return raw;
}

function round6(n) {
  return Number((Math.round(n * 1e6) / 1e6).toFixed(6));
}

/**
 * @param {string} plan
 * @param {number} costOriginalUsd — accumulated list-price cost
 * @returns {{ costOriginalUsd:number, costAppliedUsd:number, multiplier:number }}
 */
function applyPlanPricing(plan, costOriginalUsd, { env = process.env } = {}) {
  const original = Number.isFinite(costOriginalUsd) && costOriginalUsd > 0 ? round6(costOriginalUsd) : 0;
  const multiplier = planMultiplier(plan) * promoMultiplier(env);
  const applied = round6(Math.min(original, original * multiplier));
  return { costOriginalUsd: original, costAppliedUsd: applied, multiplier };
}

module.exports = { applyPlanPricing, planMultiplier, promoMultiplier, PLAN_MULTIPLIERS };

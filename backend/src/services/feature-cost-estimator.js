'use strict';

/**
 * feature-cost-estimator — single source of truth for credit cost
 * estimates per feature, so the UI can show "this will cost N credits"
 * before the user confirms.
 *
 * Mirrors the cost functions hard-coded in each route (paraphrase.js,
 * images.js, …) without importing them — keeps the UI surface
 * decoupled from the route file structure.
 *
 * Public API:
 *   estimateCost(feature, opts) → { credits, breakdown }
 *   listFeatures()              → string[]
 */

const FEATURE_COSTS = Object.freeze({
  paraphrase: {
    base: 1,
    perKChars: 1, // env-tunable: CREDITS_PARAPHRASE_PER_1K_CHARS
    minCost: 1,
  },
  image_generation: {
    base: 5,
    perKChars: 0,
    minCost: 5,
  },
  image_variation: {
    base: 5,
    perKChars: 0,
    minCost: 5,
  },
  image_upscale: {
    base: 3,
    perKChars: 0,
    minCost: 3,
  },
  generate: {
    base: 1,
    perKChars: 0.5,
    minCost: 1,
  },
});

function readPositiveNumber(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Estimate credit cost for a feature given a payload size hint.
 * Always returns at least `minCost`. Returns null when the feature
 * is unknown (caller should treat as a free no-op or an error).
 */
function estimateCost(feature, { textLength = 0, env = process.env } = {}) {
  const spec = FEATURE_COSTS[feature];
  if (!spec) return null;
  // Honour env overrides per spec.
  let perK = spec.perKChars;
  if (feature === 'paraphrase') {
    perK = readPositiveNumber(env.CREDITS_PARAPHRASE_PER_1K_CHARS, spec.perKChars);
  }
  const len = Math.max(0, Number(textLength) || 0);
  const lengthCost = Math.ceil(len / 1000) * perK;
  const total = Math.max(spec.minCost, spec.base + lengthCost);
  return {
    credits: total,
    breakdown: {
      base: spec.base,
      lengthCost,
      minCost: spec.minCost,
      perKChars: perK,
    },
  };
}

function listFeatures() {
  return Object.keys(FEATURE_COSTS);
}

/**
 * Returns a fully-enriched record describing a plan tier — pricing,
 * budget, label-as-USD — useful for rendering a plan card without
 * the UI having to compose the fields itself.
 *
 *   enrichPlanWithPricing('PRO')
 *   → { plan: 'PRO',
 *       priceUsd: 5,
 *       priceLabel: '$5/mo',
 *       budgetCredits: 100000,
 *       budgetLabel: '100,000 credits',
 *       unlimited: false }
 *
 * Returns null for unknown plan names.
 */
/**
 * The pricing-page "most popular" badge — pre-decided by product
 * (not derived from usage stats). PRO is the recommended default for
 * a typical user: $5/mo, 100k tokens premium + 500k Gema4 fallback.
 */
const POPULAR_PLAN = 'PRO';

function enrichPlanWithPricing(plan) {
  const key = String(plan || '').toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(PLAN_PRICES_USD, key)) return null;
  const priceUsd = PLAN_PRICES_USD[key];
  const budget = PLAN_BUDGETS[key];
  const unlimited = budget === null;
  return {
    plan: key,
    priceUsd,
    priceLabel: priceUsd === 0 ? 'Free' : `$${priceUsd}/mo`,
    budgetCredits: unlimited ? null : budget,
    budgetLabel: unlimited ? 'Unlimited' : `${budget.toLocaleString('en-US')} credits`,
    unlimited,
    popular: key === POPULAR_PLAN,
  };
}

/**
 * Plan tier credit budgets (mirrors plan-credits-catalog values).
 * Kept local so this module doesn't have to import the plan catalog
 * and create a dependency cycle.
 */
const PLAN_BUDGETS = Object.freeze({
  FREE: 0,           // FREE has no premium budget — falls back to FlashGPT
  PRO: 100_000,
  PRO_MAX: 300_000,
  ENTERPRISE: null,  // unlimited
});

/**
 * Recommend the cheapest plan that covers a monthly usage forecast.
 * Compared against the premium token grant per tier.
 *
 *   usage      → cheapest plan covering totalMonthly credits
 *   0 calls    → FREE (no premium needed)
 *   ≤ 100k     → PRO
 *   ≤ 300k     → PRO_MAX
 *   > 300k     → ENTERPRISE (unlimited)
 */
/**
 * Plan tier USD prices per the product brief.
 *   FREE       $0
 *   PRO        $5
 *   PRO_MAX    $10
 *   ENTERPRISE $2 + pay-as-you-go (treated as $2 base for comparison)
 */
const PLAN_PRICES_USD = Object.freeze({
  FREE: 0,
  PRO: 5,
  PRO_MAX: 10,
  ENTERPRISE: 2,
});

/**
 * Compute the $ delta between two plans. Positive value = upgrading
 * costs more; negative value = upgrading is cheaper (rare, but happens
 * with ENTERPRISE).
 *
 *   getCostDelta('FREE', 'PRO')       → { deltaUsd: 5,  upgrade: true }
 *   getCostDelta('PRO', 'PRO_MAX')    → { deltaUsd: 5,  upgrade: true }
 *   getCostDelta('PRO', 'PRO')        → { deltaUsd: 0,  upgrade: false }
 *   getCostDelta('PRO_MAX', 'PRO')    → { deltaUsd: -5, upgrade: false }
 */
/**
 * USD-per-credit rate the pricing page can use to render
 * "≈ $0.50" labels next to credit counts. Derived from the spec's
 * 100k tokens-for-$5 PRO ratio = $0.00005 per credit. The 30% margin
 * mentioned in the spec is baked into this so the consumer doesn't
 * need to apply a separate markup.
 */
const USD_PER_CREDIT = 5 / 100_000;

/**
 * Render N credits as an approximate USD label. Returns "≈ $X.XX"
 * with two decimals when >= $0.01, "≈ <$0.01" for sub-cent values,
 * and "" for non-positive inputs.
 */
function formatCreditsAsUsd(credits) {
  const n = Number(credits) || 0;
  if (n <= 0) return '';
  const usd = n * USD_PER_CREDIT;
  if (usd < 0.01) return '≈ <$0.01';
  return `≈ $${usd.toFixed(2)}`;
}

function getCostDelta(currentPlan, recommendedPlan) {
  const cur = PLAN_PRICES_USD[String(currentPlan || '').toUpperCase()];
  const rec = PLAN_PRICES_USD[String(recommendedPlan || '').toUpperCase()];
  if (cur == null || rec == null) {
    return { deltaUsd: null, upgrade: false, reason: 'unknown_plan' };
  }
  const delta = rec - cur;
  return {
    deltaUsd: delta,
    upgrade: delta > 0,
    fromPlan: String(currentPlan).toUpperCase(),
    toPlan: String(recommendedPlan).toUpperCase(),
  };
}

function getRecommendedPlan(usage, { env = process.env } = {}) {
  const projection = estimateMonthlyCost(usage, { env });
  const total = projection.totalMonthly;
  let plan = 'ENTERPRISE';
  let reason = 'exceeds_PRO_MAX_use_unlimited';
  if (total <= 0) { plan = 'FREE'; reason = 'no_usage_projected'; }
  else if (total <= PLAN_BUDGETS.PRO) { plan = 'PRO'; reason = 'fits_in_PRO_budget'; }
  else if (total <= PLAN_BUDGETS.PRO_MAX) { plan = 'PRO_MAX'; reason = 'fits_in_PRO_MAX_budget'; }
  return {
    plan,
    monthlyCredits: total,
    monthlyUsd: projection.totalMonthlyUsd,
    priceUsd: PLAN_PRICES_USD[plan],
    reason,
  };
}

/**
 * Project monthly credit spend given a usage forecast. Lets the
 * pricing page show "at your current pace you'd spend N credits per
 * month".
 *
 * @param {object} usage — { paraphrase: { calls: 10, avgTextLength: 2000 }, image_generation: { calls: 5 } }
 * @returns {{ totalMonthly: number, perFeature: object }}
 */
function estimateMonthlyCost(usage, { env = process.env } = {}) {
  if (!usage || typeof usage !== 'object') return { totalMonthly: 0, totalMonthlyUsd: '', perFeature: {} };
  let total = 0;
  const perFeature = {};
  for (const [feature, profile] of Object.entries(usage)) {
    if (!profile || typeof profile !== 'object') continue;
    const calls = Math.max(0, Number(profile.calls) || 0);
    const avgLen = Math.max(0, Number(profile.avgTextLength) || 0);
    if (calls === 0) continue;
    const est = estimateCost(feature, { textLength: avgLen, env });
    if (!est) continue;
    const monthly = est.credits * calls;
    perFeature[feature] = {
      calls,
      perCallCredits: est.credits,
      monthlyCredits: monthly,
      monthlyUsd: formatCreditsAsUsd(monthly),
    };
    total += monthly;
  }
  return { totalMonthly: total, totalMonthlyUsd: formatCreditsAsUsd(total), perFeature };
}

/**
 * Batch variant — estimate costs for many features at once. Useful
 * for a comparison table ("paraphrasing this would cost X, generating
 * an image would cost Y"). Skips unknown features silently.
 *
 * @param {Array<{feature: string, textLength?: number}>} requests
 * @returns {Array<{feature, credits, breakdown}>}
 */
function estimateCostBatch(requests, { env = process.env } = {}) {
  if (!Array.isArray(requests)) return [];
  const out = [];
  for (const r of requests) {
    if (!r || !r.feature) continue;
    const est = estimateCost(r.feature, { textLength: r.textLength || 0, env });
    if (est) {
      out.push({
        feature: r.feature,
        credits: est.credits,
        usdLabel: formatCreditsAsUsd(est.credits),
        breakdown: est.breakdown,
      });
    }
  }
  return out;
}

module.exports = {
  estimateCost,
  estimateCostBatch,
  estimateMonthlyCost,
  getRecommendedPlan,
  getCostDelta,
  formatCreditsAsUsd,
  enrichPlanWithPricing,
  listFeatures,
  FEATURE_COSTS,
  PLAN_BUDGETS,
  PLAN_PRICES_USD,
  USD_PER_CREDIT,
  POPULAR_PLAN,
};

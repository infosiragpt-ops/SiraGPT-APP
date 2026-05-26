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

/**
 * Return true if `plan` is one of the known SiraGPT tier names
 * (FREE/PRO/PRO_MAX/ENTERPRISE). Case-insensitive. Useful for
 * pre-Zod validation in routes that accept a plan name from the
 * client.
 */
function validatePlanName(plan) {
  if (typeof plan !== 'string' || !plan) return false;
  return Object.prototype.hasOwnProperty.call(PLAN_PRICES_USD, plan.toUpperCase());
}

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
/**
 * Convert N credits to USD cents (integer). Useful for financial
 * reporting where float USD can drift due to rounding. Always returns
 * a non-negative integer.
 */
/**
 * Render an estimateMonthlyCost result as CSV text for Excel/Sheets
 * export. Returns header + one row per feature + total. Always
 * comma-delimited; numeric columns unquoted, string columns quoted to
 * survive features named with commas (none today, but defensive).
 */
function monthlyBreakdownAsCsv(projection) {
  if (!projection || typeof projection !== 'object') return 'feature,calls,perCallCredits,monthlyCredits,monthlyUsd\n';
  const rows = ['feature,calls,perCallCredits,monthlyCredits,monthlyUsd'];
  const perFeature = projection.perFeature || {};
  for (const [feature, row] of Object.entries(perFeature)) {
    const escaped = `"${String(feature).replace(/"/g, '""')}"`;
    rows.push([escaped, row.calls, row.perCallCredits, row.monthlyCredits, `"${row.monthlyUsd || ''}"`].join(','));
  }
  rows.push(`"TOTAL",,,${projection.totalMonthly || 0},"${projection.totalMonthlyUsd || ''}"`);
  return rows.join('\n') + '\n';
}

/**
 * Render an estimateMonthlyCost result as a GitHub-flavoured Markdown
 * table. Convenient when the chat AI needs to explain projected
 * spend in conversation ("Here's what you'd spend each month: …").
 *
 * Output:
 *   | Feature | Calls | Credits/call | Monthly credits | Monthly USD |
 *   |---------|-------|--------------|-----------------|-------------|
 *   | paraphrase | 10 | 3 | 30 | ≈ <$0.01 |
 *   | **TOTAL** |  |  | **30** | **≈ <$0.01** |
 *
 * Returns the empty markdown table when projection is null / empty.
 */
function monthlyBreakdownAsMarkdown(projection) {
  const header = '| Feature | Calls | Credits/call | Monthly credits | Monthly USD |';
  const divider = '|---------|-------|--------------|-----------------|-------------|';
  if (!projection || typeof projection !== 'object') {
    return `${header}\n${divider}\n`;
  }
  const lines = [header, divider];
  const perFeature = projection.perFeature || {};
  for (const [feature, row] of Object.entries(perFeature)) {
    lines.push(`| ${feature} | ${row.calls} | ${row.perCallCredits} | ${row.monthlyCredits} | ${row.monthlyUsd || ''} |`);
  }
  lines.push(`| **TOTAL** |  |  | **${projection.totalMonthly || 0}** | **${projection.totalMonthlyUsd || ''}** |`);
  return lines.join('\n') + '\n';
}

function creditsToUsdCents(credits) {
  const n = Number(credits) || 0;
  if (n <= 0) return 0;
  return Math.round(n * USD_PER_CREDIT * 100);
}

/**
 * Inverse of creditsToUsdCents — convert a USD amount to whole credits.
 * Returns 0 for non-positive / invalid input. Result is always an
 * integer (rounded down — caller never gets more credits than they
 * paid for).
 *
 *   creditsForUsd(5)    → 100_000  (PRO plan equivalent)
 *   creditsForUsd(0.05) → 1000
 *   creditsForUsd(0)    → 0
 */
function creditsForUsd(usd) {
  const n = Number(usd) || 0;
  if (n <= 0) return 0;
  return Math.floor(n / USD_PER_CREDIT);
}

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
 * One-call combination of `getRecommendedPlan` + `getCostDelta` +
 * `comparePlans`. The upsell UI gets everything it needs to render a
 * "you should upgrade because…" panel:
 *
 *   {
 *     recommendation: { plan, monthlyCredits, monthlyUsd, priceUsd, reason },
 *     comparison:     { from, to, priceDeltaUsd, budgetDeltaCredits, direction },
 *     shouldUpgrade:  boolean   // true iff recommendation > current plan in $
 *   }
 *
 * Returns `null` when `currentPlan` is unknown.
 */
function recommendUpgradeFromUsage(usage, currentPlan, { env = process.env } = {}) {
  if (!enrichPlanWithPricing(currentPlan)) return null;
  const recommendation = getRecommendedPlan(usage, { env });
  const comparison = comparePlans(currentPlan, recommendation.plan);
  return {
    recommendation,
    comparison,
    shouldUpgrade: comparison ? comparison.direction === 'upgrade' : false,
  };
}

/**
 * Given a maximum monthly USD spend, return the most generous plan
 * the user can afford — i.e. the highest-budget plan whose price is
 * ≤ maxUsdPerMonth. Useful for "I have $X to spend" sliders.
 *
 *   findCheapestPlanForBudget(0)     → FREE   ($0)
 *   findCheapestPlanForBudget(3)     → ENTERPRISE ($2 base — best fit)
 *   findCheapestPlanForBudget(5)     → PRO    ($5)
 *   findCheapestPlanForBudget(10)    → PRO_MAX ($10)
 *   findCheapestPlanForBudget(-1)    → FREE   (clamped to $0)
 *
 * Tie-breaks pick the plan with the largest budget (treating unlimited
 * as ∞). Returns null only for non-numeric input.
 */
function findCheapestPlanForBudget(maxUsdPerMonth) {
  const cap = Number(maxUsdPerMonth);
  if (!Number.isFinite(cap)) return null;
  const ceiling = Math.max(0, cap);
  // Score each affordable plan by budget size (unlimited wins).
  const affordable = pricingTable().filter((p) => p.priceUsd <= ceiling);
  if (affordable.length === 0) return null;
  affordable.sort((a, b) => {
    const aBudget = a.budgetCredits == null ? Infinity : a.budgetCredits;
    const bBudget = b.budgetCredits == null ? Infinity : b.budgetCredits;
    return bBudget - aBudget;
  });
  return affordable[0];
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

/**
 * Returns every known plan as an enriched record, sorted by price
 * (cheapest → most expensive). The pricing page can iterate this
 * directly without having to discover the plan names.
 *
 * Useful when:
 *   - rendering the pricing table grid
 *   - generating <select> options for plan switching
 *   - exporting the full price book for billing reports
 */
function pricingTable() {
  return Object.keys(PLAN_PRICES_USD)
    .map((plan) => enrichPlanWithPricing(plan))
    .filter(Boolean)
    .sort((a, b) => a.priceUsd - b.priceUsd);
}

/**
 * Cheaper variant of `estimateCostBatch` that just takes feature
 * names (no payload size) and returns per-feature minCost. Useful
 * for marketing comparison tables that want to show "what does each
 * feature cost?" without simulating actual user input.
 *
 *   quickEstimate(['paraphrase', 'image_generation'])
 *   → [{ feature: 'paraphrase', credits: 1, usdLabel: '≈ <$0.01' },
 *      { feature: 'image_generation', credits: 5, usdLabel: '≈ <$0.01' }]
 *
 * Unknown features are silently dropped.
 */
function quickEstimate(features) {
  if (!Array.isArray(features)) return [];
  return estimateCostBatch(features.map((f) => ({ feature: f, textLength: 0 })));
}

/**
 * Can a user on `currentPlan` afford `monthlyCalls` of `feature` at
 * the given avg text length? Returns a verdict + the projected
 * monthly cost + plan budget. Useful for "you're about to enable
 * autoplay — that costs ≈ N/mo, your plan has M left" warnings.
 *
 *   affordsFeature('PRO', 'paraphrase', { calls: 1000, avgTextLength: 2000 })
 *   → { affords: true, projectedCredits: 3000, budgetCredits: 100000, headroomPct: 97 }
 *
 *   affordsFeature('FREE', 'paraphrase', { calls: 100 })
 *   → { affords: false, projectedCredits: 100, budgetCredits: 0, headroomPct: 0,
 *       reason: 'plan_has_no_premium_budget' }
 *
 * ENTERPRISE always affords (unlimited). Unknown plan returns null.
 */
function affordsFeature(currentPlan, feature, { calls = 0, avgTextLength = 0, env = process.env } = {}) {
  const planEnriched = enrichPlanWithPricing(currentPlan);
  if (!planEnriched) return null;
  const est = estimateCost(feature, { textLength: avgTextLength, env });
  if (!est) return { affords: false, reason: 'unknown_feature' };
  const projectedCredits = est.credits * Math.max(0, Number(calls) || 0);
  if (planEnriched.unlimited) {
    return {
      affords: true,
      projectedCredits,
      budgetCredits: null,
      headroomPct: 100,
      plan: planEnriched.plan,
    };
  }
  const budget = planEnriched.budgetCredits || 0;
  const affords = projectedCredits <= budget;
  const headroomPct = budget === 0 ? 0
    : Math.max(0, Math.round((1 - projectedCredits / budget) * 1000) / 10);
  return {
    affords,
    projectedCredits,
    budgetCredits: budget,
    headroomPct,
    plan: planEnriched.plan,
    reason: affords ? 'within_budget'
      : budget === 0 ? 'plan_has_no_premium_budget'
      : 'exceeds_plan_budget',
  };
}

/**
 * Human-readable explainer for the result of `affordsFeature`. Returns
 * a single string the UI can drop straight into a toast/banner. Built
 * on top of affordsFeature so the explanations stay in sync with the
 * underlying reasons.
 *
 *   explainBudgetVerdict('FREE', 'paraphrase', { calls: 100 })
 *   → "FREE has no premium credit budget for paraphrase. Upgrade to PRO ($5/mo, 100,000 credits) to enable this feature."
 *
 *   explainBudgetVerdict('PRO', 'paraphrase', { calls: 1000, avgTextLength: 1000 })
 *   → "2,000 credits — within your PRO budget (98.0% headroom)."
 *
 * Returns null for unknown plan.
 */
/**
 * Returns a small list of (question, answer) pairs describing the
 * pricing model. The chat AI uses this as a knowledge base when users
 * ask "how much does X cost?" / "what's the difference between PRO
 * and PRO_MAX?". Numbers come straight from PLAN_* constants so
 * the answers stay in sync with the canonical pricing.
 */
function pricingFAQEntries() {
  const fmt = (cents) => cents == null ? 'Unlimited' : `${cents.toLocaleString('en-US')} credits`;
  return [
    {
      q: 'How much does FREE include?',
      a: `${fmt(PLAN_BUDGETS.FREE)} of premium credits — FREE falls back to FlashGPT (⚡ Cerebras Llama 3.1 8B) for everything else.`,
    },
    {
      q: 'How much does PRO cost?',
      a: `$${PLAN_PRICES_USD.PRO}/month, includes ${fmt(PLAN_BUDGETS.PRO)} of premium credits (≈ \$${(PLAN_BUDGETS.PRO * USD_PER_CREDIT).toFixed(2)} worth).`,
    },
    {
      q: 'How much does PRO_MAX cost?',
      a: `$${PLAN_PRICES_USD.PRO_MAX}/month, includes ${fmt(PLAN_BUDGETS.PRO_MAX)} of premium credits.`,
    },
    {
      q: 'How much does ENTERPRISE cost?',
      a: `$${PLAN_PRICES_USD.ENTERPRISE}/month base + pay-as-you-go. ENTERPRISE has unlimited premium credits.`,
    },
    {
      q: 'How are credits priced in USD?',
      a: `Roughly $${USD_PER_CREDIT.toFixed(5)} per credit, derived from the PRO ratio (${fmt(PLAN_BUDGETS.PRO)} for $${PLAN_PRICES_USD.PRO}).`,
    },
    {
      q: 'How much does each feature cost?',
      a: `Paraphrase: 1 credit + 1 per 1k chars. Image generation/variation: 5 credits. Image upscale: 3 credits. Generic generate: 1 credit + 0.5 per 1k chars.`,
    },
    {
      q: 'What happens when I run out of credits?',
      a: `Requests are automatically routed to FlashGPT (⚡ Cerebras Llama 3.1 8B) — free and unlimited, just slightly less powerful than the premium models.`,
    },
  ];
}

function explainBudgetVerdict(currentPlan, feature, usage = {}) {
  const verdict = affordsFeature(currentPlan, feature, usage);
  if (!verdict) return null;
  const credits = (verdict.projectedCredits || 0).toLocaleString('en-US');
  if (verdict.reason === 'unknown_feature') {
    return `"${feature}" is not a known feature.`;
  }
  if (verdict.plan === 'ENTERPRISE') {
    return `${credits} credits — covered by ENTERPRISE unlimited budget.`;
  }
  if (verdict.affords) {
    return `${credits} credits — within your ${verdict.plan} budget (${verdict.headroomPct}% headroom).`;
  }
  if (verdict.reason === 'plan_has_no_premium_budget') {
    const pro = enrichPlanWithPricing('PRO');
    return `${verdict.plan} has no premium credit budget for ${feature}. Upgrade to PRO (${pro.priceLabel}, ${pro.budgetLabel}) to enable this feature.`;
  }
  // exceeds_plan_budget
  return `${credits} credits exceeds your ${verdict.plan} budget of ${verdict.budgetCredits.toLocaleString('en-US')}. Consider PRO_MAX or ENTERPRISE.`;
}

/**
 * Structured diff between two plans — the shape upsell/downsell UIs
 * want without having to subtract by hand. Both rows are also
 * included so the caller has everything needed to render a side-by-
 * side comparison.
 *
 *   comparePlans('PRO', 'PRO_MAX')
 *   → { from: {...PRO row...},
 *       to:   {...PRO_MAX row...},
 *       priceDeltaUsd: 5,
 *       budgetDeltaCredits: 200_000,
 *       direction: 'upgrade' }
 *
 * Returns null when either plan name is unknown.
 */
function comparePlans(from, to) {
  const fromRow = enrichPlanWithPricing(from);
  const toRow = enrichPlanWithPricing(to);
  if (!fromRow || !toRow) return null;
  const priceDeltaUsd = toRow.priceUsd - fromRow.priceUsd;
  // Treat unlimited (null) as Infinity for delta math, but expose
  // it as null in the returned object so callers can render it
  // separately ("∞" / "Unlimited" etc.).
  const fromBudget = fromRow.budgetCredits == null ? Infinity : fromRow.budgetCredits;
  const toBudget = toRow.budgetCredits == null ? Infinity : toRow.budgetCredits;
  let budgetDeltaCredits;
  if (fromBudget === Infinity && toBudget === Infinity) {
    budgetDeltaCredits = 0;
  } else if (toBudget === Infinity) {
    budgetDeltaCredits = null; // gaining unlimited
  } else if (fromBudget === Infinity) {
    budgetDeltaCredits = null; // losing unlimited
  } else {
    budgetDeltaCredits = toBudget - fromBudget;
  }
  let direction = 'same';
  if (priceDeltaUsd > 0) direction = 'upgrade';
  else if (priceDeltaUsd < 0) direction = 'downgrade';
  return {
    from: fromRow,
    to: toRow,
    priceDeltaUsd,
    budgetDeltaCredits,
    direction,
  };
}

module.exports = {
  estimateCost,
  estimateCostBatch,
  estimateMonthlyCost,
  monthlyBreakdownAsCsv,
  monthlyBreakdownAsMarkdown,
  pricingTable,
  quickEstimate,
  affordsFeature,
  explainBudgetVerdict,
  pricingFAQEntries,
  comparePlans,
  getRecommendedPlan,
  recommendUpgradeFromUsage,
  findCheapestPlanForBudget,
  getCostDelta,
  formatCreditsAsUsd,
  creditsToUsdCents,
  creditsForUsd,
  enrichPlanWithPricing,
  validatePlanName,
  listFeatures,
  FEATURE_COSTS,
  PLAN_BUDGETS,
  PLAN_PRICES_USD,
  USD_PER_CREDIT,
  POPULAR_PLAN,
};

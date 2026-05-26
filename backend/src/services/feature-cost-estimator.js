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
 * Project monthly credit spend given a usage forecast. Lets the
 * pricing page show "at your current pace you'd spend N credits per
 * month".
 *
 * @param {object} usage — { paraphrase: { calls: 10, avgTextLength: 2000 }, image_generation: { calls: 5 } }
 * @returns {{ totalMonthly: number, perFeature: object }}
 */
function estimateMonthlyCost(usage, { env = process.env } = {}) {
  if (!usage || typeof usage !== 'object') return { totalMonthly: 0, perFeature: {} };
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
    perFeature[feature] = { calls, perCallCredits: est.credits, monthlyCredits: monthly };
    total += monthly;
  }
  return { totalMonthly: total, perFeature };
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
    if (est) out.push({ feature: r.feature, credits: est.credits, breakdown: est.breakdown });
  }
  return out;
}

module.exports = {
  estimateCost,
  estimateCostBatch,
  estimateMonthlyCost,
  listFeatures,
  FEATURE_COSTS,
};

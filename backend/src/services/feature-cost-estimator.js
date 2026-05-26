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

module.exports = {
  estimateCost,
  listFeatures,
  FEATURE_COSTS,
};

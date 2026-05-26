'use strict';

/**
 * model-bandit — Beta-Bernoulli multi-armed bandit that learns which
 * model wins per (context-key) by observing success / failure feedback,
 * and picks the next call with Thompson sampling. Pairs with the
 * deterministic model-router (#6 cascade fallback) — the router picks
 * by hard rules, the bandit picks by *measured* outcome over time.
 *
 * Each arm tracks (alpha, beta) — successes+1 and failures+1 of a Beta
 * posterior on its true success rate. select() draws one sample per
 * arm and returns the highest. This converges to the true best arm
 * exponentially fast while keeping a controlled exploration tail.
 *
 * The bandit is partitioned by `contextKey` — different bandit state
 * per (intent, language, complexity) so "best model for code generation
 * in Python" learns independently from "best model for small talk".
 *
 * Public API:
 *   const b = createModelBandit({
 *     arms,                  // string[] of model IDs
 *     priorAlpha,            // default 1
 *     priorBeta,             // default 1
 *     halfLifeReports,       // optional decay so old wins fade
 *     rng,                   // () => float in [0,1)
 *   })
 *   b.select(contextKey?)         → modelId
 *   b.report(contextKey, modelId, succeeded:bool, weight=1)
 *   b.snapshot(contextKey?)       → arm states
 *   b.reset(contextKey?)          → wipe specific or all
 *
 * Pure JS, dependency-free. The Beta sampler uses the
 * gamma-via-Marsaglia-Tsang trick which is bias-free and fast.
 */

const DEFAULT_PRIOR_ALPHA = 1;
const DEFAULT_PRIOR_BETA = 1;

function gaussian(rng) {
  // Box–Muller; sufficient quality for sampling.
  let u1 = 0; while (u1 === 0) u1 = rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Marsaglia–Tsang gamma sampler for shape >= 1. Falls back via the
 *  shape<1 boost trick. */
function sampleGamma(shape, rng) {
  if (shape < 1) {
    const g = sampleGamma(shape + 1, rng);
    const u = Math.max(Number.EPSILON, rng());
    return g * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do {
      x = gaussian(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleBeta(alpha, beta, rng) {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  return x / (x + y);
}

function createModelBandit(opts = {}) {
  const arms = Array.isArray(opts.arms) ? opts.arms.filter((a) => typeof a === 'string' && a) : [];
  if (arms.length === 0) throw new TypeError('model-bandit: arms[] required');
  const priorAlpha = Number.isFinite(opts.priorAlpha) && opts.priorAlpha > 0 ? opts.priorAlpha : DEFAULT_PRIOR_ALPHA;
  const priorBeta = Number.isFinite(opts.priorBeta) && opts.priorBeta > 0 ? opts.priorBeta : DEFAULT_PRIOR_BETA;
  const halfLifeReports = Number.isFinite(opts.halfLifeReports) && opts.halfLifeReports > 0 ? opts.halfLifeReports : 0;
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;

  /** Map<contextKey, Map<armId, {alpha,beta,reports}>> */
  const states = new Map();

  function getOrInit(ctxKey) {
    let inner = states.get(ctxKey);
    if (!inner) {
      inner = new Map();
      for (const a of arms) inner.set(a, { alpha: priorAlpha, beta: priorBeta, reports: 0 });
      states.set(ctxKey, inner);
    }
    return inner;
  }

  function decay(state) {
    if (halfLifeReports <= 0) return state;
    if (state.reports < halfLifeReports) return state;
    const factor = Math.pow(0.5, state.reports / halfLifeReports);
    state.alpha = priorAlpha + (state.alpha - priorAlpha) * factor;
    state.beta = priorBeta + (state.beta - priorBeta) * factor;
    state.reports = 0;
    return state;
  }

  function select(contextKey = '_default') {
    const inner = getOrInit(contextKey);
    let bestArm = arms[0];
    let bestSample = -Infinity;
    for (const arm of arms) {
      const s = inner.get(arm);
      const sample = sampleBeta(s.alpha, s.beta, rng);
      if (sample > bestSample) { bestSample = sample; bestArm = arm; }
    }
    return bestArm;
  }

  function report(contextKey, armId, succeeded, weight = 1) {
    const inner = getOrInit(contextKey || '_default');
    const s = inner.get(armId);
    if (!s) return false;
    const w = Math.max(0, Number(weight) || 0);
    if (succeeded) s.alpha += w; else s.beta += w;
    s.reports += 1;
    decay(s);
    return true;
  }

  function snapshot(contextKey) {
    if (contextKey !== undefined) {
      const inner = states.get(contextKey);
      if (!inner) return null;
      return Object.fromEntries([...inner.entries()].map(([k, v]) => [k, { ...v, mean: v.alpha / (v.alpha + v.beta) }]));
    }
    const out = {};
    for (const [k, inner] of states) {
      out[k] = Object.fromEntries([...inner.entries()].map(([a, v]) => [a, { ...v, mean: v.alpha / (v.alpha + v.beta) }]));
    }
    return out;
  }

  function reset(contextKey) {
    if (contextKey !== undefined) states.delete(contextKey);
    else states.clear();
  }

  return { select, report, snapshot, reset, arms: () => arms.slice() };
}

module.exports = {
  createModelBandit,
  sampleBeta,
  sampleGamma,
};

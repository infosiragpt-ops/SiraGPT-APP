'use strict';

/**
 * routing-feedback.js — outcome-based learning for the cognitive core.
 * ───────────────────────────────────────────────────────────────────────────
 * The reasoning-orchestrator's routing is static heuristics. This module makes
 * it LEARN: it records real quality signals per decision signature
 * (intent × difficulty × model) and derives a per-model penalty so the router
 * can deprioritize models with a poor track record on a given task type.
 *
 * Outcome signals (cheap, already available in the chat route):
 *   - regenerated        — the user hit "regenerate" → previous answer weak.
 *   - low_faithfulness   — Phase-2 gate graded the answer D/F.
 *   - high_faithfulness  — Phase-2 gate graded the answer A/B.
 *   - honesty_flag       — agentic honesty check found unsupported claims.
 *   - success            — an explicit positive (👍) when available.
 *
 * Pure + in-memory (bounded). `snapshot()`/`load()` let an operator persist
 * across restarts; deterministic + fully unit-tested. Recording is always safe
 * (never throws); penalties only bite when the orchestrator is given a
 * penaltyProvider AND intelligent routing is enabled.
 *
 * Public API:
 *   signatureFor({intent,difficulty,model})        → string
 *   recordOutcome({intent,difficulty,model,outcome,weight?})
 *   getStats(intentOrSig, difficulty?, model?)     → { attempts, negatives, positives, penalty }
 *   penaltyFor({intent,difficulty,model})          → number 0..MAX_PENALTY
 *   getModelPenalties({intent,difficulty})         → { modelId: penalty }
 *   snapshot() / load(obj) / reset()
 */

const MIN_SAMPLES = Number(process.env.SIRAGPT_ROUTING_FEEDBACK_MIN_SAMPLES) || 5;
const MAX_PENALTY = Math.min(0.9, Number(process.env.SIRAGPT_ROUTING_FEEDBACK_MAX_PENALTY) || 0.6);
const MAX_SIGNATURES = Number(process.env.SIRAGPT_ROUTING_FEEDBACK_MAX_SIGNATURES) || 5000;

// Outcome → signed weight. Negatives raise the penalty; positives lower it.
const OUTCOME_WEIGHTS = Object.freeze({
  regenerated: { neg: 1, pos: 0 },
  low_faithfulness: { neg: 1, pos: 0 },
  constraint_violation: { neg: 1, pos: 0 },
  honesty_flag: { neg: 0.5, pos: 0 },
  high_faithfulness: { neg: 0, pos: 1 },
  success: { neg: 0, pos: 1 },
});

let store = new Map(); // signature → { attempts, negatives, positives }

function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase() || 'unknown';
}

function signatureFor({ intent = null, difficulty = null, model = null } = {}) {
  const diff = typeof difficulty === 'object' && difficulty ? difficulty.bucket : difficulty;
  return `${norm(intent)}|${norm(diff)}|${norm(model)}`;
}

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function recordOutcome(opts) {
  try {
    const { intent = null, difficulty = null, model = null, outcome = null, weight = 1 } = opts || {};
    const w = OUTCOME_WEIGHTS[String(outcome || '').toLowerCase()];
    if (!w) return; // unknown outcome → ignore
    if (!model) return; // no model → nothing to attribute
    const sig = signatureFor({ intent, difficulty, model });
    const cur = store.get(sig) || { attempts: 0, negatives: 0, positives: 0 };
    const k = clamp(weight, 0, 10) || 1;
    cur.attempts += 1;
    cur.negatives += w.neg * k;
    cur.positives += w.pos * k;
    store.set(sig, cur);
    // Bound memory: evict the least-attempted signature when over cap.
    if (store.size > MAX_SIGNATURES) {
      let minKey = null;
      let minAtt = Infinity;
      for (const [key, v] of store) if (v.attempts < minAtt) { minAtt = v.attempts; minKey = key; }
      if (minKey) store.delete(minKey);
    }
  } catch (_) { /* recording must never throw */ }
}

function statsForSig(sig) {
  const cur = store.get(sig) || { attempts: 0, negatives: 0, positives: 0 };
  const penalty = computePenalty(cur);
  return { attempts: cur.attempts, negatives: cur.negatives, positives: cur.positives, penalty };
}

function computePenalty({ attempts, negatives, positives }) {
  if (!attempts || attempts < MIN_SAMPLES) return 0;
  // Net negative rate, smoothed; positives offset negatives.
  const net = (negatives - positives) / attempts;
  if (net <= 0) return 0;
  return Math.round(clamp(net, 0, MAX_PENALTY) * 1000) / 1000;
}

function getStats(intentOrSig, difficulty, model) {
  const sig = (difficulty === undefined && model === undefined && typeof intentOrSig === 'string' && intentOrSig.includes('|'))
    ? intentOrSig
    : signatureFor({ intent: intentOrSig, difficulty, model });
  return statsForSig(sig);
}

function penaltyFor({ intent = null, difficulty = null, model = null } = {}) {
  return statsForSig(signatureFor({ intent, difficulty, model })).penalty;
}

/** All model penalties observed under a given (intent, difficulty). */
function getModelPenalties({ intent = null, difficulty = null } = {}) {
  const prefix = `${norm(intent)}|${norm(typeof difficulty === 'object' && difficulty ? difficulty.bucket : difficulty)}|`;
  const out = {};
  for (const [sig, v] of store) {
    if (!sig.startsWith(prefix)) continue;
    const model = sig.slice(prefix.length);
    const p = computePenalty(v);
    if (p > 0) out[model] = p;
  }
  return out;
}

function snapshot() {
  const obj = {};
  for (const [sig, v] of store) obj[sig] = { attempts: v.attempts, negatives: v.negatives, positives: v.positives };
  return { version: 1, signatures: obj };
}

function load(obj) {
  if (!obj || typeof obj !== 'object') return;
  const sigs = obj.signatures || obj;
  store = new Map();
  for (const [sig, v] of Object.entries(sigs)) {
    if (v && typeof v === 'object') {
      store.set(sig, {
        attempts: Number(v.attempts) || 0,
        negatives: Number(v.negatives) || 0,
        positives: Number(v.positives) || 0,
      });
    }
  }
}

function reset() { store = new Map(); }

function size() { return store.size; }

module.exports = {
  signatureFor,
  recordOutcome,
  getStats,
  penaltyFor,
  getModelPenalties,
  snapshot,
  load,
  reset,
  size,
  OUTCOME_WEIGHTS,
  MIN_SAMPLES,
  MAX_PENALTY,
};

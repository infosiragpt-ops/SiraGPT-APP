'use strict';

/**
 * confidence-calibrator — aggregates the confidence signals scattered
 * across the cortex pipeline into a single calibrated 0..1 score that
 * the orchestrator + response-builder can use to gate delivery.
 *
 * Why this exists:
 *  The brain produces confidence signals at many stages:
 *    • semantic-intent-router          → intent.confidence
 *    • model-router                    → routing.score
 *    • rag-service                     → retrieval.score / rerank.score
 *    • self-rag-critic / nli           → support_ratio
 *    • validator-engine + answer-validator → aggregate_score
 *    • hallucination-scanner           → overallRisk
 *    • quality-scorer                  → coherence, breadth, coverage
 *    • tool-error-classifier           → severity, retryable
 *
 *  Each is locally useful but the response-builder today only sees
 *  validation_frame.aggregate_score. This module produces a single
 *  CalibratedConfidence object with:
 *    - composite score (0..1)
 *    - per-source breakdown
 *    - dominant_risk (the one signal pulling confidence down most)
 *    - delivery_recommendation (ship / hold_for_review / repair / abort)
 *
 * Pure, deterministic, dependency-free, < 1 ms.
 *
 * Public API:
 *   calibrateConfidence(signals) → CalibratedConfidence
 *   renderConfidenceBlock(report) → markdown string
 *
 * Signals input shape (every field is optional and tolerated when absent):
 *   {
 *     intent:        { confidence?: number, needs_clarification?: boolean },
 *     retrieval:     { score?: number, k?: number, has_evidence?: boolean },
 *     rerank:        { score?: number },
 *     validators:    { aggregate_score?: number, failed_count?: number },
 *     answer:        { score?: number, failed_count?: number, warning_count?: number },
 *     hallucination: { overallRisk?: 'low'|'medium'|'high', totalFlags?: number },
 *     quality:       { overall?: number, coverage?: number, coherence?: number },
 *     tool_health:   { errors?: number, last_severity?: string },
 *     model:         { score?: number },
 *   }
 */

// ─── Weights ────────────────────────────────────────────────────────

const WEIGHTS = Object.freeze({
  intent:        0.12,
  retrieval:     0.13,
  rerank:        0.08,
  validators:    0.18,
  answer:        0.18,
  hallucination: 0.15,
  quality:       0.10,
  tool_health:   0.04,
  model:         0.02,
});

const SHIP_THRESHOLD = 0.78;
const REVIEW_THRESHOLD = 0.62;
const REPAIR_THRESHOLD = 0.42;
// Below REPAIR_THRESHOLD → abort_and_surface_error

// ─── Per-source normalisers ─────────────────────────────────────────

function normalizeIntent(s) {
  if (!s) return null;
  const conf = clamp(num(s.confidence));
  if (s.needs_clarification) return Math.min(conf, 0.5);
  return conf;
}

function normalizeRetrieval(s) {
  if (!s) return null;
  if (s.has_evidence === false) return 0.2;
  // Normalise score (caller may pass 0..1 already or 0..100)
  let score = num(s.score);
  if (!Number.isFinite(score)) return null;
  if (score > 1.5) score = score / 100;
  return clamp(score);
}

function normalizeRerank(s) {
  if (!s) return null;
  let score = num(s.score);
  if (!Number.isFinite(score)) return null;
  if (score > 1.5) score = score / 100;
  return clamp(score);
}

function normalizeValidators(s) {
  if (!s) return null;
  // aggregate_score from validator-engine is already 0..1
  let score = num(s.aggregate_score);
  if (!Number.isFinite(score)) return null;
  // Penalise each failed check
  const failed = Number(s.failed_count) || 0;
  score = score - failed * 0.08;
  return clamp(score);
}

function normalizeAnswer(s) {
  if (!s) return null;
  let score = num(s.score);
  if (!Number.isFinite(score)) return null;
  const failed = Number(s.failed_count) || 0;
  const warnings = Number(s.warning_count) || 0;
  score = score - failed * 0.10 - warnings * 0.04;
  return clamp(score);
}

function normalizeHallucination(s) {
  if (!s) return null;
  const risk = String(s.overallRisk || '').toLowerCase();
  if (risk === 'low') return 0.95;
  if (risk === 'medium') return 0.55;
  if (risk === 'high') return 0.15;
  // Fallback by flag count
  const flags = Number(s.totalFlags) || 0;
  if (flags === 0) return 0.95;
  if (flags <= 2) return 0.65;
  if (flags <= 5) return 0.35;
  return 0.15;
}

function normalizeQuality(s) {
  if (!s) return null;
  let overall = num(s.overall);
  if (!Number.isFinite(overall)) {
    const coverage = num(s.coverage);
    const coherence = num(s.coherence);
    const breadth = num(s.breadth);
    overall = (Number.isFinite(coverage) ? coverage : 50)
      + (Number.isFinite(coherence) ? coherence : 50)
      + (Number.isFinite(breadth) ? breadth : 50);
    overall = overall / 3;
  }
  return clamp(overall / 100);
}

function normalizeToolHealth(s) {
  if (!s) return null;
  const errors = Number(s.errors) || 0;
  const sev = String(s.last_severity || '').toLowerCase();
  let base = errors === 0 ? 1.0 : errors <= 1 ? 0.7 : errors <= 3 ? 0.4 : 0.15;
  if (sev === 'permanent' || sev === 'system') base = Math.min(base, 0.4);
  return base;
}

function normalizeModel(s) {
  if (!s) return null;
  let score = num(s.score);
  if (!Number.isFinite(score)) return null;
  if (score > 1.5) score = score / 100;
  return clamp(score);
}

// ─── Composite scoring ─────────────────────────────────────────────

function calibrateConfidence(signals = {}) {
  const breakdown = {
    intent: normalizeIntent(signals.intent),
    retrieval: normalizeRetrieval(signals.retrieval),
    rerank: normalizeRerank(signals.rerank),
    validators: normalizeValidators(signals.validators),
    answer: normalizeAnswer(signals.answer),
    hallucination: normalizeHallucination(signals.hallucination),
    quality: normalizeQuality(signals.quality),
    tool_health: normalizeToolHealth(signals.tool_health),
    model: normalizeModel(signals.model),
  };

  // Weight only the sources that have a numeric reading; rescale to the
  // covered weight mass so missing signals don't artificially deflate.
  let weightedSum = 0;
  let weightMass = 0;
  for (const [key, value] of Object.entries(breakdown)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const w = WEIGHTS[key] || 0;
    weightedSum += value * w;
    weightMass += w;
  }
  const composite = weightMass === 0 ? 0 : weightedSum / weightMass;

  // Identify the dominant risk: the source with the largest gap between
  // its weight and the score (weight × (1 - score)).
  let dominantRisk = null;
  let largestGap = 0;
  for (const [key, value] of Object.entries(breakdown)) {
    if (typeof value !== 'number') continue;
    const w = WEIGHTS[key] || 0;
    const gap = w * (1 - value);
    if (gap > largestGap) {
      largestGap = gap;
      dominantRisk = { source: key, score: Number(value.toFixed(3)), gap: Number(gap.toFixed(4)) };
    }
  }

  const recommendation = decideRecommendation(composite, breakdown);
  return {
    composite: Number(composite.toFixed(3)),
    breakdown,
    dominantRisk,
    coverage: weightMass / sumWeights(),
    recommendation,
    reasoning: explainRecommendation(composite, recommendation, dominantRisk),
  };
}

function sumWeights() {
  let s = 0;
  for (const v of Object.values(WEIGHTS)) s += v;
  return s;
}

function decideRecommendation(composite, breakdown) {
  // Hard overrides — certain dangerous signals trump composite
  if (breakdown.hallucination != null && breakdown.hallucination < 0.25) {
    return 'repair'; // high hallucination risk → never ship as-is
  }
  if (breakdown.answer != null && breakdown.answer < 0.4) {
    return 'repair'; // answer validator says it's bad
  }
  if (breakdown.validators != null && breakdown.validators < 0.3) {
    return 'repair';
  }
  if (composite >= SHIP_THRESHOLD) return 'ship';
  if (composite >= REVIEW_THRESHOLD) return 'hold_for_review';
  if (composite >= REPAIR_THRESHOLD) return 'repair';
  return 'abort';
}

function explainRecommendation(composite, rec, dominant) {
  const dom = dominant ? `dominant risk: ${dominant.source} at ${dominant.score}` : 'no dominant risk identified';
  switch (rec) {
    case 'ship':
      return `composite ${composite.toFixed(2)} ≥ ${SHIP_THRESHOLD} — ${dom}`;
    case 'hold_for_review':
      return `composite ${composite.toFixed(2)} in review range; ${dom} — consider one human glance before delivery`;
    case 'repair':
      return `composite ${composite.toFixed(2)} below ship; ${dom} — run a repair / regenerate pass`;
    case 'abort':
      return `composite ${composite.toFixed(2)} below repair threshold; ${dom} — escalate to user`;
    default:
      return `composite ${composite.toFixed(2)}`;
  }
}

// ─── Markdown rendering ──────────────────────────────────────────

function renderConfidenceBlock(report, opts = {}) {
  if (!report) return '';
  const title = opts.title || 'CONFIDENCE CALIBRATION';
  const lines = [];
  lines.push(`## ${title}`);
  lines.push(`**Composite:** ${(report.composite * 100).toFixed(1)}/100 · **Recommendation:** \`${report.recommendation}\``);
  lines.push(`**Coverage:** ${(report.coverage * 100).toFixed(0)}% of signal sources reported.`);
  if (report.dominantRisk) {
    lines.push(`**Dominant risk:** \`${report.dominantRisk.source}\` at ${(report.dominantRisk.score * 100).toFixed(0)}%`);
  }
  lines.push('');
  lines.push('| Source | Score | Weight |');
  lines.push('|---|---|---|');
  for (const [key, value] of Object.entries(report.breakdown)) {
    if (typeof value !== 'number') continue;
    lines.push(`| ${key} | ${(value * 100).toFixed(0)} | ${(WEIGHTS[key] * 100).toFixed(0)}% |`);
  }
  lines.push('');
  lines.push(`_${report.reasoning}_`);
  return lines.join('\n');
}

// ─── Helpers ─────────────────────────────────────────────────────

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function clamp(n, lo = 0, hi = 1) {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

module.exports = {
  calibrateConfidence,
  renderConfidenceBlock,
  WEIGHTS,
  SHIP_THRESHOLD,
  REVIEW_THRESHOLD,
  REPAIR_THRESHOLD,
  _internal: {
    normalizeIntent,
    normalizeRetrieval,
    normalizeValidators,
    normalizeAnswer,
    normalizeHallucination,
    normalizeQuality,
    normalizeToolHealth,
    decideRecommendation,
  },
};

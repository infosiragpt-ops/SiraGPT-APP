'use strict';

/**
 * Confidence calibrator — produces an honest uncertainty signal.
 *
 * Mirrors the paper's "known answer vs. unknown name" feature analysis:
 * a good assistant should know *when it doesn't know* and flag ambiguity
 * up-front rather than hallucinate a confident interpretation.
 *
 * Inputs: extraction + graph + supernodes + circuits + planner + hidden intents
 * Output: overall confidence ∈ [0,1], a verbal calibration band, and a
 *         list of specific ambiguities + recommended clarifying questions.
 */

const { FEATURE_CATEGORIES } = require('./feature-extractor');

const BANDS = [
  { min: 0.85, label: 'high', text: 'Intent is clear; proceed directly.' },
  { min: 0.65, label: 'medium-high', text: 'Intent is mostly clear; minor inferences may be needed.' },
  { min: 0.45, label: 'medium', text: 'Intent is partially clear; consider stating assumptions explicitly.' },
  { min: 0.25, label: 'medium-low', text: 'Intent is ambiguous; ask one targeted clarifying question, then proceed.' },
  { min: 0,    label: 'low', text: 'Intent is unclear; gather more information before acting.' },
];

function bandFor(score) {
  for (const b of BANDS) if (score >= b.min) return b;
  return BANDS[BANDS.length - 1];
}

function detectAmbiguities({ extraction, graph, supernodes, hiddenIntents }) {
  const features = extraction?.features || [];
  const actions = features.filter((f) => f.category === FEATURE_CATEGORIES.ACTION);
  const objects = features.filter((f) => f.category === FEATURE_CATEGORIES.OBJECT);
  const refs = features.filter((f) => f.category === FEATURE_CATEGORIES.REFERENCE);
  const negs = features.filter((f) => f.category === FEATURE_CATEGORIES.NEGATION);

  const out = [];

  if (!actions.length) {
    out.push({
      id: 'no-action',
      severity: 'high',
      issue: 'No clear action verb detected.',
      question: 'Could you clarify what you\'d like me to do (e.g. analyze, build, fix, explain)?',
    });
  }

  if (actions.length >= 3) {
    out.push({
      id: 'too-many-actions',
      severity: 'medium',
      issue: `${actions.length} distinct actions detected — request may be compound.`,
      question: 'Which action should I tackle first?',
      detail: actions.map((a) => a.label).join(', '),
    });
  }

  if (actions.length && !objects.length) {
    out.push({
      id: 'action-no-object',
      severity: 'high',
      issue: 'Action(s) detected but no clear target object.',
      question: `What should I ${actions[0].label}?`,
    });
  }

  if (supernodes && supernodes.length >= 3) {
    out.push({
      id: 'cross-theme',
      severity: 'medium',
      issue: `Request spans ${supernodes.length} different themes (${supernodes.slice(0, 3).map((s) => s.label).join(', ')}).`,
      question: 'Should I treat this as one combined task or as separate tasks?',
    });
  }

  if (refs.some((r) => /deictic/.test(r.label)) && !refs.some((r) => /backref|external/.test(r.label))) {
    out.push({
      id: 'unresolved-reference',
      severity: 'medium',
      issue: 'Pronoun / demonstrative reference ("this", "that", "esto") without a clear antecedent.',
      question: 'Which item specifically are you referring to?',
    });
  }

  if (negs.length && actions.length === 0) {
    out.push({
      id: 'negation-no-action',
      severity: 'medium',
      issue: 'Negation present but no positive action — risk of misreading.',
      question: 'What would you like me to do *instead*?',
    });
  }

  const meta = (hiddenIntents || []).find((h) => h.id === 'execute-with-conviction' || h.id === 'implementation-not-discussion');
  if (meta && out.length) {
    // user wants execution → downgrade severity, don't over-ask
    for (const a of out) {
      if (a.severity === 'medium') a.severity = 'low';
    }
  }

  return out;
}

function overallConfidence({ extraction, graph, supernodes, ambiguities, hiddenIntents }) {
  const features = extraction?.features || [];
  if (!features.length) return 0.1;

  // Start from the weighted average confidence of all features
  let totalW = 0;
  let weightedC = 0;
  for (const f of features) {
    const w = f.weight || 0.5;
    totalW += w;
    weightedC += w * (f.confidence || 0.5);
  }
  let score = totalW > 0 ? weightedC / totalW : 0.5;

  // Boost by graph richness (more edges = more cross-confirmation)
  const edgeBoost = Math.min(0.15, (graph?.edges?.length || 0) * 0.005);
  score += edgeBoost;

  // Boost by having at least one strong supernode
  const strongSupernode = (supernodes || []).find((s) => s.aggregateConfidence > 0.75 && s.aggregateWeight > 0.5);
  if (strongSupernode) score += 0.07;

  // Penalize for each high-severity ambiguity
  for (const a of (ambiguities || [])) {
    if (a.severity === 'high') score -= 0.18;
    else if (a.severity === 'medium') score -= 0.08;
    else score -= 0.02;
  }

  // Penalize for frustration / confusion hidden intents
  for (const h of (hiddenIntents || [])) {
    if (h.id === 'frustration-from-prior-failure') score -= 0.05;
    if (h.id === 'asks-explain-after-attempt') score -= 0.03;
  }

  // Clamp
  score = Math.max(0, Math.min(1, score));
  return +score.toFixed(3);
}

function calibrate({ extraction, graph, supernodes, hiddenIntents }) {
  const ambiguities = detectAmbiguities({ extraction, graph, supernodes, hiddenIntents });
  const score = overallConfidence({ extraction, graph, supernodes, ambiguities, hiddenIntents });
  const band = bandFor(score);
  return {
    score,
    band: band.label,
    bandText: band.text,
    ambiguities,
    shouldAskClarification: ambiguities.some((a) => a.severity === 'high'),
  };
}

module.exports = { calibrate, bandFor, detectAmbiguities, overallConfidence, BANDS };

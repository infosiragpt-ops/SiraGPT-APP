'use strict';

/**
 * attribution-confidence-aggregator.js
 *
 * Combines every signal the attribution stack emits into a single
 * 0–1 confidence score the AI route can use to decide whether to ask a
 * clarifying question, surface uncertainty to the user, or proceed
 * confidently. Inspired by the way circuit-tracing aggregates evidence
 * across multiple parallel features.
 *
 * Inputs (any subset; missing signals are skipped):
 *   - engineBundle      (from context-attribution-engine.analyze)
 *   - safetyResult      (from refusal-safety-router.classify)
 *   - driftObservation  (from concept-drift-monitor.observe)
 *   - beliefResult      (from belief-state-tracker.observe)
 *   - faithfulness      (from faithfulness-scorer.scoreFaithfulness)
 *   - antipatternResult (from attribution-anti-pattern-detector.detect)
 *
 * Output: { score, grade, recommendation, contributions[] }
 *
 * Pure heuristic, no I/O.
 */

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function gradeFromScore(s) {
  if (s >= 0.85) return 'A';
  if (s >= 0.70) return 'B';
  if (s >= 0.55) return 'C';
  if (s >= 0.35) return 'D';
  return 'F';
}

function aggregate({
  engineBundle = null,
  safetyResult = null,
  driftObservation = null,
  beliefResult = null,
  faithfulness = null,
  antipatternResult = null,
} = {}) {
  const contributions = [];
  let base = 0.6; // neutral starting confidence

  // 1. Engine intent confidence.
  const topIntent = engineBundle?.attribution?.summary?.topIntents?.[0];
  const runnerUp = engineBundle?.attribution?.summary?.topIntents?.[1];
  if (topIntent) {
    const intentConf = clamp01(topIntent.weight || 0);
    const gap = runnerUp ? Math.max(0, intentConf - clamp01(runnerUp.weight || 0)) : intentConf;
    const delta = (intentConf - 0.5) * 0.3 + gap * 0.2;
    base += delta;
    contributions.push({ source: 'intent', delta: Number(delta.toFixed(3)), note: `top "${topIntent.text}" weight ${intentConf.toFixed(2)}, gap ${gap.toFixed(2)}` });
  } else if (engineBundle) {
    base -= 0.15;
    contributions.push({ source: 'intent', delta: -0.15, note: 'no clear primary intent extracted' });
  }

  // 2. Multi-hop depth — more hops = more uncertainty.
  const hops = engineBundle?.multiHop?.depth || 0;
  if (hops > 0) {
    const delta = -0.05 * Math.min(hops, 3);
    base += delta;
    contributions.push({ source: 'multi_hop', delta: Number(delta.toFixed(3)), note: `${hops} unresolved hop(s)` });
  }

  // 3. Suppression conflicts — uncertainty about which constraint wins.
  const conflicts = engineBundle?.suppression?.conflicts?.length || 0;
  if (conflicts > 0) {
    const delta = -0.1 * Math.min(conflicts, 3);
    base += delta;
    contributions.push({ source: 'suppression', delta: Number(delta.toFixed(3)), note: `${conflicts} conflict(s) with prior rules` });
  }

  // 4. Safety verdict — refuse/route_to_human reduces actionable confidence.
  if (safetyResult && safetyResult.verdict && safetyResult.verdict !== 'allow') {
    const map = { caution: -0.1, route_to_human: -0.2, refuse: -0.3 };
    const delta = map[safetyResult.verdict] || 0;
    base += delta;
    contributions.push({ source: 'safety', delta: Number(delta.toFixed(3)), note: `verdict ${safetyResult.verdict}` });
  }

  // 5. Drift — hard_shift / soft_shift signals topic confusion.
  if (driftObservation && driftObservation.classification) {
    const map = { hard_shift: -0.15, soft_shift: -0.07, continuation: 0.05, baseline: 0 };
    const delta = map[driftObservation.classification] || 0;
    base += delta;
    contributions.push({ source: 'drift', delta: Number(delta.toFixed(3)), note: `class ${driftObservation.classification}` });
  }

  // 6. Belief contradictions — revisions reduce confidence.
  if (beliefResult && beliefResult.contradicted && beliefResult.contradicted.length) {
    const delta = -0.08 * Math.min(beliefResult.contradicted.length, 3);
    base += delta;
    contributions.push({ source: 'belief', delta: Number(delta.toFixed(3)), note: `${beliefResult.contradicted.length} belief(s) contradicted` });
  }

  // 7. Faithfulness on a draft response — high score boosts confidence.
  if (faithfulness && typeof faithfulness.score === 'number') {
    const delta = (faithfulness.score - 0.7) * 0.25;
    base += delta;
    contributions.push({ source: 'faithfulness', delta: Number(delta.toFixed(3)), note: `score ${faithfulness.score} grade ${faithfulness.grade || '-'}` });
  }

  // 8. Anti-patterns — loops/escalation reduce confidence.
  if (antipatternResult && antipatternResult.hasAntipattern) {
    const sevMap = { low: -0.05, medium: -0.1, high: -0.15 };
    let delta = 0;
    for (const p of antipatternResult.patterns) delta += sevMap[p.severity] || -0.05;
    delta = Math.max(-0.3, delta);
    base += delta;
    contributions.push({ source: 'antipattern', delta: Number(delta.toFixed(3)), note: `${antipatternResult.patterns.length} pattern(s)` });
  }

  const score = clamp01(base);
  const grade = gradeFromScore(score);
  const recommendation = buildRecommendation({ score, grade, safetyResult, antipatternResult, conflicts, hops });

  return {
    score: Number(score.toFixed(3)),
    grade,
    recommendation,
    contributions,
  };
}

function buildRecommendation({ score, grade, safetyResult, antipatternResult, conflicts, hops }) {
  if (safetyResult && safetyResult.verdict === 'refuse') {
    return 'Refuse with the safe-alternative recommendation from the safety router.';
  }
  if (safetyResult && safetyResult.verdict === 'route_to_human') {
    return 'Route to a human or recommend a qualified professional; do not act autonomously.';
  }
  if (score < 0.4) {
    return 'Confidence too low to act blindly — ask one focused clarifying question that resolves the largest uncertainty (intent / referent / constraint).';
  }
  if (score < 0.6) {
    if (conflicts > 0) return 'Confirm explicitly whether the new request overrides the prior rule before proceeding.';
    if (hops > 0) return 'Resolve the multi-hop references internally before answering; ask if any hop is ambiguous.';
    if (antipatternResult?.hasAntipattern) return 'Break the conversational loop: reflect what has been tried, ask what specifically is blocking.';
    return 'Proceed but hedge explicitly ("assuming X, …") and offer to adjust if the assumption is wrong.';
  }
  if (score < 0.85) {
    return 'Proceed normally; surface a brief recap of the inferred intent at the start of the response.';
  }
  return 'High confidence; proceed without hedging.';
}

function buildConfidenceBlock(result) {
  if (!result) return '';
  const lines = ['## UNDERSTANDING CONFIDENCE'];
  lines.push(`Score: **${result.score}** (grade ${result.grade}).`);
  lines.push(`Recommendation: ${result.recommendation}`);
  if (result.contributions && result.contributions.length) {
    lines.push('Signal contributions:');
    for (const c of result.contributions) lines.push(`- [${c.source}] ${c.delta >= 0 ? '+' : ''}${c.delta} — ${c.note}`);
  }
  return lines.join('\n');
}

module.exports = {
  aggregate,
  buildConfidenceBlock,
  gradeFromScore,
};

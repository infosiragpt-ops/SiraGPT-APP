'use strict';

/**
 * attribution-ab-experiment-runner.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs two configurations (typically a baseline vs. a variant prompt /
 * model / threshold) against the same test set, scores each through the
 * supplied attribution scorer, and reports which variant wins on
 * intent precision, topic coverage, latency, anomaly rate, and a
 * weighted composite score.
 *
 * Pairs naturally with `attribution-prompt-fuzzer` (variant generation)
 * and `attribution-graph-comparator` (per-case structural diff). This
 * module focuses on the *aggregate* comparison so ops can decide
 * "should I ship this prompt change?".
 *
 * Pure JS, no I/O. Hot path scales linearly with `cases × 2`.
 *
 * Public API:
 *   runExperiment({ name, cases, scorerA, scorerB, opts? })
 *       → ExperimentReport
 *   compareSummaries(summaryA, summaryB)
 *       → ComparisonReport
 *   buildExperimentBlock(report, opts?)
 *       → string
 *
 * Inputs:
 *   cases: [{ id, prompt, expectedIntent?, expectedTopics? }, …]
 *   scorerA(caseRec) / scorerB(caseRec) → CaseScore  (see below)
 *
 * CaseScore (returned by user-provided scorer fn):
 *   {
 *     primaryIntent?: string,
 *     intentMatch?: boolean,
 *     topicCoverage?: number,     // 0..1
 *     latencyMs?: number,
 *     anomalyScore?: number,      // 0..1; lower = better
 *     citationCoverage?: number,  // 0..1
 *     custom?: { [key]: number }, // any extra numeric signals
 *   }
 */

const DEFAULT_WEIGHTS = Object.freeze({
  intentMatch: 0.40,
  topicCoverage: 0.25,
  citationCoverage: 0.15,
  anomalyPenalty: 0.10,
  latencyPenalty: 0.10,
});

function clamp01(v) {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function safeScore(scorer, caseRec) {
  try { return scorer(caseRec); }
  catch (_e) { return { error: true }; }
}

function summarise(scores) {
  const errors = scores.filter((s) => s?.error).length;
  const intentMatches = scores.filter((s) => s?.intentMatch === true).length;
  const topicCovs = scores.map((s) => clamp01(s?.topicCoverage)).filter((v) => v > 0);
  const cites = scores.map((s) => clamp01(s?.citationCoverage)).filter((v) => v > 0);
  const anom = scores.map((s) => clamp01(s?.anomalyScore));
  const latencies = scores.map((s) => Number(s?.latencyMs) || 0);
  return {
    cases: scores.length,
    errors,
    intentMatchRate: scores.length === 0 ? 0 : Number((intentMatches / scores.length).toFixed(3)),
    topicCoverageMean: Number(mean(topicCovs).toFixed(3)),
    citationCoverageMean: Number(mean(cites).toFixed(3)),
    anomalyMean: Number(mean(anom).toFixed(3)),
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    latencyMeanMs: Number(mean(latencies).toFixed(2)),
  };
}

function composite(summary, weights = DEFAULT_WEIGHTS) {
  // anomaly + latency are penalties — invert them
  const anomalyComp = 1 - clamp01(summary.anomalyMean);
  // latency normalised — assume "good" ≤ 100 ms, "bad" ≥ 1000 ms
  const lat = summary.latencyMeanMs;
  let latencyComp = 1;
  if (lat > 100) latencyComp = Math.max(0, 1 - (lat - 100) / 900);
  const score =
    (clamp01(summary.intentMatchRate) * weights.intentMatch) +
    (clamp01(summary.topicCoverageMean) * weights.topicCoverage) +
    (clamp01(summary.citationCoverageMean) * weights.citationCoverage) +
    (anomalyComp * weights.anomalyPenalty) +
    (latencyComp * weights.latencyPenalty);
  return Number(score.toFixed(3));
}

function compareSummaries(summaryA, summaryB, weights = DEFAULT_WEIGHTS) {
  const a = composite(summaryA, weights);
  const b = composite(summaryB, weights);
  const margin = Number((b - a).toFixed(3));
  let winner;
  if (Math.abs(margin) < 0.02) winner = 'tie';
  else winner = margin > 0 ? 'B' : 'A';
  return {
    winner,
    compositeA: a,
    compositeB: b,
    margin,
    deltas: {
      intentMatchRate: Number((summaryB.intentMatchRate - summaryA.intentMatchRate).toFixed(3)),
      topicCoverageMean: Number((summaryB.topicCoverageMean - summaryA.topicCoverageMean).toFixed(3)),
      citationCoverageMean: Number((summaryB.citationCoverageMean - summaryA.citationCoverageMean).toFixed(3)),
      anomalyMean: Number((summaryB.anomalyMean - summaryA.anomalyMean).toFixed(3)),
      latencyP95Ms: summaryB.latencyP95Ms - summaryA.latencyP95Ms,
    },
  };
}

function runExperiment({ name = 'experiment', cases = [], scorerA, scorerB, opts = {} } = {}) {
  if (typeof scorerA !== 'function' || typeof scorerB !== 'function') {
    return { ok: false, error: 'scorerA and scorerB required' };
  }
  if (!Array.isArray(cases) || cases.length === 0) {
    return { ok: false, error: 'cases must be a non-empty array' };
  }
  const t0 = Date.now();
  const scoresA = cases.map((c) => safeScore(scorerA, c));
  const scoresB = cases.map((c) => safeScore(scorerB, c));
  const summaryA = summarise(scoresA);
  const summaryB = summarise(scoresB);
  const weights = opts.weights || DEFAULT_WEIGHTS;
  const comparison = compareSummaries(summaryA, summaryB, weights);
  const durationMs = Date.now() - t0;
  return {
    ok: true,
    name,
    cases: cases.length,
    summaryA,
    summaryB,
    comparison,
    durationMs,
    weights,
    perCase: opts.includePerCase ? cases.map((c, i) => ({
      id: c.id,
      prompt: typeof c.prompt === 'string' ? c.prompt.slice(0, 120) : null,
      scoreA: scoresA[i],
      scoreB: scoresB[i],
    })) : undefined,
  };
}

function buildExperimentBlock(report, opts = {}) {
  if (!report || !report.ok) return '';
  const lines = ['\n\n<ab_experiment>'];
  lines.push(`Experiment: ${report.name} · ${report.cases} cases · ${report.durationMs} ms`);
  lines.push(`Winner: **${report.comparison.winner}** (margin ${report.comparison.margin}).`);
  lines.push(`Composite A=${report.comparison.compositeA}, B=${report.comparison.compositeB}.`);
  lines.push(`Δ intent-match=${report.comparison.deltas.intentMatchRate}, topic=${report.comparison.deltas.topicCoverageMean}, citation=${report.comparison.deltas.citationCoverageMean}, anomaly=${report.comparison.deltas.anomalyMean}, latency-p95=${report.comparison.deltas.latencyP95Ms}ms.`);
  lines.push('</ab_experiment>');
  const text = lines.join('\n');
  const max = Number(opts.maxChars) || 900;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

module.exports = {
  runExperiment,
  compareSummaries,
  buildExperimentBlock,
  summarise,
  composite,
  DEFAULT_WEIGHTS,
};

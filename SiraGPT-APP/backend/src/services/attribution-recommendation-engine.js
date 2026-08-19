'use strict';

/**
 * attribution-recommendation-engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Takes rolled-up attribution telemetry (rollup + perf + adversarial +
 * anomaly baseline + drift summary) and surfaces ranked, actionable
 * operator suggestions. Never auto-applies — humans decide.
 *
 * Public API:
 *   recommend({ rollup?, perfStats?, adversarialCounts?, anomalyBaseline?, driftSummary?, opts? }) → Recommendation[]
 *   buildRecommendationBlock(recs, opts?) → string
 *   classifySeverity(score) → 'low'|'medium'|'high'
 */

const SEVERITY_HIGH = 0.8;
const SEVERITY_MEDIUM = 0.5;

const classifySeverity = (s) => (s >= SEVERITY_HIGH ? 'high' : s >= SEVERITY_MEDIUM ? 'medium' : 'low');

function recommendation(kind, o) {
  return {
    kind,
    severity: classifySeverity(o.score),
    score: Number(o.score.toFixed(3)),
    summary: o.summary,
    proposedAction: o.proposedAction,
    envVars: o.envVars || [],
    evidence: o.evidence || [],
    rationale: o.rationale || '',
  };
}

function fromRollup(rollup, recs) {
  if (!rollup || rollup.empty) return;
  if (typeof rollup.hallucinationRate === 'number' && rollup.hallucinationRate >= 0.10) {
    recs.push(recommendation('threshold_tighten', {
      score: 0.55 + Math.min(0.40, rollup.hallucinationRate),
      summary: `Hallucination rate ${(rollup.hallucinationRate * 100).toFixed(1)}% across ${rollup.samples} samples.`,
      proposedAction: 'Raise SIRAGPT_REFLECTION_ACCEPT_THRESHOLD by 0.05.',
      envVars: ['SIRAGPT_REFLECTION_ACCEPT_THRESHOLD'],
      evidence: [`hallucinationRate=${rollup.hallucinationRate}`, `samples=${rollup.samples}`],
      rationale: 'Higher accept threshold forces more retries on borderline outputs.',
    }));
  }
  if (typeof rollup.meanFaithfulness === 'number' && rollup.meanFaithfulness >= 0.90) {
    recs.push(recommendation('threshold_loosen', {
      score: 0.55,
      summary: `Mean faithfulness ${rollup.meanFaithfulness} sits well above the accept threshold.`,
      proposedAction: 'Consider lowering SIRAGPT_REFLECTION_ACCEPT_THRESHOLD by 0.05 to save retries.',
      envVars: ['SIRAGPT_REFLECTION_ACCEPT_THRESHOLD'],
      evidence: [`meanFaithfulness=${rollup.meanFaithfulness}`],
    }));
  }
  if (typeof rollup.acceptanceRate === 'number' && rollup.acceptanceRate < 0.70) {
    recs.push(recommendation('threshold_loosen', {
      score: 0.65,
      summary: `Acceptance rate only ${(rollup.acceptanceRate * 100).toFixed(1)}% — too many drafts being retried.`,
      proposedAction: 'Lower SIRAGPT_REFLECTION_SOFT_THRESHOLD by 0.05 or relax intent ambiguity.',
      envVars: ['SIRAGPT_REFLECTION_SOFT_THRESHOLD', 'SIRAGPT_AMBIGUITY_DISABLED'],
      evidence: [`acceptanceRate=${rollup.acceptanceRate}`],
    }));
  }
  if (Array.isArray(rollup.topTrimmedBlocks) && rollup.topTrimmedBlocks.length > 0) {
    const top = rollup.topTrimmedBlocks[0];
    if (top.count >= Math.max(5, rollup.samples * 0.25)) {
      recs.push(recommendation('budget_increase', {
        score: 0.60 + Math.min(0.30, top.count / Math.max(1, rollup.samples)),
        summary: `Prompt budget trimming "${top.kind}" on ${top.count}/${rollup.samples} turns.`,
        proposedAction: 'Raise SIRAGPT_PROMPT_BUDGET_TOKENS by ~2000 or move the kind to a higher tier.',
        envVars: ['SIRAGPT_PROMPT_BUDGET_TOKENS'],
        evidence: [`trimmed=${top.kind} count=${top.count} / ${rollup.samples}`],
      }));
    }
  }
  if (Array.isArray(rollup.topIntents) && rollup.topIntents.length > 0) {
    const worst = [...rollup.topIntents].sort((a, b) => (b.failureRate || 0) - (a.failureRate || 0))[0];
    if (worst && worst.failureRate >= 0.40 && worst.count >= 5) {
      recs.push(recommendation('domain_review', {
        score: 0.50 + worst.failureRate * 0.5,
        summary: `Intent "${worst.intent}" failing ${(worst.failureRate * 100).toFixed(1)}% of the time (${worst.count} samples).`,
        proposedAction: 'Review prompt template + supporting context for this intent.',
        evidence: [`intent=${worst.intent} failureRate=${worst.failureRate}`],
      }));
    }
  }
  if (Array.isArray(rollup.byDomain) && rollup.byDomain.length > 0) {
    const worstDomain = [...rollup.byDomain].sort((a, b) => (a.meanFaithfulness || 1) - (b.meanFaithfulness || 1))[0];
    if (worstDomain && worstDomain.meanFaithfulness <= 0.55 && worstDomain.count >= 5) {
      recs.push(recommendation('domain_review', {
        score: 0.60 + (1 - worstDomain.meanFaithfulness) * 0.3,
        summary: `Domain "${worstDomain.domain}" mean faithfulness ${worstDomain.meanFaithfulness}.`,
        proposedAction: `Tighten ${worstDomain.domain} thresholds in domain-calibration or audit RAG sources.`,
        evidence: [`domain=${worstDomain.domain}`, `meanFaithfulness=${worstDomain.meanFaithfulness}`],
      }));
    }
  }
  if (typeof rollup.latencyP95Ms === 'number' && rollup.latencyP95Ms > 500) {
    recs.push(recommendation('latency_alert', {
      score: 0.50 + Math.min(0.40, (rollup.latencyP95Ms - 500) / 2000),
      summary: `End-to-end p95 latency ${rollup.latencyP95Ms} ms (target ≤ 500 ms).`,
      proposedAction: 'Profile attribution-suite per-stage perf; consider raising SIRAGPT_ATTR_CACHE_TTL_MS.',
      envVars: ['SIRAGPT_ATTR_CACHE_TTL_MS'],
      evidence: [`latencyP95Ms=${rollup.latencyP95Ms}`],
    }));
  }
}

function fromPerfStats(perfStats, recs) {
  if (!Array.isArray(perfStats) || perfStats.length === 0) return;
  for (const row of perfStats) {
    if (typeof row.p95 === 'number' && row.p95 > 300) {
      recs.push(recommendation('latency_alert', {
        score: 0.50 + Math.min(0.30, (row.p95 - 300) / 1000),
        summary: `Stage "${row.label}" p95 ${row.p95} ms (samples=${row.samples}).`,
        proposedAction: `Profile + cache or batch the ${row.label} stage.`,
        evidence: [`stage=${row.label} p95=${row.p95}`],
      }));
    }
  }
}

function fromAdversarial(counts, recs) {
  if (!counts || typeof counts !== 'object') return;
  const risky = Object.entries(counts).filter(([k]) => k !== 'safe').reduce((a, [, v]) => a + (v || 0), 0);
  const total = Object.values(counts).reduce((a, b) => a + (b || 0), 0);
  if (total === 0) return;
  const ratio = risky / total;
  if (ratio >= 0.15) {
    recs.push(recommendation('adversarial_spike', {
      score: 0.55 + Math.min(0.40, ratio),
      summary: `Adversarial verdicts on ${(ratio * 100).toFixed(1)}% of recent turns.`,
      proposedAction: 'Inspect adversarial-detector hits; verify SIRAGPT_ADVERSARIAL_DISABLED is unset.',
      envVars: ['SIRAGPT_ADVERSARIAL_DISABLED'],
      evidence: [`riskyShare=${ratio.toFixed(3)}`, `total=${total}`],
    }));
  }
}

function fromAnomaly(baseline, recs) {
  if (!baseline) return;
  if (baseline.samples < 5) {
    recs.push(recommendation('domain_review', {
      score: 0.30,
      summary: `Anomaly baseline based on only ${baseline.samples} samples.`,
      proposedAction: 'Wait for more turns before trusting anomaly alerts.',
      evidence: [`samples=${baseline.samples}`],
    }));
  }
}

function fromDrift(driftSummary, recs) {
  if (!driftSummary) return;
  if (driftSummary.hardShifts && driftSummary.hardShifts >= 2) {
    recs.push(recommendation('drift_alert', {
      score: 0.55 + Math.min(0.30, driftSummary.hardShifts / 10),
      summary: `${driftSummary.hardShifts} hard topic shifts recorded.`,
      proposedAction: 'Review chat — user may be context-switching often.',
      evidence: [`hardShifts=${driftSummary.hardShifts}`],
    }));
  }
}

function recommend({
  rollup = null, perfStats = null, adversarialCounts = null,
  anomalyBaseline = null, driftSummary = null, opts = {},
} = {}) {
  const recs = [];
  fromRollup(rollup, recs);
  fromPerfStats(perfStats, recs);
  fromAdversarial(adversarialCounts, recs);
  fromAnomaly(anomalyBaseline, recs);
  fromDrift(driftSummary, recs);
  recs.sort((a, b) => b.score - a.score);
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 12;
  return recs.slice(0, limit);
}

function buildRecommendationBlock(recommendations, opts = {}) {
  if (!Array.isArray(recommendations) || recommendations.length === 0) return '';
  const maxN = Number(opts.maxN) || 6;
  const lines = ['\n\n<attribution_recommendations>'];
  lines.push(`Engine surfaced ${recommendations.length} suggestion(s), top ${Math.min(maxN, recommendations.length)} shown.`);
  for (const r of recommendations.slice(0, maxN)) {
    lines.push(`  • [${r.severity}/${r.kind}] ${r.summary}`);
    lines.push(`    → ${r.proposedAction}`);
    if (r.envVars.length > 0) lines.push(`    env: ${r.envVars.join(', ')}`);
  }
  lines.push('</attribution_recommendations>');
  const text = lines.join('\n');
  const max = Number(opts.maxChars) || 1600;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

module.exports = {
  recommend, buildRecommendationBlock, classifySeverity, recommendation,
  SEVERITY_HIGH, SEVERITY_MEDIUM,
};

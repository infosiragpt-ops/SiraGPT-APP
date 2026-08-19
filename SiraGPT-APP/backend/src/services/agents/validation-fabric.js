/**
 * validation-fabric — aggregator that merges every category of
 * validation report into a single ReleaseDecision. The
 * ReleaseController reads this and decides: approve / hold /
 * reject / manual-review.
 *
 * Reports supported (each optional):
 *   - ValidationReport     format + schema checks (TaskContract-shaped)
 *   - SecurityReport       secret scan, SAST, DAST, dependency audit
 *   - FactualityReport     citation grounding, hallucination detection
 *   - DesignReview         contrast, hierarchy, accessibility
 *   - CodeReview           lint, type-check, test-pass-rate
 *   - PerformanceReport    latency, cost, tokens_used
 *
 * Each report follows the same shape:
 *   { ok, findings: [{severity, code, detail}], score?, raw? }
 *
 * The aggregator never invents scores. Overall decision is a pure
 * function of findings + severity counts.
 */

const SEVERITY = Object.freeze({
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
});

const RELEASE_DECISIONS = Object.freeze(["approve", "hold", "reject", "manual-review"]);

/**
 * Normalise a partial report to the canonical shape.
 */
function normaliseReport(r) {
  if (!r || typeof r !== "object") return { ok: true, findings: [] };
  const findings = Array.isArray(r.findings)
    ? r.findings.filter(f => f && typeof f === "object").map(f => ({
        severity: f.severity && SEVERITY[f.severity] !== undefined ? f.severity : "medium",
        code: typeof f.code === "string" ? f.code : "finding",
        detail: typeof f.detail === "string" ? f.detail : JSON.stringify(f).slice(0, 300),
      }))
    : [];
  return {
    ok: r.ok !== false,
    findings,
    score: typeof r.score === "number" ? r.score : undefined,
    raw: r.raw || r,
  };
}

/**
 * Apply the release-decision rules over the five reports.
 *
 * Rules (short-circuit in this order):
 *   1. ANY critical finding                         → reject
 *   2. 3+ high findings across reports              → reject
 *   3. ANY report with ok=false                     → hold (needs repair)
 *   4. 1-2 high OR 5+ medium findings               → manual-review
 *   5. Cost or latency budget breached              → hold
 *   6. Otherwise                                    → approve
 */
function aggregate({
  validation,
  security,
  factuality,
  designReview,
  codeReview,
  performance,
  budgets,
} = {}) {
  const reports = {
    validation: normaliseReport(validation),
    security: normaliseReport(security),
    factuality: normaliseReport(factuality),
    designReview: normaliseReport(designReview),
    codeReview: normaliseReport(codeReview),
    performance: normaliseReport(performance),
  };

  // Flatten findings with source annotation so the UI can group them.
  const findings = [];
  for (const [source, r] of Object.entries(reports)) {
    for (const f of r.findings) {
      findings.push({ source, severity: f.severity, code: f.code, detail: f.detail });
    }
  }

  const counts = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;

  const anyNotOk = Object.values(reports).some(r => !r.ok);
  const budgetBreach = budgetBreached(budgets);

  let decision = "approve";
  let reason = "all reports passed";

  if (counts.critical > 0) {
    decision = "reject";
    reason = `${counts.critical} critical finding${counts.critical > 1 ? "s" : ""}`;
  } else if (counts.high >= 3) {
    decision = "reject";
    reason = `${counts.high} high-severity findings exceed threshold`;
  } else if (anyNotOk) {
    decision = "hold";
    const failing = Object.entries(reports).filter(([, r]) => !r.ok).map(([k]) => k);
    reason = `reports not ok: ${failing.join(", ")}`;
  } else if (counts.high >= 1 || counts.medium >= 5) {
    decision = "manual-review";
    reason = `${counts.high} high + ${counts.medium} medium findings require human review`;
  } else if (budgetBreach) {
    decision = "hold";
    reason = `budget breach: ${budgetBreach}`;
  }

  return {
    decision,
    reason,
    findings,
    counts,
    reports,
    budgetBreach: budgetBreach || null,
    decidedAt: new Date().toISOString(),
  };
}

function budgetBreached(budgets) {
  if (!budgets || typeof budgets !== "object") return null;
  if (typeof budgets.usd_spent === "number" && typeof budgets.usd_max === "number" && budgets.usd_spent > budgets.usd_max) {
    return `usd ${budgets.usd_spent.toFixed(4)} > max ${budgets.usd_max.toFixed(4)}`;
  }
  if (typeof budgets.tokens_used === "number" && typeof budgets.tokens_max === "number" && budgets.tokens_used > budgets.tokens_max) {
    return `tokens ${budgets.tokens_used} > max ${budgets.tokens_max}`;
  }
  if (typeof budgets.latency_ms === "number" && typeof budgets.latency_ms_hard === "number" && budgets.latency_ms > budgets.latency_ms_hard) {
    return `latency ${budgets.latency_ms}ms > hard ${budgets.latency_ms_hard}ms`;
  }
  return null;
}

/**
 * Convenience: build an empty set of reports the caller can fill.
 */
function emptyReports() {
  return {
    validation: { ok: true, findings: [] },
    security: { ok: true, findings: [] },
    factuality: { ok: true, findings: [] },
    designReview: { ok: true, findings: [] },
    codeReview: { ok: true, findings: [] },
    performance: { ok: true, findings: [] },
  };
}

module.exports = {
  aggregate,
  normaliseReport,
  emptyReports,
  RELEASE_DECISIONS,
  SEVERITY,
};

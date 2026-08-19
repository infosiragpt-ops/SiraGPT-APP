/**
 * failure-report — canonical FailureReport shape the Self-Repair
 * Loop produces when any stage in the agentic pipeline fails.
 *
 * The report is the single structured object the RepairAgent hands
 * back to the PlannerAgent / ToolRouter: it describes WHAT failed,
 * WHY, and HOW to try again. It is also what telemetry buckets so
 * we can build a confusion matrix between intent / format / tool.
 *
 * Keeping the shape tiny on purpose — if a field isn't actionable
 * for a re-plan, don't add it.
 */

const STAGES = [
  "request_received",
  "contract_created",
  "contract_validated",
  "ambiguity_detected",
  "pipeline_selected",
  "tool_selected",
  "tool_executing",
  "artifact_generated",
  "format_validation",
  "semantic_validation",
  "release_review",
  "final_delivery",
];

const RELEASE_DECISIONS = [
  "retry",                   // repair and try again
  "request_clarification",   // escalate to the user
  "abort",                   // hard fail, surface to user
  "accept_with_warning",     // release but note the concern
];

/**
 * @param {object} args
 * @param {string} args.failed_stage         — one of STAGES
 * @param {string} args.expected_output      — what should have been produced
 * @param {string|object} args.actual_output — what actually happened
 * @param {string} args.root_cause           — short analysis
 * @param {string} args.repair_strategy      — what to try next (concrete, actionable)
 * @param {number} [args.retry_count=0]      — number of prior retries
 * @param {Array<string>} [args.tests_reexecuted] — ids of tests that should be re-run
 * @param {string} [args.release_decision="retry"]
 * @param {object} [args.meta]               — free-form details for telemetry
 *
 * @returns {object} FailureReport with a `createdAt` timestamp.
 */
function createFailureReport({
  failed_stage,
  expected_output,
  actual_output,
  root_cause,
  repair_strategy,
  retry_count = 0,
  tests_reexecuted = [],
  release_decision = "retry",
  meta = {},
}) {
  if (!STAGES.includes(failed_stage)) {
    throw new Error(`failure-report: unknown stage "${failed_stage}". Known: ${STAGES.join(", ")}`);
  }
  if (!RELEASE_DECISIONS.includes(release_decision)) {
    throw new Error(`failure-report: unknown release_decision "${release_decision}". Known: ${RELEASE_DECISIONS.join(", ")}`);
  }
  return {
    version: "1.0",
    failed_stage,
    expected_output: String(expected_output || "").slice(0, 1000),
    actual_output: typeof actual_output === "string" ? actual_output.slice(0, 1000) : actual_output,
    root_cause: String(root_cause || "").slice(0, 400),
    repair_strategy: String(repair_strategy || "").slice(0, 400),
    retry_count: Number(retry_count) || 0,
    tests_reexecuted: Array.isArray(tests_reexecuted) ? tests_reexecuted.slice(0, 30) : [],
    release_decision,
    meta: meta && typeof meta === "object" ? meta : {},
    createdAt: new Date().toISOString(),
  };
}

/**
 * Build a FailureReport from an ArtifactReviewer result.
 * @param {object} review — output of reviewArtifact()
 * @param {object} [options]
 */
function fromReviewer(review, { retry_count = 0, meta = {} } = {}) {
  const failed = review.failedTests || [];
  const ids = failed.map(f => f.id);
  const details = failed.map(f => `${f.id}: ${f.detail}`).join(" | ");
  return createFailureReport({
    failed_stage: "format_validation",
    expected_output: review.contract ? JSON.stringify({ required_extension: review.contract.required_extension, mime_type: review.contract.mime_type }) : "(contract-defined)",
    actual_output: { ext: review.ext, mime: review.mimeSniffed },
    root_cause: `ArtifactReviewer rejected ${failed.length} test${failed.length === 1 ? "" : "s"}`,
    repair_strategy: `Re-call create_document with a corrected script that satisfies: ${details}. Do not substitute formats.`,
    retry_count,
    tests_reexecuted: ids,
    release_decision: "retry",
    meta,
  });
}

/**
 * Build a FailureReport from a FormatSovereigntyEngine decision.
 */
function fromSovereignty(sov, { retry_count = 0, meta = {} } = {}) {
  const ids = (sov.violations || []).map(v => v.id);
  const details = (sov.violations || []).map(v => `${v.id}: ${v.detail}`).join(" | ");
  return createFailureReport({
    failed_stage: "format_validation",
    expected_output: `${sov.expected.extension ? `.${sov.expected.extension}` : "(no file)"} + ${sov.expected.mime || "(no mime)"}`,
    actual_output: `${sov.actual.extension ? `.${sov.actual.extension}` : "(none)"} + ${sov.actual.mime || "(unknown)"}`,
    root_cause: `FormatSovereigntyEngine rejected ${(sov.violations || []).length} violation${(sov.violations || []).length === 1 ? "" : "s"}`,
    repair_strategy: `Regenerate respecting the contract: ${details}. ${sov.repairHint || ""}`,
    retry_count,
    tests_reexecuted: ids,
    release_decision: sov.policy === "hard-block" ? "retry" : "accept_with_warning",
    meta,
  });
}

module.exports = {
  createFailureReport,
  fromReviewer,
  fromSovereignty,
  STAGES,
  RELEASE_DECISIONS,
};

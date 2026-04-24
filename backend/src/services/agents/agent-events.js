/**
 * agent-events — canonical event names the cognitive-agentic
 * pipeline emits. Code SHOULD import from this module instead of
 * hard-coding string literals, so:
 *   1. A typo is a compile-time test failure (constants unresolved)
 *     rather than a silent "event never arrives" bug in the UI.
 *   2. Telemetry can reliably bucket error rates per stage.
 *   3. The list is the design document — the canonical lifecycle of
 *      every user turn.
 *
 * Event ordering (happy path):
 *   request_received
 *     → contract_created
 *     → contract_validated
 *     → pipeline_selected
 *     → [ambiguity_detected? + clarification_needed? → STOP until user replies]
 *     → tool_selected → tool_executing → tool_completed     (×N)
 *     → artifact_generated
 *     → format_validation_passed | format_validation_failed
 *     → [self_repair_started → tool_selected ... if failed]
 *     → semantic_validation_passed | semantic_validation_failed
 *     → release_review_passed
 *     → final_delivery_approved
 *     → done
 *
 * Each event payload is a plain JSON object; canonical shape varies
 * by type but every payload SHOULD include { taskId, at }.
 */

const EVENTS = Object.freeze({
  REQUEST_RECEIVED:              "request_received",
  CONTRACT_CREATED:              "contract_created",
  CONTRACT_VALIDATED:            "contract_validated",
  CONTRACT_VALIDATION_FAILED:    "contract_validation_failed",
  AMBIGUITY_DETECTED:            "ambiguity_detected",
  CLARIFICATION_NEEDED:          "clarification_needed",
  PIPELINE_SELECTED:             "pipeline_selected",
  TOOL_SELECTED:                 "tool_selected",
  TOOL_EXECUTING:                "tool_executing",
  TOOL_COMPLETED:                "tool_completed",
  ARTIFACT_GENERATED:            "artifact_generated",
  FORMAT_VALIDATION_PASSED:      "format_validation_passed",
  FORMAT_VALIDATION_FAILED:      "format_validation_failed",
  SEMANTIC_VALIDATION_PASSED:    "semantic_validation_passed",
  SEMANTIC_VALIDATION_FAILED:    "semantic_validation_failed",
  SELF_REPAIR_STARTED:           "self_repair_started",
  SELF_REPAIR_COMPLETED:         "self_repair_completed",
  RELEASE_REVIEW_PASSED:         "release_review_passed",
  RELEASE_REVIEW_REJECTED:       "release_review_rejected",
  FINAL_DELIVERY_APPROVED:       "final_delivery_approved",
  ERROR:                         "error",
  DONE:                          "done",
});

/**
 * Ambiguity gate: returns { shouldAsk, questions } given a contract.
 * Used by the route to decide whether to stop before invoking tools.
 */
function shouldClarifyBeforeActing(contract) {
  if (!contract || typeof contract !== "object") return { shouldAsk: false, questions: [] };
  const qs = Array.isArray(contract.clarifying_questions) ? contract.clarifying_questions.filter(Boolean) : [];
  const levelHigh = contract.ambiguity_level === "high";
  const scoreHigh = typeof contract.ambiguity_score === "number" && contract.ambiguity_score >= 0.75;
  const shouldAsk = (levelHigh || scoreHigh) && qs.length > 0;
  return { shouldAsk, questions: qs };
}

/**
 * Canonical payload helper so callers don't forget taskId / at.
 */
function makeEvent(type, payload = {}) {
  return {
    type,
    at: new Date().toISOString(),
    ...payload,
  };
}

module.exports = {
  EVENTS,
  makeEvent,
  shouldClarifyBeforeActing,
};

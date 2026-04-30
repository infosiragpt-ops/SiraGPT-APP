/**
 * sira/metrics — pipeline-level Prometheus counters + histograms.
 *
 * Sits on top of the in-process registry shipped in
 * `backend/src/services/agents/metrics.js`. Adds metrics specific to
 * the chat pipeline so a single `/metrics` scrape covers every signal
 * an SRE wants from the platform.
 *
 * Closes part of gap §14.3 in docs/architecture/PIPELINE.md (the
 * `/metrics` half — the `/health` half is in observability/health-check.js).
 *
 * Metric inventory
 * ----------------
 *   sira_chat_turns_total{stage,status,plan}
 *     counter — every chat turn outcome by terminal stage / plan tier.
 *
 *   sira_chat_turn_duration_ms{stage}
 *     histogram — wall-clock duration of a turn ending at that stage.
 *
 *   sira_pipeline_errors_total{stage,code}
 *     counter — every SiraPipelineError thrown anywhere in the pipeline.
 *
 *   sira_token_budget_decisions_total{decision,plan,enforcement_mode}
 *     counter — outcomes of `assessTokenBudget`. `decision` ∈
 *     {allowed, blocked}. Useful to ratchet plan caps.
 *
 *   sira_clarifications_requested_total
 *     counter — how often the policy gates ask the user a question.
 *
 *   sira_envelope_invalid_total
 *     counter — envelope schema rejections.
 *
 * Recorders
 * ---------
 * Thin helpers that the chat-controller / runtime call once per
 * outcome. Each recorder is tolerant of partial input so a missing
 * label doesn't break instrumentation.
 */

const {
  registerCounter,
  registerHistogram,
  counter,
  observe,
} = require("../agents/metrics");

const STAGE_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000];

registerCounter("sira_chat_turns_total", {
  help: "Chat turns by terminal stage, status, and plan tier",
  labels: ["stage", "status", "plan"],
});
registerHistogram("sira_chat_turn_duration_ms", {
  help: "End-to-end chat turn duration in milliseconds, labeled by terminal stage",
  labels: ["stage"],
  buckets: STAGE_BUCKETS_MS,
});
registerCounter("sira_pipeline_errors_total", {
  help: "SiraPipelineError occurrences by stage and code",
  labels: ["stage", "code"],
});
registerCounter("sira_token_budget_decisions_total", {
  help: "Token budget preflight outcomes by decision, plan, and enforcement mode",
  labels: ["decision", "plan", "enforcement_mode"],
});
registerCounter("sira_clarifications_requested_total", {
  help: "Turns that ended with a clarification question to the user",
  labels: [],
});
registerCounter("sira_envelope_invalid_total", {
  help: "Turns that failed envelope schema validation",
  labels: [],
});

/**
 * Record the outcome of a chat turn. Call once at the end of
 * `handleChatTurnUnlocked`, after the terminal stage is known.
 *
 * @param {object} args
 * @param {string} args.stage   — terminal stage (e.g. "delivered", "needs_repair")
 * @param {string} args.status  — "success" | "blocked" | "error" | "needs_clarification"
 * @param {string} [args.plan]  — userPlan ("FREE", "PRO", ...)
 * @param {number} [args.durationMs]
 */
function recordTurn({ stage, status, plan, durationMs } = {}) {
  if (!stage) return;
  counter("sira_chat_turns_total", { stage, status: status || "unknown", plan: plan || "unknown" });
  if (Number.isFinite(durationMs)) {
    observe("sira_chat_turn_duration_ms", { stage }, durationMs);
  }
}

/**
 * Record a token-budget preflight decision. Call from chat-controller
 * stage 2 after `assessTokenBudget` returns.
 */
function recordTokenBudgetDecision({ decision, plan, enforcement_mode } = {}) {
  if (!decision) return;
  counter("sira_token_budget_decisions_total", {
    decision,
    plan: plan || "unknown",
    enforcement_mode: enforcement_mode || "unknown",
  });
}

/**
 * Record a SiraPipelineError. Call from `siraErrorHandler` and from
 * any explicit catch site that translates into a tagged error.
 */
function recordPipelineError({ stage, code } = {}) {
  counter("sira_pipeline_errors_total", {
    stage: stage || "pre_pipeline",
    code: code || "unknown",
  });
}

/**
 * Bump the clarification counter. Call from chat-controller when the
 * policy verdict returns `ask_user_clarification`.
 */
function recordClarificationRequested() {
  counter("sira_clarifications_requested_total", {});
}

/**
 * Bump the envelope-invalid counter. Call from chat-controller when
 * `bundle.stage === "envelope"` (the rejection branch).
 */
function recordEnvelopeInvalid() {
  counter("sira_envelope_invalid_total", {});
}

module.exports = {
  recordTurn,
  recordTokenBudgetDecision,
  recordPipelineError,
  recordClarificationRequested,
  recordEnvelopeInvalid,
};

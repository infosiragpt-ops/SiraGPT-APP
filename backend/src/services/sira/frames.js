/**
 * frames — the 5 internal "frames" Cira passes between layers.
 *
 *   IntentFrame      — what the user wants
 *   PlanFrame        — how to achieve it (steps)
 *   ToolCallFrame    — concrete tool calls to make
 *   ArtifactFrame    — what files / URLs / outputs will exist
 *   ValidationFrame  — pre-delivery checks + verdict
 *
 * Frames are typed: each builder produces a deep-frozen object the
 * downstream layer can trust. Each frame includes a `frame_type` tag
 * so they can travel together (e.g. through the event envelope).
 *
 * Pure JS, deterministic, zero deps.
 */

const FRAME_TYPES = Object.freeze([
  "intent_frame",
  "plan_frame",
  "tool_call_frame",
  "artifact_frame",
  "validation_frame",
  "final_response_frame",
]);

// ── IntentFrame ─────────────────────────────────────────────────────

function buildIntentFrame({ envelope } = {}) {
  if (!envelope || !envelope.intent_analysis) throw new Error("frames.buildIntentFrame: envelope required");
  const ia = envelope.intent_analysis;
  return Object.freeze({
    frame_type: "intent_frame",
    primary_intent: ia.primary_intent.id,
    secondary_intents: ia.secondary_intents.map(s => s.id),
    goal: envelope.goal_model.user_goal,
    confidence: ia.primary_intent.confidence,
    needs_clarification: envelope.clarification_policy.needs_clarification,
    clarifying_questions: [...(envelope.clarification_policy.questions || [])],
  });
}

// ── PlanFrame ───────────────────────────────────────────────────────

function buildPlanFrame({ envelope } = {}) {
  if (!envelope || !envelope.workflow_graph) throw new Error("frames.buildPlanFrame: envelope required");
  const wg = envelope.workflow_graph;
  return Object.freeze({
    frame_type: "plan_frame",
    workflow_type: envelope.task_classification.task_type,
    execution_mode: wg.execution_mode,
    steps: wg.nodes.map(n => ({
      id: n.id,
      name: n.label,
      agent: n.agent,
      tools: [...(n.tools || [])],
      depends_on: [...(n.depends_on || [])],
    })),
    retry_policy: { ...wg.retry_policy },
    timeout_policy: { ...(wg.timeout_policy || {}) },
    validation_gate: { ...(wg.validation_gate || {}) },
    human_approval_gate: { ...(wg.human_approval_gate || {}) },
    release_gate: { ...(wg.release_gate || {}) },
    evidence_ledger: [...(wg.evidence_ledger || [])],
    audit_trace: [...(wg.audit_trace || [])],
    fallback_policy: { ...wg.fallback_policy },
  });
}

// ── ToolCallFrame ───────────────────────────────────────────────────

function buildToolCallFrame({ envelope, args = {} } = {}) {
  if (!envelope || !envelope.tool_plan) throw new Error("frames.buildToolCallFrame: envelope required");
  return Object.freeze({
    frame_type: "tool_call_frame",
    tool_calls: envelope.tool_plan.required_tools.map(t => ({
      tool: t.tool_name,
      tool_type: t.tool_type,
      priority: t.priority,
      risk_level: t.risk_level,
      arguments: args[t.tool_name] || {},
      expected_output: t.expected_output,
    })),
    optional: envelope.tool_plan.optional_tools.map(t => ({ tool: t.tool_name, reason: t.reason })),
    forbidden: envelope.tool_plan.forbidden_tools.map(t => ({ tool: t.tool_name, reason: t.reason })),
  });
}

// ── ArtifactFrame ───────────────────────────────────────────────────

function buildArtifactFrame({ envelope } = {}) {
  if (!envelope || !envelope.output_contract) throw new Error("frames.buildArtifactFrame: envelope required");
  const oc = envelope.output_contract;
  const artifacts = [];
  artifacts.push({
    type: oc.primary_output.type,
    format: oc.primary_output.format || null,
    name: oc.primary_output.filename_suggestion || `primary.${oc.primary_output.format || "out"}`,
    required: Boolean(oc.primary_output.required),
    role: "primary",
  });
  for (const s of oc.secondary_outputs || []) {
    artifacts.push({
      type: s.type,
      format: s.format || null,
      name: s.filename_suggestion || s.label || `secondary_${artifacts.length}`,
      required: Boolean(s.required),
      role: "secondary",
    });
  }
  return Object.freeze({
    frame_type: "artifact_frame",
    artifacts,
    document_specification: oc.document_specification || null,
    spreadsheet_specification: oc.spreadsheet_specification || null,
    visual_specification: oc.visual_specification || null,
    image_specification: oc.image_specification || null,
    video_specification: oc.video_specification || null,
    accessibility: oc.accessibility || null,
  });
}

// ── ValidationFrame ─────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {object} args.envelope
 * @param {Array<{name, status, score?, detail?}>} args.checkResults
 * @param {number} [args.aggregate_score]
 */
function buildValidationFrame({ envelope, checkResults = [], aggregate_score = null } = {}) {
  if (!envelope || !envelope.quality_plan) throw new Error("frames.buildValidationFrame: envelope required");
  const minScore = envelope.quality_plan.minimum_acceptance_score;
  const allPassed = checkResults.every(c => c.status === "passed");
  const score = typeof aggregate_score === "number"
    ? aggregate_score
    : (allPassed ? 1 : (checkResults.length === 0 ? 0 : checkResults.filter(c => c.status === "passed").length / checkResults.length));
  const ready = score >= minScore;
  return Object.freeze({
    frame_type: "validation_frame",
    checks: checkResults.map(c => ({
      name: c.name,
      status: c.status,
      score: typeof c.score === "number" ? c.score : null,
      detail: c.detail || null,
    })),
    aggregate_score: round3(score),
    minimum_acceptance_score: minScore,
    ready_to_deliver: ready,
    regenerate_required: !ready && envelope.quality_plan.regenerate_if_below_score,
  });
}

// ── FinalResponseFrame ──────────────────────────────────────────────

function buildFinalResponseFrame({ envelope, validationFrame, artifacts = [], warnings = [] } = {}) {
  if (!envelope || !envelope.final_answer_contract) throw new Error("frames.buildFinalResponseFrame: envelope required");
  const ready = Boolean(validationFrame?.ready_to_deliver);
  const requiredArtifacts = artifacts.filter(a => a.required !== false);
  return Object.freeze({
    frame_type: "final_response_frame",
    request_id: envelope.request_id,
    delivery_mode: envelope.final_answer_contract.delivery_mode,
    ready_to_deliver: ready,
    release_decision: ready ? "approved" : "blocked_for_repair",
    must_include: [...(envelope.final_answer_contract.must_include || [])],
    must_not_include: [...(envelope.final_answer_contract.must_not_include || [])],
    user_visible_summary: buildUserVisibleSummary(envelope, ready),
    artifact_cards: requiredArtifacts.map(a => ({
      label: a.name || a.filename || a.format || a.type,
      type: a.type,
      format: a.format || null,
      status: a.status || (ready ? "ready" : "planned"),
      download_url: a.download_url || null,
      preview_url: a.preview_url || null,
    })),
    warnings: warnings.slice(0, 6),
  });
}

function buildUserVisibleSummary(envelope, ready) {
  const label = envelope.intent_analysis?.primary_intent?.label || envelope.intent_analysis?.primary_intent?.id || "Tarea";
  if (!ready) return `${label}: la entrega queda bloqueada hasta reparar validaciones pendientes.`;
  return `${label}: entrega validada y lista según el contrato de usuario.`;
}

// ── Frame validators ────────────────────────────────────────────────

function validateFrame(frame) {
  const errors = [];
  if (!frame || typeof frame !== "object") return { ok: false, errors: ["not_an_object"] };
  if (!FRAME_TYPES.includes(frame.frame_type)) errors.push(`unknown frame_type "${frame.frame_type}"`);
  switch (frame.frame_type) {
    case "intent_frame":
      if (!frame.primary_intent) errors.push("intent_frame.primary_intent required");
      if (typeof frame.confidence !== "number") errors.push("intent_frame.confidence required");
      break;
    case "plan_frame":
      if (!Array.isArray(frame.steps)) errors.push("plan_frame.steps must be array");
      if (frame.steps && frame.steps.some(s => !s.id)) errors.push("plan_frame step missing id");
      break;
    case "tool_call_frame":
      if (!Array.isArray(frame.tool_calls)) errors.push("tool_call_frame.tool_calls must be array");
      break;
    case "artifact_frame":
      if (!Array.isArray(frame.artifacts) || frame.artifacts.length === 0) errors.push("artifact_frame.artifacts must be non-empty");
      break;
    case "validation_frame":
      if (typeof frame.aggregate_score !== "number") errors.push("validation_frame.aggregate_score must be number");
      if (typeof frame.ready_to_deliver !== "boolean") errors.push("validation_frame.ready_to_deliver must be boolean");
      break;
    case "final_response_frame":
      if (typeof frame.ready_to_deliver !== "boolean") errors.push("final_response_frame.ready_to_deliver must be boolean");
      if (!frame.release_decision) errors.push("final_response_frame.release_decision required");
      break;
  }
  return { ok: errors.length === 0, errors };
}

function round3(n) { return Math.round(n * 1000) / 1000; }

module.exports = {
  FRAME_TYPES,
  buildIntentFrame,
  buildPlanFrame,
  buildToolCallFrame,
  buildArtifactFrame,
  buildValidationFrame,
  buildFinalResponseFrame,
  validateFrame,
};

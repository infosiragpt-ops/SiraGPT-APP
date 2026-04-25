/**
 * task-envelope-schema — JSON Schema for the Cira Cognitive Task
 * Envelope v1 (cira.task_envelope.v1).
 *
 * The envelope is the universal internal contract that turns ANY user
 * request into an executable plan. It captures:
 *
 *   raw_input · normalized_request · intent_analysis · goal_model
 *   task_classification · entities · context_requirements
 *   data_ingestion_plan · output_contract · model_execution_context
 *   tool_plan · agent_plan · workflow_graph · clarification_policy
 *   safety_and_permissions · quality_plan · ui_response_plan
 *   memory_policy · cost_latency_policy · observability
 *   final_answer_contract
 *
 * The schema is the source of truth. The builder (task-envelope-
 * builder.js) emits objects that conform; the validator
 * (validateEnvelope) checks compliance before downstream agents
 * consume it.
 *
 * Pure JS, deterministic, zero deps.
 */

const SCHEMA_VERSION = "cira.task_envelope.v1";

// ── Top-level schema ────────────────────────────────────────────────

const TASK_ENVELOPE_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: SCHEMA_VERSION,
  title: "Cira Cognitive Task Envelope",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version", "request_id", "created_at",
    "raw_input", "normalized_request",
    "intent_analysis", "goal_model", "task_classification",
    "entities", "context_requirements", "output_contract",
    "model_execution_context", "tool_plan", "agent_plan",
    "workflow_graph", "clarification_policy",
    "safety_and_permissions", "quality_plan", "ui_response_plan",
    "memory_policy", "cost_latency_policy", "observability",
    "final_answer_contract",
  ],
  properties: {
    schema_version: { type: "string", const: SCHEMA_VERSION },
    request_id: { type: "string", minLength: 6, maxLength: 80 },
    conversation_id: { type: ["string", "null"] },
    user_id: { type: ["string", "null"] },
    created_at: { type: "string", format: "date-time" },

    raw_input: {
      type: "object",
      additionalProperties: false,
      required: ["text", "input_language", "input_mode", "attachments", "links", "images", "audio", "video"],
      properties: {
        text: { type: "string" },
        input_language: { type: "string" },
        input_mode: { type: "string", enum: ["text", "voice", "image", "video", "file_only", "mixed"] },
        attachments: { type: "array", items: { type: "object" } },
        links: { type: "array", items: { type: "string" } },
        images: { type: "array", items: { type: "object" } },
        audio: { type: "array", items: { type: "object" } },
        video: { type: "array", items: { type: "object" } },
      },
    },

    normalized_request: {
      type: "object",
      additionalProperties: false,
      required: ["clean_text", "detected_language", "target_language", "user_tone", "spelling_quality", "requires_context_resolution"],
      properties: {
        clean_text: { type: "string" },
        detected_language: { type: "string" },
        target_language: { type: "string" },
        translated_query_en: { type: ["string", "null"] },
        user_tone: { type: "string", enum: ["direct_request", "polite_request", "exploratory", "frustrated", "neutral", "casual"] },
        spelling_quality: { type: "string", enum: ["clean", "noisy_but_understandable", "very_noisy"] },
        requires_context_resolution: { type: "boolean" },
      },
    },

    intent_analysis: {
      type: "object",
      additionalProperties: false,
      required: ["primary_intent", "secondary_intents", "excluded_intents", "task_family", "task_domain", "complexity_level", "ambiguity_level", "novelty_level", "user_effort_expected", "system_autonomy_expected"],
      properties: {
        primary_intent: scoredIntent(),
        secondary_intents: { type: "array", items: scoredIntent(), maxItems: 12 },
        excluded_intents: { type: "array", items: { type: "object", required: ["id", "reason"], properties: { id: { type: "string" }, reason: { type: "string" } } }, maxItems: 12 },
        task_family: { type: "string" },
        task_domain: { type: "string" },
        complexity_level: { type: "string", enum: ["low", "medium", "high", "very_high"] },
        ambiguity_level: { type: "string", enum: ["low", "medium", "high"] },
        novelty_level: { type: "string", enum: ["low", "medium", "high"] },
        user_effort_expected: { type: "string", enum: ["low", "medium", "high"] },
        system_autonomy_expected: { type: "string", enum: ["low", "medium", "high"] },
      },
    },

    goal_model: {
      type: "object",
      additionalProperties: false,
      required: ["user_goal", "success_criteria", "non_goals", "assumptions"],
      properties: {
        user_goal: { type: "string" },
        business_goal: { type: ["string", "null"] },
        success_criteria: { type: "array", items: { type: "string" } },
        non_goals: { type: "array", items: { type: "string" } },
        assumptions: { type: "array", items: assumption() },
      },
    },

    task_classification: {
      type: "object",
      additionalProperties: false,
      required: ["task_type", "execution_category", "output_category", "interaction_pattern", "requires_tool_use", "requires_file_processing", "requires_external_research", "requires_code_execution", "requires_visual_generation", "requires_human_approval", "can_answer_directly"],
      properties: {
        task_type: { type: "string" },
        execution_category: { type: "string" },
        output_category: { type: "string", enum: ["text", "single_artifact", "multi_artifact", "interaction"] },
        interaction_pattern: { type: "string" },
        requires_tool_use: { type: "boolean" },
        requires_file_processing: { type: "boolean" },
        requires_external_research: { type: "boolean" },
        requires_code_execution: { type: "boolean" },
        requires_visual_generation: { type: "boolean" },
        requires_human_approval: { type: "boolean" },
        can_answer_directly: { type: "boolean" },
      },
    },

    entities: { type: "object" },

    context_requirements: {
      type: "object",
      additionalProperties: false,
      required: ["needs_conversation_history", "needs_user_profile", "needs_project_memory", "needs_uploaded_files", "needs_web_search", "needs_scientific_apis", "needs_database_access", "needs_browser_automation", "needs_code_sandbox", "freshness_required", "minimum_source_quality", "citation_required", "source_validation_required"],
      properties: {
        needs_conversation_history: { type: "boolean" },
        needs_user_profile: { type: "boolean" },
        needs_project_memory: { type: "boolean" },
        needs_uploaded_files: { type: "boolean" },
        needs_web_search: { type: "boolean" },
        needs_scientific_apis: { type: "boolean" },
        needs_database_access: { type: "boolean" },
        needs_browser_automation: { type: "boolean" },
        needs_code_sandbox: { type: "boolean" },
        freshness_required: { type: "string", enum: ["none", "low", "medium", "high"] },
        minimum_source_quality: { type: "string" },
        citation_required: { type: "boolean" },
        source_validation_required: { type: "boolean" },
      },
    },

    data_ingestion_plan: { type: "object" },

    output_contract: {
      type: "object",
      required: ["primary_output", "secondary_outputs"],
      properties: {
        primary_output: { type: "object", required: ["type", "required"], properties: { type: { type: "string" }, format: { type: ["string", "null"] }, filename_suggestion: { type: ["string", "null"] }, required: { type: "boolean" } } },
        secondary_outputs: { type: "array", items: { type: "object" } },
        document_specification: { type: ["object", "null"] },
        spreadsheet_specification: { type: ["object", "null"] },
        visual_specification: { type: ["object", "null"] },
        video_specification: { type: ["object", "null"] },
        image_specification: { type: ["object", "null"] },
        accessibility: { type: ["object", "null"] },
      },
    },

    model_execution_context: {
      type: "object",
      additionalProperties: false,
      required: ["selected_model", "model_role", "backend_role", "should_model_generate_final_file_directly", "should_backend_render_artifacts", "structured_output_required", "temperature_policy"],
      properties: {
        selected_model: { type: "object" },
        model_role: { type: "string" },
        backend_role: { type: "string" },
        should_model_generate_final_file_directly: { type: "boolean" },
        should_backend_render_artifacts: { type: "boolean" },
        structured_output_required: { type: "boolean" },
        temperature_policy: { type: "object" },
      },
    },

    tool_plan: {
      type: "object",
      additionalProperties: false,
      required: ["required_tools", "optional_tools", "forbidden_tools"],
      properties: {
        required_tools: { type: "array", items: toolEntry() },
        optional_tools: { type: "array", items: { type: "object", required: ["tool_name", "reason"] } },
        forbidden_tools: { type: "array", items: { type: "object", required: ["tool_name", "reason"] } },
      },
    },

    agent_plan: { type: "object" },

    workflow_graph: {
      type: "object",
      additionalProperties: false,
      required: ["execution_mode", "nodes", "retry_policy", "fallback_policy"],
      properties: {
        execution_mode: { type: "string" },
        nodes: { type: "array", items: workflowNode() },
        retry_policy: { type: "object" },
        fallback_policy: { type: "object" },
      },
    },

    clarification_policy: {
      type: "object",
      additionalProperties: false,
      required: ["needs_clarification", "questions", "auto_assumptions_allowed", "act_without_clarification_if_confidence_above", "ask_user_if_confidence_below"],
      properties: {
        needs_clarification: { type: "boolean" },
        clarification_reason: { type: ["string", "null"] },
        questions: { type: "array", items: { type: "string" }, maxItems: 3 },
        auto_assumptions_allowed: { type: "boolean" },
        act_without_clarification_if_confidence_above: { type: "number", minimum: 0, maximum: 1 },
        ask_user_if_confidence_below: { type: "number", minimum: 0, maximum: 1 },
      },
    },

    safety_and_permissions: {
      type: "object",
      additionalProperties: false,
      required: ["overall_risk_level", "risk_categories", "requires_user_confirmation", "allowed_actions", "blocked_actions", "privacy"],
      properties: {
        overall_risk_level: { type: "string", enum: ["low", "medium", "high", "critical"] },
        risk_categories: { type: "array", items: { type: "object", required: ["category", "risk", "mitigation"] } },
        requires_user_confirmation: { type: "boolean" },
        allowed_actions: { type: "array", items: { type: "string" } },
        blocked_actions: { type: "array", items: { type: "string" } },
        privacy: { type: "object" },
      },
    },

    quality_plan: {
      type: "object",
      additionalProperties: false,
      required: ["quality_level", "validators", "minimum_acceptance_score", "regenerate_if_below_score"],
      properties: {
        quality_level: { type: "string" },
        validators: { type: "array", items: { type: "object", required: ["name", "checks"] } },
        minimum_acceptance_score: { type: "number", minimum: 0, maximum: 1 },
        regenerate_if_below_score: { type: "boolean" },
      },
    },

    ui_response_plan: {
      type: "object",
      additionalProperties: false,
      required: ["show_progress_steps", "progress_labels", "show_tool_activity", "show_intermediate_preview", "final_response_style", "artifact_cards"],
      properties: {
        show_progress_steps: { type: "boolean" },
        progress_labels: { type: "array", items: { type: "string" } },
        show_tool_activity: { type: "string", enum: ["none", "summarized", "detailed"] },
        show_intermediate_preview: { type: "boolean" },
        final_response_style: { type: "string" },
        artifact_cards: { type: "array", items: { type: "object" } },
      },
    },

    memory_policy: {
      type: "object",
      additionalProperties: false,
      required: ["read_memory", "write_memory", "memory_items_to_read", "memory_items_to_write", "do_not_store"],
      properties: {
        read_memory: { type: "boolean" },
        write_memory: { type: "boolean" },
        memory_items_to_read: { type: "array", items: { type: "string" } },
        memory_items_to_write: { type: "array", items: { type: "object" } },
        do_not_store: { type: "array", items: { type: "string" } },
      },
    },

    cost_latency_policy: {
      type: "object",
      additionalProperties: false,
      required: ["priority", "max_tool_calls", "max_research_sources", "max_final_sources", "prefer_parallel_execution", "expensive_tools_allowed", "fallback_to_cheaper_tools"],
      properties: {
        priority: { type: "string", enum: ["quality_over_speed", "speed_over_quality", "cost_over_quality", "balanced"] },
        max_tool_calls: { type: "integer", minimum: 0 },
        max_research_sources: { type: "integer", minimum: 0 },
        max_final_sources: { type: "integer", minimum: 0 },
        prefer_parallel_execution: { type: "boolean" },
        expensive_tools_allowed: { type: "boolean" },
        fallback_to_cheaper_tools: { type: "boolean" },
      },
    },

    observability: {
      type: "object",
      additionalProperties: false,
      required: ["trace_required", "log_model_calls", "log_tool_calls", "log_artifact_generation", "log_validation_scores", "redact_sensitive_data_in_logs", "metrics"],
      properties: {
        trace_required: { type: "boolean" },
        log_model_calls: { type: "boolean" },
        log_tool_calls: { type: "boolean" },
        log_artifact_generation: { type: "boolean" },
        log_validation_scores: { type: "boolean" },
        redact_sensitive_data_in_logs: { type: "boolean" },
        metrics: { type: "array", items: { type: "string" } },
      },
    },

    final_answer_contract: {
      type: "object",
      additionalProperties: false,
      required: ["must_include", "must_not_include", "delivery_mode"],
      properties: {
        must_include: { type: "array", items: { type: "string" } },
        must_not_include: { type: "array", items: { type: "string" } },
        delivery_mode: { type: "string" },
      },
    },
  },
});

// ── Reusable sub-schemas ────────────────────────────────────────────

function scoredIntent() {
  return {
    type: "object",
    required: ["id", "confidence"],
    properties: {
      id: { type: "string" },
      label: { type: ["string", "null"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };
}

function assumption() {
  return {
    type: "object",
    required: ["assumption", "confidence", "needs_user_confirmation"],
    properties: {
      assumption: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      needs_user_confirmation: { type: "boolean" },
    },
  };
}

function toolEntry() {
  return {
    type: "object",
    required: ["tool_name", "tool_type", "reason", "priority", "risk_level", "permission_required", "input_dependencies", "expected_output"],
    properties: {
      tool_name: { type: "string" },
      tool_type: { type: "string" },
      reason: { type: "string" },
      priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
      risk_level: { type: "string", enum: ["low", "medium", "high", "critical"] },
      permission_required: { type: "string" },
      input_dependencies: { type: "array", items: { type: "string" } },
      expected_output: { type: "string" },
    },
  };
}

function workflowNode() {
  return {
    type: "object",
    required: ["id", "label", "agent", "tools", "depends_on", "status"],
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      agent: { type: "string" },
      tools: { type: "array", items: { type: "string" } },
      depends_on: { type: "array", items: { type: "string" } },
      status: { type: "string", enum: ["pending", "running", "done", "failed", "skipped", "cancelled"] },
    },
  };
}

// ── Lightweight validator (no ajv) ──────────────────────────────────
//
// Walks the envelope and checks REQUIRED fields + enum membership +
// types. This is intentionally minimal: it catches the structural
// errors that would break downstream agents. Production runs ajv
// against the schema for full coverage; this function is the always-
// available fallback.

function validateEnvelope(env) {
  const errors = [];
  if (!env || typeof env !== "object") return { ok: false, errors: ["not_an_object"] };
  if (env.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  for (const k of TASK_ENVELOPE_SCHEMA.required) {
    if (!(k in env)) errors.push(`missing.${k}`);
  }
  if (env.intent_analysis) {
    const ia = env.intent_analysis;
    if (!ia.primary_intent || typeof ia.primary_intent.id !== "string") errors.push("intent_analysis.primary_intent.id required");
    if (typeof ia.primary_intent?.confidence !== "number") errors.push("intent_analysis.primary_intent.confidence (number) required");
    for (const k of ["complexity_level", "ambiguity_level", "novelty_level"]) {
      if (ia[k] && !TASK_ENVELOPE_SCHEMA.properties.intent_analysis.properties[k].enum.includes(ia[k])) {
        errors.push(`intent_analysis.${k} invalid: ${ia[k]}`);
      }
    }
  }
  if (env.workflow_graph && Array.isArray(env.workflow_graph.nodes)) {
    // Enforce strict topological order: a node's depends_on must
    // reference ids that appeared EARLIER in the array. This catches
    // forward refs and dangling refs in one pass.
    const seenIds = new Set();
    const allIds = new Set(env.workflow_graph.nodes.map(n => n.id));
    for (const n of env.workflow_graph.nodes) {
      if (!n.id) errors.push("workflow_graph.nodes[*].id required");
      if (seenIds.has(n.id)) errors.push(`duplicate node id "${n.id}"`);
      seenIds.add(n.id);
      for (const dep of n.depends_on || []) {
        if (!allIds.has(dep)) errors.push(`unknown_dep ${n.id}→${dep}`);
        else if (!seenIds.has(dep)) errors.push(`forward_dep ${n.id}→${dep}`);
      }
    }
  }
  if (env.clarification_policy) {
    const cp = env.clarification_policy;
    if (cp.needs_clarification === true && !Array.isArray(cp.questions)) errors.push("clarification_policy.questions required when needs_clarification=true");
  }
  if (env.safety_and_permissions && env.safety_and_permissions.overall_risk_level
      && !["low", "medium", "high", "critical"].includes(env.safety_and_permissions.overall_risk_level)) {
    errors.push("safety.overall_risk_level invalid");
  }
  if (env.quality_plan && typeof env.quality_plan.minimum_acceptance_score === "number") {
    const s = env.quality_plan.minimum_acceptance_score;
    if (s < 0 || s > 1) errors.push("quality_plan.minimum_acceptance_score out_of_range");
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  TASK_ENVELOPE_SCHEMA,
  SCHEMA_VERSION,
  validateEnvelope,
};

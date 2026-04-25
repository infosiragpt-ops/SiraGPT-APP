/**
 * cira-task-envelope — deterministic tests for the Cira Cognitive
 * Task Envelope v1: schema validator + universal taxonomy + builder
 * + 5 frames + 6-step engine.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { TASK_ENVELOPE_SCHEMA, SCHEMA_VERSION, validateEnvelope } = require("../src/services/cira/task-envelope-schema");
const taxonomy = require("../src/services/cira/intent-taxonomy");
const { buildEnvelope } = require("../src/services/cira/task-envelope-builder");
const frames = require("../src/services/cira/frames");
const engine = require("../src/services/cira/engine");

function expect(actual) {
  return {
    toEqual(e) { assert.deepEqual(actual, e); },
    toBe(e) { assert.equal(actual, e); },
    toBeGreaterThan(e) { assert.ok(actual > e, `${actual} not > ${e}`); },
    toBeGreaterThanOrEqual(e) { assert.ok(actual >= e, `${actual} not >= ${e}`); },
    toContain(e) { assert.ok(Array.isArray(actual) ? actual.includes(e) : String(actual).includes(e), `not contained: ${e}`); },
    toBeTruthy() { assert.ok(actual); },
    toBeFalsy() { assert.ok(!actual); },
    toMatch(p) { assert.match(String(actual), p); },
  };
}

// ── Schema ───────────────────────────────────────────────────────────

describe("task-envelope-schema", () => {
  test("schema has required top-level fields", () => {
    expect(SCHEMA_VERSION).toBe("cira.task_envelope.v1");
    for (const k of ["raw_input", "intent_analysis", "goal_model", "tool_plan", "workflow_graph"]) {
      expect(TASK_ENVELOPE_SCHEMA.required.includes(k)).toBe(true);
    }
  });

  test("validateEnvelope rejects empty object", () => {
    const r = validateEnvelope({});
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(5);
  });

  test("validateEnvelope catches forward dependency", () => {
    const env = minimalEnvelope();
    env.workflow_graph.nodes = [
      { id: "a", label: "A", agent: "x", tools: [], depends_on: ["c"], status: "pending" },
      { id: "b", label: "B", agent: "x", tools: [], depends_on: [], status: "pending" },
      { id: "c", label: "C", agent: "x", tools: [], depends_on: [], status: "pending" },
    ];
    const r = validateEnvelope(env);
    expect(r.errors.some(e => e.includes("forward_dep"))).toBe(true);
  });

  test("validateEnvelope catches duplicate node ids", () => {
    const env = minimalEnvelope();
    env.workflow_graph.nodes = [
      { id: "a", label: "A", agent: "x", tools: [], depends_on: [], status: "pending" },
      { id: "a", label: "A2", agent: "x", tools: [], depends_on: [], status: "pending" },
    ];
    const r = validateEnvelope(env);
    expect(r.errors.some(e => e.includes("duplicate"))).toBe(true);
  });

  test("validateEnvelope flags out-of-range minimum_acceptance_score", () => {
    const env = minimalEnvelope();
    env.quality_plan.minimum_acceptance_score = 1.5;
    const r = validateEnvelope(env);
    expect(r.errors.some(e => e.includes("out_of_range"))).toBe(true);
  });
});

// ── Universal taxonomy ──────────────────────────────────────────────

describe("intent-taxonomy", () => {
  test("integrity is clean and totals are reasonable", () => {
    const r = taxonomy.integrity();
    expect(r.ok).toBe(true);
    expect(r.total).toBeGreaterThan(70);
    expect(r.families).toBeGreaterThanOrEqual(14);
  });

  test("getIntent returns deep clones (mutating doesn't pollute)", () => {
    const a = taxonomy.getIntent("academic_document");
    a.default_required_capabilities.push("polluted");
    const fresh = taxonomy.getIntent("academic_document");
    expect(fresh.default_required_capabilities.includes("polluted")).toBe(false);
  });

  test("listIntents filters by family", () => {
    const docs = taxonomy.listIntents({ family: "document_artifacts" });
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every(d => d.family === "document_artifacts")).toBe(true);
  });

  test("intentsByFamily covers all 14 families", () => {
    const m = taxonomy.intentsByFamily();
    expect(Object.keys(m).length).toBeGreaterThanOrEqual(14);
    expect(m.high_risk_domains.length).toBeGreaterThan(0);
  });

  test("every intent has a default output kind", () => {
    for (const t of taxonomy.TAXONOMY) {
      expect(typeof t.default_output_kind).toBe("string");
    }
  });
});

// ── Envelope builder ────────────────────────────────────────────────

describe("task-envelope-builder", () => {
  test("academic-document request produces valid envelope", async () => {
    const r = await buildEnvelope({
      text: "Hazme un informe profesional en Word con fuentes científicas reales en formato APA 7",
      attachments: [{ filename: "datos.xlsx", mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 1234 }],
    });
    expect(r.validation.ok).toBe(true);
    expect(r.envelope.intent_analysis.primary_intent.id).toBe("academic_document");
    expect(r.envelope.entities.requested_formats.includes("docx")).toBe(true);
    expect(r.envelope.context_requirements.needs_uploaded_files).toBe(true);
    expect(r.envelope.context_requirements.citation_required).toBe(true);
  });

  test("image request produces image_specification", async () => {
    const r = await buildEnvelope({
      text: "Genera una imagen realista de un auto deportivo rojo en una ciudad futurista",
    });
    expect(r.validation.ok).toBe(true);
    expect(r.envelope.intent_analysis.task_family).toBe("image");
    expect(r.envelope.output_contract.primary_output.type).toBe("image");
    expect(r.envelope.output_contract.image_specification).toBeTruthy();
  });

  test("video request produces video_specification", async () => {
    const r = await buildEnvelope({
      text: "Haz un video de 10 segundos mostrando una botella de perfume girando",
    });
    expect(r.validation.ok).toBe(true);
    expect(r.envelope.output_contract.primary_output.type).toBe("video");
    expect(r.envelope.output_contract.video_specification).toBeTruthy();
  });

  test("excel request produces spreadsheet_specification", async () => {
    const r = await buildEnvelope({
      text: "Crea un excel para controlar ventas y gastos con gráficos",
    });
    expect(r.validation.ok).toBe(true);
    expect(r.envelope.output_contract.primary_output.format).toBe("xlsx");
    expect(r.envelope.output_contract.spreadsheet_specification).toBeTruthy();
  });

  test("web app request produces code_project output", async () => {
    const r = await buildEnvelope({
      text: "Construye una landing en Next.js para mi clínica dental",
      userPlan: "PRO",
    });
    expect(r.validation.ok).toBe(true);
    expect(r.envelope.output_contract.primary_output.type).toBe("code_project");
  });

  test("attachment-grounded question stays in conversation family", async () => {
    const r = await buildEnvelope({
      text: "¿Cuál es la primera palabra del word adjunto?",
      attachments: [{ filename: "tesis.docx", mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 5000 }],
    });
    expect(r.validation.ok).toBe(true);
    expect(r.envelope.intent_analysis.task_family).toBe("conversation");
  });

  test("clarification policy fires on under-specified prompt", async () => {
    const r = await buildEnvelope({ text: "ok" });
    expect(r.envelope.clarification_policy.needs_clarification).toBe(true);
    expect(r.envelope.clarification_policy.questions.length).toBeGreaterThan(0);
  });

  test("safety risk_categories include research mitigation when needed", async () => {
    const r = await buildEnvelope({
      text: "Genera una tesis APA con DOI verificables y fuentes recientes",
    });
    const categories = r.envelope.safety_and_permissions.risk_categories.map(c => c.category);
    expect(categories.includes("external_research")).toBe(true);
  });

  test("quality_plan includes source_validator for research intents", async () => {
    const r = await buildEnvelope({
      text: "Investiga sobre alfa de Cronbach y dame un resumen con fuentes",
    });
    const names = r.envelope.quality_plan.validators.map(v => v.name);
    expect(names.includes("source_validator")).toBe(true);
  });

  test("rejects missing text", async () => {
    await assert.rejects(buildEnvelope({ text: "" }), /text/);
  });
});

// ── Frames ──────────────────────────────────────────────────────────

describe("frames", () => {
  test("buildIntentFrame mirrors envelope.intent_analysis", async () => {
    const { envelope } = await buildEnvelope({ text: "Genera un excel con datos de ventas" });
    const f = frames.buildIntentFrame({ envelope });
    expect(f.frame_type).toBe("intent_frame");
    expect(f.primary_intent).toBe("xlsx_generation");
    expect(typeof f.confidence).toBe("number");
  });

  test("buildPlanFrame copies workflow nodes", async () => {
    const { envelope } = await buildEnvelope({ text: "Genera un word con un resumen" });
    const f = frames.buildPlanFrame({ envelope });
    expect(f.frame_type).toBe("plan_frame");
    expect(Array.isArray(f.steps)).toBe(true);
    expect(f.steps.length).toBeGreaterThan(0);
  });

  test("buildToolCallFrame surfaces required + optional + forbidden", async () => {
    const { envelope } = await buildEnvelope({ text: "Construye una landing en Next.js para mi clínica", userPlan: "PRO" });
    const f = frames.buildToolCallFrame({ envelope });
    expect(f.frame_type).toBe("tool_call_frame");
    expect(Array.isArray(f.tool_calls)).toBe(true);
    expect(Array.isArray(f.forbidden)).toBe(true);
  });

  test("buildArtifactFrame shapes the primary + secondary artefacts", async () => {
    const { envelope } = await buildEnvelope({ text: "Hazme un word con fuentes APA y dame también PDF" });
    const f = frames.buildArtifactFrame({ envelope });
    expect(f.frame_type).toBe("artifact_frame");
    expect(f.artifacts.length).toBeGreaterThanOrEqual(1);
    expect(f.artifacts[0].role).toBe("primary");
  });

  test("buildValidationFrame computes ready_to_deliver from check results", async () => {
    const { envelope } = await buildEnvelope({ text: "Genera un excel con ventas" });
    const f = frames.buildValidationFrame({
      envelope,
      checkResults: [
        { name: "intent_fulfillment_validator", status: "passed" },
        { name: "artifact_validator", status: "passed" },
        { name: "language_validator", status: "passed" },
      ],
    });
    expect(f.ready_to_deliver).toBe(true);
    expect(f.aggregate_score).toBeGreaterThanOrEqual(0.88);
  });

  test("validateFrame catches bad frame_type", () => {
    const r = frames.validateFrame({ frame_type: "ghost" });
    expect(r.ok).toBe(false);
  });

  test("frames are deep-frozen (mutating throws or no-ops)", async () => {
    const { envelope } = await buildEnvelope({ text: "Genera un word" });
    const f = frames.buildIntentFrame({ envelope });
    let threw = false;
    try { f.primary_intent = "polluted"; } catch { threw = true; }
    expect(threw || f.primary_intent !== "polluted").toBe(true);
  });
});

// ── Engine end-to-end ───────────────────────────────────────────────

describe("engine / runUserMessage", () => {
  test("academic-doc request returns full bundle in dryRun", async () => {
    const r = await engine.runUserMessage({
      text: "Hazme una tesis profesional en Word con fuentes APA 7",
      userPlan: "PRO",
    });
    expect(r.ok).toBe(true);
    expect(r.stage).toBe("delivered");
    expect(r.envelope.schema_version).toBe(SCHEMA_VERSION);
    expect(r.intent_frame.frame_type).toBe("intent_frame");
    expect(r.plan_frame.frame_type).toBe("plan_frame");
    expect(r.tool_call_frame.frame_type).toBe("tool_call_frame");
    expect(r.artifact_frame.frame_type).toBe("artifact_frame");
    expect(r.validation_frame.frame_type).toBe("validation_frame");
    expect(r.response.ready_to_deliver).toBe(true);
  });

  test("under-specified request stops at needs_clarification", async () => {
    const r = await engine.runUserMessage({ text: "ok" });
    expect(r.stage).toBe("needs_clarification");
    expect(r.clarifying_questions.length).toBeGreaterThan(0);
  });

  test("wet-run dispatches tools when tool dispatcher is provided", async () => {
    let dispatched = 0;
    const r = await engine.runUserMessage({
      text: "Genera un excel con un dashboard de ventas",
      dryRun: false,
      toolDispatcher: { run: async () => { dispatched += 1; return { ok: true }; } },
      artifactRenderer: { render: async (a) => ({ ...a, buffer: Buffer.from("stub") }) },
    });
    expect(r.ok).toBe(true);
    expect(dispatched).toBeGreaterThan(0);
    expect(r.tool_results.every(t => t.ok)).toBe(true);
    expect(r.artifact_results.length).toBeGreaterThan(0);
  });

  test("missing prompt throws", async () => {
    await assert.rejects(engine.runUserMessage({ text: "" }), /text/);
  });

  test("snapshot serialises bundle to plain JSON", async () => {
    const r = await engine.runUserMessage({ text: "Genera un word" });
    const snap = engine.snapshot(r);
    expect(typeof JSON.stringify(snap)).toBe("string");
    expect(snap.envelope.schema_version).toBe(SCHEMA_VERSION);
  });
});

// ── helpers ──────────────────────────────────────────────────────────

function minimalEnvelope() {
  return {
    schema_version: SCHEMA_VERSION,
    request_id: "req_test",
    created_at: new Date().toISOString(),
    raw_input: { text: "x", input_language: "es", input_mode: "text", attachments: [], links: [], images: [], audio: [], video: [] },
    normalized_request: { clean_text: "x", detected_language: "es", target_language: "es", user_tone: "neutral", spelling_quality: "clean", requires_context_resolution: false },
    intent_analysis: { primary_intent: { id: "x", confidence: 0.5 }, secondary_intents: [], excluded_intents: [], task_family: "conversation", task_domain: "general", complexity_level: "low", ambiguity_level: "low", novelty_level: "low", user_effort_expected: "low", system_autonomy_expected: "low" },
    goal_model: { user_goal: "x", success_criteria: [], non_goals: [], assumptions: [] },
    task_classification: { task_type: "single_step_text", execution_category: "conversation", output_category: "text", interaction_pattern: "answer_directly", requires_tool_use: false, requires_file_processing: false, requires_external_research: false, requires_code_execution: false, requires_visual_generation: false, requires_human_approval: false, can_answer_directly: true },
    entities: {},
    context_requirements: { needs_conversation_history: true, needs_user_profile: false, needs_project_memory: false, needs_uploaded_files: false, needs_web_search: false, needs_scientific_apis: false, needs_database_access: false, needs_browser_automation: false, needs_code_sandbox: false, freshness_required: "none", minimum_source_quality: "any", citation_required: false, source_validation_required: false },
    output_contract: { primary_output: { type: "text", format: "markdown", required: true }, secondary_outputs: [] },
    model_execution_context: { selected_model: {}, model_role: "x", backend_role: "y", should_model_generate_final_file_directly: false, should_backend_render_artifacts: false, structured_output_required: false, temperature_policy: {} },
    tool_plan: { required_tools: [], optional_tools: [], forbidden_tools: [] },
    agent_plan: {},
    workflow_graph: { execution_mode: "single", nodes: [], retry_policy: {}, fallback_policy: {} },
    clarification_policy: { needs_clarification: false, questions: [], auto_assumptions_allowed: true, act_without_clarification_if_confidence_above: 0.8, ask_user_if_confidence_below: 0.5 },
    safety_and_permissions: { overall_risk_level: "low", risk_categories: [], requires_user_confirmation: false, allowed_actions: [], blocked_actions: [], privacy: {} },
    quality_plan: { quality_level: "basic", validators: [], minimum_acceptance_score: 0.5, regenerate_if_below_score: false },
    ui_response_plan: { show_progress_steps: false, progress_labels: [], show_tool_activity: "none", show_intermediate_preview: false, final_response_style: "concise_text", artifact_cards: [] },
    memory_policy: { read_memory: true, write_memory: true, memory_items_to_read: [], memory_items_to_write: [], do_not_store: [] },
    cost_latency_policy: { priority: "balanced", max_tool_calls: 5, max_research_sources: 0, max_final_sources: 0, prefer_parallel_execution: true, expensive_tools_allowed: false, fallback_to_cheaper_tools: false },
    observability: { trace_required: true, log_model_calls: true, log_tool_calls: true, log_artifact_generation: true, log_validation_scores: true, redact_sensitive_data_in_logs: true, metrics: [] },
    final_answer_contract: { must_include: [], must_not_include: [], delivery_mode: "chat" },
  };
}

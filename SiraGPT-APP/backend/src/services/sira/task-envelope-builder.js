/**
 * task-envelope-builder — turns a raw user request into a full
 * Sira Cognitive Task Envelope v1.
 *
 * Builds deterministically:
 *
 *   1. Normalises raw text + attachments
 *   2. Resolves the primary intent against the universal taxonomy
 *   3. Derives task_classification, output_contract, tool_plan,
 *      agent_plan, workflow_graph, safety, quality, ui, memory,
 *      cost/latency, observability, final_answer policies from
 *      sensible defaults per intent
 *   4. Validates the produced envelope against the schema
 *
 * Optional LLM enrichment hook: when an `llmClient` is provided, the
 * builder calls it to refine the intent + entities + assumptions
 * BEFORE the deterministic defaults fill in everything else. The LLM
 * response is sanitised and merged; the envelope still passes the
 * validator either way.
 *
 * Pure JS, deterministic, zero deps.
 */

const { SCHEMA_VERSION, validateEnvelope } = require("./task-envelope-schema");
const { getIntent, TAXONOMY } = require("./intent-taxonomy");
const intentRouter = require("../ai-product-os/semantic-intent-router");
const skillSystem = require("../ai-product-os/skill-system");
const planner = require("../ai-product-os/planner-agent");
const { analyzeRequestTokens } = require("../agents/request-token-intelligence");

const SIRA_EXECUTION_LAW = Object.freeze({
  do_not_answer_freely: true,
  compile_request_to_contract: true,
  validate_contract_before_execution: true,
  select_tools_only_from_registry: true,
  execute_as_dag: true,
  persist_state: true,
  require_evidence_for_factual_claims: true,
  require_format_sovereignty: true,
  run_deterministic_validators: true,
  repair_before_delivery: true,
  block_release_if_validation_fails: true,
  never_fake_scores: true,
  never_fake_file_reading: true,
  never_fake_citations: true,
  never_fake_artifacts: true,
});

/**
 * @param {object} args
 * @param {string} args.text                    — raw user text
 * @param {Array}  [args.attachments]
 * @param {Array}  [args.history]
 * @param {object} [args.userProfile]
 * @param {string} [args.userPlan]
 * @param {string} [args.conversationId]
 * @param {string} [args.userId]
 * @param {object} [args.modelChoice]           — output of model-router.select()
 * @param {object} [args.llmClient]             — optional intent classifier client
 * @param {string} [args.originalText]          — original user text when `text` is an enriched effective prompt
 * @param {object} [args.contextualUnderstanding] — optional contextual-understanding summary for replay
 * @param {string} [args.requestId]             — caller-supplied request id (HTTP `X-Request-Id`).
 *                                                If omitted, a fresh one is minted. Pass-through
 *                                                from the route handler unifies the access log,
 *                                                audit log, envelope, and response header under
 *                                                a single id per turn.
 * @returns {Promise<{ envelope, validation, frames }>}
 */
async function buildEnvelope({
  text,
  attachments = [],
  history = [],
  userProfile = {},
  userPlan = "FREE",
  conversationId = null,
  userId = null,
  modelChoice = null,
  llmClient = null,
  originalText = null,
  contextualUnderstanding = null,
  requestId = null,
} = {}) {
  if (typeof text !== "string" || text.trim().length === 0) {
    const { IngressError } = require("./pipeline-errors");
    throw new IngressError({
      code: "ingress.envelope_missing_text",
      message: "task-envelope-builder: text (non-empty string) required",
      details: { received_type: typeof text },
      requestId,
    });
  }

  const effectiveText = text;
  const rawText = typeof originalText === "string" && originalText.trim().length > 0
    ? originalText
    : text;

  // ── 1. Normalise raw input ───────────────────────────────────────
  const cleanText = normaliseText(effectiveText);
  const detectedLanguage = detectLanguage(rawText);
  const normalizedAttachments = (attachments || []).map(normaliseAttachment);
  const requestIntelligence = analyzeRequestTokens({
    rawUserRequest: effectiveText,
    fileIds: normalizedAttachments.map(a => a.file_id),
    conversationHistory: history,
  });
  const contextualUnderstandingContext = normalizeContextualUnderstanding(contextualUnderstanding);

  // ── 2. Run the intent router (LLM-primary + regex fallback) ──────
  const decision = await intentRouter.classifyIntent({
    prompt: effectiveText,
    history,
    context: {
      has_attachments: normalizedAttachments.length > 0,
      attachment_kinds: normalizedAttachments.map(a => a.detected_type).filter(Boolean),
      locale: detectedLanguage,
      user_role: userProfile.role || null,
      request_intelligence: compactRequestIntelligence(requestIntelligence),
      contextual_understanding: compactContextualUnderstanding(contextualUnderstandingContext),
    },
    llmClient,
  });
  const tokenAwareDecision = mergeDecisionWithRequestIntelligence(decision, requestIntelligence, effectiveText, normalizedAttachments);

  // Map the router's primary_intent (e.g. "complex_academic_document_generation")
  // to the universal taxonomy id (e.g. "academic_document"). Keeps both ids
  // available so downstream code can pick whichever it prefers.
  const taxonomyIntent = mapRouterIntentToTaxonomy(tokenAwareDecision.intent_primary, normalizedAttachments, effectiveText, requestIntelligence);

  // ── 3. Resolve the skill bundle ──────────────────────────────────
  const skill = skillSystem.resolveSkillForIntent(tokenAwareDecision, { userPlan });
  const enrichedDecision = skillSystem.mergeDecisionWithSkill(tokenAwareDecision, skill);

  // ── 4. Build the planner graph (the workflow_graph) ──────────────
  // Honor a caller-supplied request id so the HTTP layer, the access
  // log, the audit log, and the envelope all share one identifier.
  // Fall back to the legacy mint format only when no caller id is
  // provided (offline tests, eval harness, replay tooling).
  const resolvedRequestId = (typeof requestId === "string" && requestId.length > 0)
    ? requestId
    : `req_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
  const { plan, validation: planValidation } = planner.buildAndValidate(enrichedDecision, {
    contract_id: resolvedRequestId,
  });
  const targetFormat = inferTargetFormatFromDecision(enrichedDecision, taxonomyIntent, requestIntelligence);
  const siraToolPlan = deriveToolPlan(enrichedDecision, taxonomyIntent, targetFormat);
  const clarificationPolicy = deriveClarificationPolicy({
    decision: tokenAwareDecision,
    text: effectiveText,
    taxonomyIntent,
    attachments: normalizedAttachments,
    contextualUnderstanding: contextualUnderstandingContext,
  });
  const workflowGraph = deriveWorkflowGraph(
    plan,
    enrichedDecision,
    taxonomyIntent,
    siraToolPlan.required_tools.map(t => t.tool_name),
    targetFormat,
    requestIntelligence,
    contextualUnderstandingContext,
  );

  // ── 5. Compose the envelope ──────────────────────────────────────
  const envelope = {
    schema_version: SCHEMA_VERSION,
    request_id: resolvedRequestId,
    conversation_id: conversationId,
    user_id: userId,
    created_at: new Date().toISOString(),
    contextual_understanding: contextualUnderstandingContext,

    raw_input: {
      text: rawText,
      input_language: detectedLanguage,
      input_mode: pickInputMode(rawText, normalizedAttachments),
      attachments: normalizedAttachments,
      links: extractLinks(rawText),
      images: normalizedAttachments.filter(a => a.detected_type === "image"),
      audio: normalizedAttachments.filter(a => a.detected_type === "audio"),
      video: normalizedAttachments.filter(a => a.detected_type === "video"),
    },

    normalized_request: {
      clean_text: cleanText,
      detected_language: detectedLanguage,
      target_language: detectedLanguage,
      translated_query_en: null,
      user_tone: inferTone(rawText),
      spelling_quality: inferSpellingQuality(rawText),
      requires_context_resolution: Boolean(contextualUnderstandingContext?.applied)
        || history.length > 0 && /\b(eso|aquello|el documento|la imagen|esto|the file|that one)\b/i.test(rawText),
    },

    intent_analysis: {
      primary_intent: {
        id: taxonomyIntent.id,
        label: taxonomyIntent.label,
        confidence: clamp01(Math.max(tokenAwareDecision.confidence ?? 0.6, Number(requestIntelligence.confidence || 0))),
      },
      secondary_intents: (enrichedDecision.intent_secondary || []).slice(0, 8).map(s => ({ id: s, label: humanise(s), confidence: 0.7 })),
      excluded_intents: deriveExcludedIntents(taxonomyIntent),
      task_family: taxonomyIntent.family,
      task_domain: inferDomain(effectiveText, taxonomyIntent),
      complexity_level: taxonomyIntent.default_complexity,
      ambiguity_level: tokenAwareDecision.needs_clarification ? "high" : ambiguityFromScore(requestIntelligence.ambiguity_score),
      novelty_level: "medium",
      user_effort_expected: "low",
      system_autonomy_expected: tokenAwareDecision.confidence >= 0.8 ? "high" : "medium",
    },

    goal_model: deriveGoalModel(effectiveText, taxonomyIntent, normalizedAttachments, contextualUnderstandingContext),

    task_classification: deriveTaskClassification(taxonomyIntent, enrichedDecision, normalizedAttachments, requestIntelligence),

    entities: deriveEntities(effectiveText, taxonomyIntent, normalizedAttachments, requestIntelligence),

    context_requirements: deriveContextRequirements(taxonomyIntent, normalizedAttachments, requestIntelligence, contextualUnderstandingContext),

    data_ingestion_plan: deriveDataIngestionPlan(normalizedAttachments, taxonomyIntent, requestIntelligence),

    output_contract: deriveOutputContract(taxonomyIntent, effectiveText, targetFormat, requestIntelligence),

    model_execution_context: deriveModelExecutionContext(modelChoice, taxonomyIntent),

    tool_plan: siraToolPlan,

    agent_plan: deriveAgentPlan(enrichedDecision),

    workflow_graph: workflowGraph,

    clarification_policy: clarificationPolicy,

    safety_and_permissions: deriveSafety(taxonomyIntent, enrichedDecision),

    quality_plan: deriveQualityPlan(taxonomyIntent, enrichedDecision, requestIntelligence, contextualUnderstandingContext),

    ui_response_plan: deriveUiPlan(plan, taxonomyIntent),

    memory_policy: deriveMemoryPolicy(taxonomyIntent, normalizedAttachments),

    cost_latency_policy: deriveCostLatencyPolicy(taxonomyIntent),

    observability: {
      trace_required: true,
      log_model_calls: true,
      log_tool_calls: true,
      log_artifact_generation: true,
      log_validation_scores: true,
      redact_sensitive_data_in_logs: true,
      metrics: ["latency", "tool_success_rate", "artifact_success_rate", "source_validation_rate", "user_satisfaction_signal", "cost_estimate"],
      request_intelligence: compactRequestIntelligence(requestIntelligence),
      contextual_values: compactContextualValueContext(contextualUnderstandingContext?.value_context),
    },

    execution_law: { ...SIRA_EXECUTION_LAW },

    final_answer_contract: {
      must_include: deriveMustInclude(taxonomyIntent),
      must_not_include: ["razonamiento_interno_completo", "datos_privados_no_solicitados", "promesas_de_trabajo_futuro"],
      delivery_mode: taxonomyIntent.default_output_kind.startsWith("file:") ? "chat_plus_artifacts" : "chat",
    },
  };

  const validation = validateEnvelope(envelope);
  return {
    envelope,
    validation,
    decision,
    token_aware_decision: tokenAwareDecision,
    request_intelligence: requestIntelligence,
    skill,
    plan,
    plan_validation: planValidation,
  };
}

// ── Mappers + derivers ──────────────────────────────────────────────

function mapRouterIntentToTaxonomy(routerIntent, attachments, rawText = "", requestIntelligence = null) {
  const requestedExtensions = requestedExtensionsFromIntelligence(requestIntelligence);
  if (requestedExtensions.includes(".svg") && requestIntelligence?.pipeline !== "RAGDocumentUnderstandingPipeline") {
    return getIntent("svg_generation");
  }
  if (requestIntelligence?.context?.asks_existing_document_question) {
    return getIntent("general_question");
  }
  if (requestedExtensions.includes(".docx")) {
    if (requestIntelligence?.context?.has_research_requirement || requestIntelligence?.evidence?.research?.present) return getIntent("academic_document");
    return getIntent("report_generation");
  }
  if (requestedExtensions.includes(".pdf")) return getIntent("pdf_generation");
  if (requestedExtensions.includes(".xlsx")) return getIntent("xlsx_generation");
  if (requestedExtensions.includes(".pptx")) return getIntent("pptx_generation");
  if (
    routerIntent === "spreadsheet_generation"
    && spreadsheetMentionIsInputContext(rawText, attachments)
    && documentOutputIsExplicit(rawText)
  ) {
    if (/\b(apa\s*7|tesis|monograf[ií]a|art[ií]culo\s+cient[ií]fico|fuentes?\s+(cient[ií]ficas?|reales)|doi|scopus|openalex|crossref)\b/i.test(rawText)) {
      return getIntent("academic_document");
    }
    return getIntent("report_generation");
  }
  const map = {
    complex_academic_document_generation: "academic_document",
    spreadsheet_generation: "xlsx_generation",
    presentation_generation: "pptx_generation",
    pdf_report_generation: "report_generation",
    image_generation: "image_generation",
    video_generation: "video_generation",
    code_generation: "code_generation",
    web_app_build: "web_app_generation",
    data_analysis: "data_analysis",
    database_query: "database_query",
    web_scraping: "web_scraping",
    design_system: "brand_kit",
    research_question: "scientific_research",
    text_answer: "general_question",
    small_talk: "small_talk",
    math_solving: "general_question",
    viz_generation: "chart_generation",
    email_send: "letter_or_email",
    calendar_action: "calendar_scheduling",
    drive_action: "general_question",
    agent_long_running_task: "workflow_automation",
    unknown: "general_question",
  };
  const id = map[routerIntent] || "general_question";
  const t = getIntent(id);
  if (t) return t;
  // last resort
  return getIntent("general_question");
}

function mergeDecisionWithRequestIntelligence(decision, requestIntelligence, rawText = "", attachments = []) {
  const tokenPrimary = routerIntentFromRequestIntelligence(requestIntelligence, rawText, attachments);
  const useTokenPrimary = Boolean(tokenPrimary)
    && Number(requestIntelligence?.confidence || 0) >= 0.55
    && (
      !decision?.intent_primary
      || decision.intent_primary === "unknown"
      || decision.intent_primary === "text_answer"
      || requestIntelligence?.context?.asks_existing_document_question
      || requestedExtensionsFromIntelligence(requestIntelligence).length > 0
      || requestIntelligence?.context?.has_web_build
    );
  const primary = useTokenPrimary ? tokenPrimary : decision.intent_primary;
  const secondary = new Set([...(decision.intent_secondary || []), ...secondaryIntentsFromRequestIntelligence(requestIntelligence)]);
  const tools = new Set([...(decision.required_tools || []), ...toolsFromRequestIntelligence(requestIntelligence, primary)]);
  const agents = new Set([...(decision.required_agents || []), ...agentsFromRequestIntelligence(requestIntelligence, primary)]);
  const finalOutput = outputFromRequestIntelligence(requestIntelligence, decision.final_output);
  return {
    ...decision,
    intent_primary: primary,
    intent_secondary: Array.from(secondary).slice(0, 12),
    required_tools: Array.from(tools).slice(0, 16),
    required_agents: Array.from(agents).slice(0, 16),
    confidence: clamp01(Math.max(Number(decision.confidence || 0), Number(requestIntelligence?.confidence || 0), useTokenPrimary ? 0.82 : 0)),
    needs_clarification: Boolean(decision.needs_clarification) || Number(requestIntelligence?.ambiguity_score || 0) >= 0.8,
    final_output: finalOutput,
    tier: `${decision.tier || "deterministic"}+token_intelligence`,
    trace: {
      ...(decision.trace || {}),
      request_intelligence_version: requestIntelligence?.version || null,
      token_primary_intent: requestIntelligence?.primary_intent || null,
      token_pipeline: requestIntelligence?.pipeline || null,
      token_confidence: requestIntelligence?.confidence || null,
    },
  };
}

function routerIntentFromRequestIntelligence(requestIntelligence, rawText = "", attachments = []) {
  if (!requestIntelligence) return null;
  if (requestIntelligence.context?.asks_existing_document_question) return "text_answer";
  const requested = requestedExtensionsFromIntelligence(requestIntelligence);
  if (requested.includes(".docx")) return "complex_academic_document_generation";
  if (requested.includes(".pdf")) return "pdf_report_generation";
  if (requested.includes(".xlsx") || requested.includes(".csv")) return "spreadsheet_generation";
  if (requested.includes(".pptx")) return "presentation_generation";
  if (requested.includes(".svg")) return "viz_generation";
  if (requestIntelligence.context?.has_web_build) return "web_app_build";
  if (requestIntelligence.primary_intent === "code_generation") return "code_generation";
  if (requestIntelligence.primary_intent === "research_grounding") return "research_question";
  if (requestIntelligence.primary_intent === "image_generation" || requestIntelligence.pipeline === "ImagePipeline") return "image_generation";
  if (requestIntelligence.primary_intent === "external_action") {
    if (/\b(calendario|calendar|agenda|reunion|meeting|evento)\b/i.test(rawText)) return "calendar_action";
    if (/\b(correo|email|gmail)\b/i.test(rawText)) return "email_send";
    return "agent_long_running_task";
  }
  if (
    requestIntelligence.primary_intent === "spreadsheet_generation"
    && spreadsheetMentionIsInputContext(rawText, attachments)
    && documentOutputIsExplicit(rawText)
  ) {
    return "complex_academic_document_generation";
  }
  return null;
}

function requestedExtensionsFromIntelligence(requestIntelligence) {
  return (requestIntelligence?.requested_formats || []).map(f => f.extension).filter(Boolean);
}

function secondaryIntentsFromRequestIntelligence(requestIntelligence) {
  if (!requestIntelligence) return [];
  const out = [];
  if (requestIntelligence.context?.has_research_requirement) out.push("scientific_research", "source_validation");
  if (requestIntelligence.evidence?.strict?.matches?.includes("doi") || requestIntelligence.evidence?.research?.matches?.includes("doi")) out.push("doi_validation");
  for (const format of requestIntelligence.requested_formats || []) {
    if (format.extension === ".docx") out.push("docx_export");
    if (format.extension === ".xlsx") out.push("excel_export");
    if (format.extension === ".pptx") out.push("pptx_export");
    if (format.extension === ".svg") out.push("svg_export");
    if (format.extension === ".pdf") out.push("pdf_export");
  }
  if (requestIntelligence.context?.has_code_work) out.push("code_generation");
  if (requestIntelligence.context?.has_data_work) out.push("data_analysis");
  return out;
}

function toolsFromRequestIntelligence(requestIntelligence, primaryIntent) {
  if (!requestIntelligence) return [];
  const out = [];
  if (requestIntelligence.context?.has_research_requirement) out.push("scientific_search", "doi_validator", "citation_formatter", "evidence_grounding");
  if (requestIntelligence.context?.has_data_work) out.push("data_analysis_sandbox");
  if (requestIntelligence.context?.has_code_work || primaryIntent === "web_app_build") out.push("code_project_generator", "run_tests", "artifact_validator");
  for (const format of requestIntelligence.requested_formats || []) {
    if (format.extension === ".docx") out.push("create_docx");
    if (format.extension === ".xlsx") out.push("create_xlsx");
    if (format.extension === ".pptx") out.push("create_pptx");
    if (format.extension === ".pdf") out.push("render_pdf_from_html");
    if (format.extension === ".svg") out.push("create_svg");
  }
  if (requestIntelligence.context?.asks_existing_document_question) out.push("evidence_grounding");
  return out;
}

function agentsFromRequestIntelligence(requestIntelligence, primaryIntent) {
  const out = ["intent-compiler"];
  if (!requestIntelligence) return out;
  if (requestIntelligence.context?.has_research_requirement) out.push("research-verifier", "document-analyst");
  if (requestIntelligence.context?.has_data_work) out.push("bi-analyst");
  if (requestIntelligence.context?.has_code_work || primaryIntent === "web_app_build") out.push("code-architect", "frontend-engineer", "qa-regression");
  if (requestIntelligence.requested_formats?.length) out.push("constraint-extractor", "planner", "qa-regression", "release-manager");
  return out;
}

function outputFromRequestIntelligence(requestIntelligence, fallback) {
  const first = requestIntelligence?.requested_formats?.[0]?.extension;
  if (first === ".docx") return "word_document";
  if (first === ".xlsx") return "xlsx_document";
  if (first === ".csv") return "csv_document";
  if (first === ".pptx") return "pptx_document";
  if (first === ".pdf") return "pdf_document";
  if (first === ".svg") return "svg_artifact";
  if (requestIntelligence?.context?.has_web_build) return "web_app";
  return fallback || "text";
}

function compactRequestIntelligence(requestIntelligence) {
  if (!requestIntelligence) return null;
  return {
    version: requestIntelligence.version,
    primary_intent: requestIntelligence.primary_intent,
    pipeline: requestIntelligence.pipeline,
    confidence: requestIntelligence.confidence,
    ambiguity_score: requestIntelligence.ambiguity_score,
    token_count: requestIntelligence.token_count,
    requested_formats: (requestIntelligence.requested_formats || []).map(f => f.extension),
    excluded_formats: (requestIntelligence.excluded_formats || []).map(f => f.extension),
    context: requestIntelligence.context,
    top_scores: (requestIntelligence.intent_scores || []).slice(0, 5),
  };
}

function ambiguityFromScore(score) {
  const value = Number(score || 0);
  if (value >= 0.8) return "high";
  if (value >= 0.45) return "medium";
  return "low";
}

function deriveExcludedIntents(taxonomyIntent) {
  const out = [];
  if (taxonomyIntent.id !== "image_generation") out.push({ id: "image_generation", reason: "El usuario no pidió crear imágenes." });
  if (taxonomyIntent.id !== "video_generation") out.push({ id: "video_generation", reason: "El usuario no pidió video." });
  return out.slice(0, 6);
}

function deriveGoalModel(text, taxonomyIntent, attachments, contextualUnderstanding = null) {
  const wantsExcel = attachments.some(a => a.detected_type === "spreadsheet");
  const successCriteria = [];
  successCriteria.push(`Cumplir el formato de salida ${taxonomyIntent.default_output_kind}.`);
  if (taxonomyIntent.default_required_capabilities.includes("research")) successCriteria.push("Incluir fuentes verificables.");
  if (wantsExcel) successCriteria.push("Procesar el archivo adjunto sin alterarlo.");
  if (taxonomyIntent.family === "document_artifacts") successCriteria.push("Mantener tono profesional y estructura clara.");
  const valueContext = normalizeContextualValueContext(contextualUnderstanding?.value_context);
  const valueLabels = valueContext.values.map(value => value.label).filter(Boolean).slice(0, 3);
  if (valueLabels.length > 0) {
    successCriteria.push(`Alinear la respuesta con valores contextuales detectados: ${valueLabels.join(", ")}.`);
  }
  const hardConstraints = valueContext.constraints
    .filter(constraint => constraint.priority === "hard")
    .map(constraint => constraint.label)
    .filter(Boolean)
    .slice(0, 3);
  if (hardConstraints.length > 0) {
    successCriteria.push(`Preservar restricciones contextuales: ${hardConstraints.join(", ")}.`);
  }
  const goalUnderstanding = normalizeGoalUnderstanding(contextualUnderstanding?.goal_understanding);
  if (goalUnderstanding.inferred_user_goal) {
    successCriteria.push(`Resolver el objetivo inferido del usuario: ${goalUnderstanding.inferred_user_goal}.`);
  }
  if (goalUnderstanding.proactive_next_steps.length > 0) {
    successCriteria.push(`Aplicar pasos proactivos: ${goalUnderstanding.proactive_next_steps.slice(0, 4).join(", ")}.`);
  }
  const attributionGraph = normalizeAttributionGraphContext(contextualUnderstanding?.attribution_graph_context);
  if (attributionGraph.hypothesis && attributionGraph.confidence >= 0.6) {
    successCriteria.push(`Usar la hipotesis de atribucion contextual para seleccionar contexto y herramientas: ${attributionGraph.hypothesis}.`);
  }
  if (attributionGraph.critical_paths.length > 0) {
    successCriteria.push(`Respetar rutas criticas de contexto: ${attributionGraph.critical_paths.slice(0, 3).join("; ")}.`);
  }
  const nonGoals = ["No inventar fuentes.", "No modificar archivos originales sin confirmacion.", "No realizar acciones destructivas."];
  if (valueContext.constraints.some(constraint => constraint.id === "preserve_interface")) {
    nonGoals.push("No alterar la interfaz ni los contratos visuales existentes.");
  }
  if (valueContext.constraints.some(constraint => constraint.id === "native_rewrite_only")) {
    nonGoals.push("No copiar codigo externo dentro del runtime activo; reescribir la conducta con contratos propios de SiraGPT.");
  }
  const assumptions = deriveAssumptions(taxonomyIntent);
  if (goalUnderstanding.confidence >= 0.75 && goalUnderstanding.missing_context.length === 0) {
    assumptions.push({
      assumption: "Usar el objetivo inferido del hilo como guia principal antes de responder o ejecutar.",
      confidence: Math.min(0.92, goalUnderstanding.confidence),
      needs_user_confirmation: false,
    });
  }
  return {
    user_goal: goalUnderstanding.inferred_user_goal || (text.length > 200 ? `${text.slice(0, 200)}…` : text),
    business_goal: null,
    success_criteria: successCriteria,
    non_goals: nonGoals,
    assumptions,
  };
}

function deriveAssumptions(taxonomyIntent) {
  const out = [];
  if (taxonomyIntent.family === "document_artifacts" && taxonomyIntent.id === "academic_document") {
    out.push({ assumption: "Si no se especifica el estilo de citas, usar APA 7.", confidence: 0.82, needs_user_confirmation: false });
  }
  if (taxonomyIntent.family === "spreadsheet_artifacts") {
    out.push({ assumption: "Las hojas se nombran en español por defecto.", confidence: 0.7, needs_user_confirmation: false });
  }
  if (taxonomyIntent.family === "image") {
    out.push({ assumption: "Aspect ratio 16:9 cuando el usuario no especifica.", confidence: 0.65, needs_user_confirmation: false });
  }
  return out;
}

function deriveTaskClassification(taxonomyIntent, decision, attachments, requestIntelligence = null) {
  const wantsTools = (decision.required_tools || []).length > 0;
  const wantsResearch = taxonomyIntent.default_required_capabilities.includes("research") || Boolean(requestIntelligence?.context?.has_research_requirement);
  const wantsCode = taxonomyIntent.default_required_capabilities.includes("code") || Boolean(requestIntelligence?.context?.has_code_work);
  const wantsVision = taxonomyIntent.default_required_capabilities.includes("vision") || taxonomyIntent.family === "image" || Boolean(requestIntelligence?.context?.has_visual_work);
  return {
    task_type: taxonomyIntent.family === "conversation" && !requestIntelligence?.context?.has_files ? "single_step_text" : "multi_step_agentic_workflow",
    execution_category: taxonomyIntent.family,
    output_category: taxonomyIntent.default_output_kind === "text"
      ? "text"
      : taxonomyIntent.default_output_kind === "multi_artifact"
        ? "multi_artifact"
        : "single_artifact",
    interaction_pattern: taxonomyIntent.family === "conversation" ? "answer_directly" : "plan_execute_validate_deliver",
    requires_tool_use: wantsTools,
    requires_file_processing: attachments.length > 0,
    requires_external_research: wantsResearch,
    requires_code_execution: wantsCode || taxonomyIntent.id === "data_analysis",
    requires_visual_generation: wantsVision || taxonomyIntent.family === "design_visual",
    requires_human_approval: taxonomyIntent.default_risk === "critical" || taxonomyIntent.family === "high_risk_domains",
    can_answer_directly: taxonomyIntent.family === "conversation" && !requestIntelligence?.context?.has_files,
  };
}

function deriveEntities(text, taxonomyIntent, attachments, requestIntelligence = null) {
  const requestedFormats = requestedExtensionsFromIntelligence(requestIntelligence).map(ext => ext.replace(/^\./, ""));
  if (requestedFormats.length === 0) {
    if (/\bword\b|\bdocx\b|\.docx\b/i.test(text)) requestedFormats.push("docx");
    if (/\bpdf\b|\.pdf\b/i.test(text)) requestedFormats.push("pdf");
    if (/\bexcel\b|\bxlsx\b|hoja de c[aá]lculo|spreadsheet/i.test(text) && !spreadsheetMentionIsInputContext(text, attachments)) requestedFormats.push("xlsx");
    if (/\bpptx?\b|powerpoint|presentaci[oó]n/i.test(text)) requestedFormats.push("pptx");
    if (/\bsvg\b/i.test(text)) requestedFormats.push("svg");
  }
  return {
    requested_formats: requestedFormats.length > 0 ? requestedFormats : [taxonomyIntent.default_output_kind.replace(/^file:|^image:/, "")],
    excluded_formats: (requestIntelligence?.excluded_formats || []).map(f => f.extension.replace(/^\./, "")),
    request_intelligence: compactRequestIntelligence(requestIntelligence),
    document_type: taxonomyIntent.id,
    citation_style: /apa\s*7|apa septima/i.test(text) ? { value: "APA7", source: "user_specified", confidence: 0.95 } : { value: "APA7", source: "default_inferred", confidence: 0.65 },
    topic: { value: null, source: "not_provided", confidence: 0 },
    data_files: attachments.map(a => ({ file_id: a.file_id, role: "primary_dataset", expected_use: a.detected_type === "spreadsheet" ? "analysis_and_charts" : "context" })),
    target_audience: { value: "academic_or_professional_reader", source: "inferred", confidence: 0.7 },
    deadline: null,
    length_requirement: null,
    style_requirement: taxonomyIntent.family === "document_artifacts" ? "professional_academic" : null,
  };
}

function documentOutputIsExplicit(text) {
  return /\b(word|docx|pdf|informe|reporte|documento|tesis|monograf[ií]a|ensayo)\b/i.test(String(text || ""));
}

function spreadsheetMentionIsInputContext(text, attachments = []) {
  const hasSpreadsheetAttachment = (attachments || []).some(a => a.detected_type === "spreadsheet");
  const t = String(text || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const explicitInput = /\b(?:este|esta|ese|esa|el|la|mi|archivo|adjunto|subido|cargado|datos|dataset)\s+(?:excel|xlsx|xls|csv|spreadsheet|hoja\s+de\s+calculo)\b/.test(t)
    || /\b(?:excel|xlsx|xls|csv|spreadsheet|hoja\s+de\s+calculo)\s+(?:adjunto|subido|cargado|que\s+subi|que\s+envie|existente|de\s+entrada)\b/.test(t)
    || /\b(?:analiza|leer|lee|procesa|extrae|usa|utiliza)\b.{0,80}\b(?:excel|xlsx|xls|csv|spreadsheet|hoja\s+de\s+calculo)\b/.test(t);
  return hasSpreadsheetAttachment && explicitInput;
}

function deriveContextRequirements(taxonomyIntent, attachments, requestIntelligence = null, contextualUnderstanding = null) {
  const caps = taxonomyIntent.default_required_capabilities;
  const ctx = requestIntelligence?.context || {};
  const trajectory = normalizeTaskTrajectory(contextualUnderstanding?.value_context?.task_trajectory);
  return {
    needs_conversation_history: true,
    needs_user_profile: true,
    needs_project_memory: true,
    needs_uploaded_files: attachments.length > 0 || Boolean(ctx.has_files),
    needs_web_search: caps.includes("research") || Boolean(ctx.has_research_requirement) || trajectory.phases.includes("research_current_best_practices"),
    needs_scientific_apis: taxonomyIntent.id === "scientific_research" || taxonomyIntent.id === "academic_document" || Boolean(ctx.has_research_requirement),
    needs_database_access: taxonomyIntent.id === "database_query" || /\bsql|database|base de datos|postgres|mysql\b/i.test(requestIntelligence?.normalized_request || ""),
    needs_browser_automation: taxonomyIntent.id === "web_scraping" || taxonomyIntent.id === "browser_automation" || Boolean(ctx.has_external_action) || trajectory.phases.includes("publish_and_monitor"),
    needs_code_sandbox: caps.includes("sandbox") || caps.includes("code") || Boolean(ctx.has_code_work || ctx.has_data_work) || trajectory.phases.includes("implement_changes"),
    freshness_required: caps.includes("research") || ctx.has_research_requirement ? "medium" : "none",
    minimum_source_quality: caps.includes("research") || ctx.has_research_requirement ? "scientific_or_institutional" : "any",
    citation_required: caps.includes("research") || Boolean(requestIntelligence?.evidence?.research?.matches?.includes("citas")),
    source_validation_required: caps.includes("research") || Boolean(ctx.has_research_requirement),
    needs_end_to_end_task_state: trajectory.mode === "end_to_end_execution",
  };
}

function deriveDataIngestionPlan(attachments, taxonomyIntent, requestIntelligence = null) {
  const externalSources = [];
  if (taxonomyIntent.default_required_capabilities.includes("research") || requestIntelligence?.context?.has_research_requirement) {
    externalSources.push(
      { source: "scopus", purpose: "scientific_literature", required: true },
      { source: "openalex", purpose: "scientific_literature", required: true },
      { source: "scielo", purpose: "scientific_literature", required: false },
      { source: "crossref", purpose: "doi_validation", required: true },
    );
  }
  return {
    files_to_process: attachments.map(a => ({
      file_id: a.file_id,
      processor: a.detected_type === "spreadsheet" ? "spreadsheet_reader"
        : a.detected_type === "image" ? "image_analyser"
        : "doc_parser",
      extraction_targets: a.detected_type === "spreadsheet"
        ? ["sheet_names", "columns", "data_types", "missing_values", "descriptive_statistics", "chart_candidates"]
        : ["text", "headings", "tables", "figures"],
      quality_checks: ["detect_empty_rows", "detect_invalid_values", "detect_outliers"],
    })),
    external_sources: externalSources,
    source_ranking_strategy: {
      prefer: ["peer_reviewed_articles", "doi_available", "recent_sources", "indexed_journals", "official_institutions"],
      avoid: ["blogs_without_authority", "uncited_claims", "broken_links"],
    },
  };
}

function deriveOutputContract(taxonomyIntent, text, targetFormat = null, requestIntelligence = null) {
  const kind = taxonomyIntent.default_output_kind;
  if (kind === "text") {
    return {
      primary_output: { type: "text", format: "markdown", filename_suggestion: null, required: true },
      secondary_outputs: [],
    };
  }
  if (kind.startsWith("file:")) {
    let fmt = targetFormat || kind.split(":")[1];
    if (taxonomyIntent.family === "document_artifacts" && /\b(pdf|\.pdf)\b/i.test(text) && !/\b(word|docx|\.docx)\b/i.test(text)) {
      fmt = "pdf";
    }
    const secondary = [];
    const requestedFormats = requestedExtensionsFromIntelligence(requestIntelligence).map(ext => ext.replace(/^\./, ""));
    if ((/pdf/i.test(text) || requestedFormats.includes("pdf")) && fmt !== "pdf") secondary.push({ type: "file", format: "pdf", required: true });
    if (taxonomyIntent.family === "document_artifacts") secondary.push({ type: "inline_summary", format: "markdown", required: true });
    return {
      primary_output: { type: "file", format: fmt, filename_suggestion: `${slug(taxonomyIntent.id)}.${fmt}`, required: true },
      secondary_outputs: secondary,
      document_specification: taxonomyIntent.family === "document_artifacts" ? defaultDocSpec() : null,
      spreadsheet_specification: taxonomyIntent.family === "spreadsheet_artifacts" ? defaultXlsxSpec() : null,
      visual_specification: null,
      video_specification: null,
      image_specification: null,
      accessibility: { alt_text_for_images: true, clear_heading_structure: true, table_headers_required: true },
    };
  }
  if (kind === "image" || kind.startsWith("image:")) {
    return {
      primary_output: { type: "image", format: kind.split(":")[1] || "png", filename_suggestion: null, required: true },
      secondary_outputs: [],
      image_specification: { style: "photorealistic", aspect_ratio: "16:9", quality: "high" },
    };
  }
  if (kind === "video") {
    return {
      primary_output: { type: "video", format: "mp4", filename_suggestion: null, required: true },
      secondary_outputs: [],
      video_specification: { duration_seconds: 10, style: "cinematic", aspect_ratio: "16:9" },
    };
  }
  if (kind === "audio") {
    return {
      primary_output: { type: "audio", format: "mp3", filename_suggestion: null, required: true },
      secondary_outputs: [],
    };
  }
  if (kind === "code_artifact") {
    return {
      primary_output: { type: "code_project", format: "zip", filename_suggestion: `${slug(taxonomyIntent.id)}.zip`, required: true },
      secondary_outputs: [{ type: "preview_url", required: false }, { type: "technical_summary", format: "markdown", required: true }],
    };
  }
  return {
    primary_output: { type: "multi_artifact", format: null, filename_suggestion: null, required: true },
    secondary_outputs: [],
  };
}

function defaultDocSpec() {
  return {
    include_cover_page: true,
    include_table_of_contents: true,
    include_introduction: true,
    include_methodology: false,
    include_results: false,
    include_discussion: false,
    include_conclusions: true,
    include_references: true,
    include_appendices: "if_needed",
    include_charts: true,
    include_tables: true,
    citation_style: "APA7",
    tone: "formal_professional",
    language: "es",
  };
}

function defaultXlsxSpec() {
  return {
    sheets: ["Resumen", "Datos", "Análisis"],
    formulas_required: true,
    charts_required: true,
    styles_required: true,
    freeze_headers: true,
    data_validation: true,
  };
}

function deriveModelExecutionContext(modelChoice, taxonomyIntent) {
  return {
    selected_model: {
      provider: modelChoice?.model?.provider || "user_selected",
      model_id: modelChoice?.model?.id || "selected_by_user",
      modality: taxonomyIntent.family === "image" ? "image" : taxonomyIntent.family === "video" ? "video" : "text",
    },
    model_role: "reasoning_and_generation",
    backend_role: "tool_execution_and_validation",
    should_model_generate_final_file_directly: false,
    should_backend_render_artifacts: !["text", "image", "video", "audio"].includes(taxonomyIntent.default_output_kind),
    structured_output_required: ["document_artifacts", "spreadsheet_artifacts", "presentation_artifacts", "data"].includes(taxonomyIntent.family),
    temperature_policy: { planning: 0.2, research_synthesis: 0.3, creative_writing: 0.6, final_answer: 0.3 },
  };
}

function deriveToolPlan(decision, taxonomyIntent, targetFormat = null) {
  const requiredToolNames = normaliseSiraTools([
    ...(decision.required_tools || []),
    ...defaultToolsForIntent(taxonomyIntent, targetFormat),
  ], taxonomyIntent, targetFormat);
  const required = requiredToolNames.map(toolName => ({
    tool_name: toolName,
    tool_type: "registry",
    reason: `Resolves intent ${taxonomyIntent.id} per skill bundle.`,
    priority: "critical",
    risk_level: "low",
    permission_required: "registered_scope",
    input_dependencies: [],
    expected_output: "tool_result",
  }));
  return {
    required_tools: required,
    optional_tools: [
      { tool_name: "grammar_style_reviewer", reason: "Pulir redacción profesional cuando aplique." },
    ],
    forbidden_tools: [
      { tool_name: "direct_file_overwrite", reason: "Nunca modificar archivos originales sin confirmación." },
    ],
  };
}

function deriveAgentPlan(decision) {
  const out = {};
  for (const id of (decision.required_agents || [])) {
    out[id] = { role: humanise(id), active: true };
  }
  return out;
}

function deriveWorkflowGraph(plan, decision, taxonomyIntent, requiredToolNames = [], targetFormat = null, requestIntelligence = null, contextualUnderstanding = null) {
  const nodes = (plan.nodes || []).map(n => ({
    id: n.id,
    label: humanise(n.id),
    agent: n.agent || "intent-compiler",
    tools: n.tool ? normaliseSiraTools([n.tool], taxonomyIntent, targetFormat) : [],
    depends_on: n.depends_on || [],
    status: "pending",
  }));
  const existingTools = new Set(nodes.flatMap(n => n.tools || []));
  let lastNodeId = nodes.length > 0 ? nodes[nodes.length - 1].id : null;
  const trajectory = normalizeTaskTrajectory(contextualUnderstanding?.value_context?.task_trajectory);
  if (trajectory.mode === "end_to_end_execution") {
    for (const phase of trajectory.phases) {
      const nodeId = `trajectory.${phase}`;
      if (nodes.some(n => n.id === nodeId)) continue;
      const phaseTools = toolsForTrajectoryPhase(phase, requiredToolNames);
      nodes.push({
        id: nodeId,
        label: humanise(phase),
        agent: agentForTrajectoryPhase(phase),
        tools: phaseTools,
        depends_on: lastNodeId ? [lastNodeId] : [],
        status: "pending",
      });
      for (const tool of phaseTools) existingTools.add(tool);
      lastNodeId = nodeId;
    }
  }
  for (const toolName of requiredToolNames) {
    if (existingTools.has(toolName)) continue;
    const nodeId = `tool.${toolName}`;
    nodes.push({
      id: nodeId,
      label: humanise(toolName),
      agent: agentForSiraTool(toolName),
      tools: [toolName],
      depends_on: lastNodeId ? [lastNodeId] : [],
      status: "pending",
    });
    existingTools.add(toolName);
    lastNodeId = nodeId;
  }
  const edges = [];
  for (const node of nodes) {
    for (const dep of node.depends_on || []) {
      edges.push({ from: dep, to: node.id, type: "dependency" });
    }
  }
  const toolCalls = nodes.flatMap(node => (node.tools || []).map(tool => ({
    node_id: node.id,
    tool_name: tool,
    status: "planned",
    input_key: `${node.id}.input`,
    output_key: `${node.id}.${tool}.output`,
  })));
  return {
    execution_mode: "durable_multi_step",
    nodes,
    edges,
    state: "planned",
    artifacts: [],
    tool_calls: toolCalls,
    permissions: {
      read_uploaded_files: true,
      write_new_artifacts: true,
      execute_sandboxed_code: Boolean((decision.required_tools || []).some(t => /sandbox|code|test|build/i.test(t))),
      external_api_access: Boolean((decision.required_tools || []).some(t => /research|web|doi|openalex|crossref/i.test(t))),
      destructive_actions_allowed: false,
    },
    idempotency_key: `cira:${plan.graph_id || "graph"}:${decision.intent_primary || "intent"}`,
    retry_policy: {
      max_retries_per_node: 2,
      retry_on: ["tool_timeout", "invalid_json", "file_generation_error", "source_validation_failure"],
    },
    timeout_policy: {
      per_node_ms: 30000,
      total_workflow_ms: 15 * 60 * 1000,
      on_timeout: "pause_and_resume_or_repair",
    },
    compensation_action: "record_failure_report_and_preserve_original_inputs",
    rollback_strategy: "new_artifacts_only_no_original_overwrite",
    validation_gate: {
      required: true,
      validators: trajectory.mode === "end_to_end_execution"
        ? ["intent_fulfillment_validator", "contextual_alignment_validator", "artifact_validator", "safety_validator"]
        : ["intent_fulfillment_validator", "artifact_validator", "safety_validator"],
      block_release_on_failure: true,
    },
    human_approval_gate: {
      required: Boolean(decision.needs_clarification || decision.risk_level === "critical"),
      reasons: decision.needs_clarification ? ["clarification_required"] : [],
    },
    release_gate: {
      required: true,
      controller: "release_manager_agent",
      decision: "pending",
      blocks_on: ["failed_validation", "missing_artifact", "format_mismatch", "unsafe_action"],
    },
    evidence_ledger: [],
    audit_trace: [
      {
        event: "request_intelligence_completed",
        at: new Date().toISOString(),
        source: "cira.request-token-intelligence",
        primary_intent: requestIntelligence?.primary_intent || null,
        pipeline: requestIntelligence?.pipeline || null,
        confidence: requestIntelligence?.confidence || null,
        token_count: requestIntelligence?.token_count || 0,
        requested_formats: requestedExtensionsFromIntelligence(requestIntelligence),
      },
      {
        event: "contract_created",
        at: new Date().toISOString(),
        source: "cira.task-envelope-builder",
        decision_tier: decision.tier || "unknown",
      },
      {
        event: "workflow_graph_created",
        at: new Date().toISOString(),
        nodes: nodes.length,
        tool_calls: toolCalls.length,
      },
      ...(trajectory.mode === "end_to_end_execution" ? [{
        event: "task_trajectory_applied",
        at: new Date().toISOString(),
        mode: trajectory.mode,
        phases: trajectory.phases,
        success_criteria_count: trajectory.success_criteria.length,
      }] : []),
    ],
    fallback_policy: {
      if_scientific_api_fails: "use_alternative_source_api",
      if_pdf_export_fails: "render_pdf_from_html",
      if_chart_generation_fails: "generate_tables_only_and_report_limitation",
    },
  };
}

function agentForTrajectoryPhase(phase) {
  if (/research/.test(phase)) return "research-agent";
  if (/plan/.test(phase)) return "planner-agent";
  if (/implement/.test(phase)) return "coder-agent";
  if (/validate/.test(phase)) return "qa-validator";
  if (/publish|monitor/.test(phase)) return "release-manager-agent";
  if (/deliver/.test(phase)) return "response-calibrator";
  return "context-manager";
}

function toolsForTrajectoryPhase(phase, requiredToolNames = []) {
  if (/research/.test(phase)) return requiredToolNames.includes("scientific_search") ? ["scientific_search"] : ["web_search"];
  if (/implement/.test(phase)) return requiredToolNames.filter(t => /code|project|test|artifact|build/i.test(t)).slice(0, 3);
  if (/validate/.test(phase)) return requiredToolNames.filter(t => /test|validator|validate|build/i.test(t)).slice(0, 4);
  return [];
}

function normaliseSiraTools(toolNames, taxonomyIntent, targetFormat = null) {
  const out = [];
  for (const raw of toolNames || []) {
    for (const mapped of mapToolToSiraRegistry(raw, taxonomyIntent, targetFormat)) {
      if (mapped && !out.includes(mapped)) out.push(mapped);
    }
  }
  return out;
}

function mapToolToSiraRegistry(rawToolName, taxonomyIntent, targetFormat = null) {
  const name = String(rawToolName || "");
  const fmt = targetFormat || (taxonomyIntent.default_output_kind.startsWith("file:")
    ? taxonomyIntent.default_output_kind.split(":")[1]
    : taxonomyIntent.default_output_kind === "image:svg"
      ? "svg"
      : taxonomyIntent.default_output_kind);
  const direct = new Set([
    "create_docx", "render_docx_from_outline", "render_docx_from_markdown",
    "create_xlsx", "create_xlsx_dashboard", "create_pptx", "render_pdf_from_html",
    "create_svg", "create_infographic_svg", "create_chart", "scientific_search",
    "doi_validator", "citation_formatter", "source_ranker", "bibliography_generator",
    "web_search", "evidence_grounding", "contradiction_detector", "data_analysis_sandbox",
    "code_project_generator", "create_app_project", "run_frontend_build", "run_tests",
    "artifact_validator", "validate_docx", "validate_xlsx", "validate_pptx", "validate_pdf",
    "validate_svg", "validate_accessibility", "validate_responsive_design",
  ]);
  if (direct.has(name)) return [name];
  if (name === "create_document" || /create_document|renderer|artifact/i.test(name)) return artifactToolsForFormat(fmt, taxonomyIntent);
  if (/verify_artifact|artifact_validator|format/i.test(name)) return ["artifact_validator"];
  if (/research|search|openalex|scielo|scopus|pubmed|crossref|agenticBatch/i.test(name)) return ["scientific_search"];
  if (/doi/i.test(name)) return ["doi_validator"];
  if (/citation|apa/i.test(name)) return ["citation_formatter"];
  if (/docintel\.ground|evidence|ground/i.test(name)) return ["evidence_grounding"];
  if (/contradiction/i.test(name)) return ["contradiction_detector"];
  if (/spreadsheet|semanticModel|bi\./i.test(name)) return ["create_xlsx"];
  if (/sandbox|analysis/i.test(name)) return ["data_analysis_sandbox"];
  if (/test/i.test(name)) return ["run_tests"];
  return [];
}

function artifactToolsForFormat(format, taxonomyIntent) {
  if (format === "docx") {
    const tools = ["create_docx"];
    if (taxonomyIntent.default_required_capabilities.includes("research")) {
      tools.unshift("scientific_search", "doi_validator", "citation_formatter", "evidence_grounding");
    }
    return tools;
  }
  if (format === "xlsx") return ["create_xlsx"];
  if (format === "pptx") return ["create_pptx"];
  if (format === "pdf") return ["render_pdf_from_html"];
  if (format === "svg") return ["create_svg"];
  if (taxonomyIntent.default_output_kind === "code_artifact") return ["create_app_project", "run_tests", "artifact_validator"];
  return ["create_document"];
}

function inferTargetFormatFromDecision(decision, taxonomyIntent, requestIntelligence = null) {
  const tokenFormat = requestIntelligence?.requested_formats?.[0]?.extension;
  if (tokenFormat) return tokenFormat.replace(/^\./, "");
  const finalOutput = String(decision?.final_output || decision?.output_format || "").toLowerCase();
  if (/\b(pdf|pdf_document)\b/.test(finalOutput)) return "pdf";
  if (/\b(docx|word|word_document)\b/.test(finalOutput)) return "docx";
  if (/\b(xlsx|excel|spreadsheet)\b/.test(finalOutput)) return "xlsx";
  if (/\b(pptx|powerpoint|presentation|slide)\b/.test(finalOutput)) return "pptx";
  if (/\b(svg|vector)\b/.test(finalOutput)) return "svg";
  if (taxonomyIntent.default_output_kind === "image:svg") return "svg";
  if (taxonomyIntent.default_output_kind.startsWith("file:")) {
    return taxonomyIntent.default_output_kind.split(":")[1];
  }
  return null;
}

function defaultToolsForIntent(taxonomyIntent, targetFormat = null) {
  const kind = taxonomyIntent.default_output_kind;
  const tools = [];
  if (targetFormat) tools.push(...artifactToolsForFormat(targetFormat, taxonomyIntent));
  else if (kind.startsWith("file:")) tools.push(...artifactToolsForFormat(kind.split(":")[1], taxonomyIntent));
  if (kind === "image:svg") tools.push("create_svg");
  if (taxonomyIntent.id === "infographic") tools.push("create_infographic_svg");
  if (taxonomyIntent.id === "chart_generation") tools.push("create_chart");
  if (taxonomyIntent.default_required_capabilities.includes("research")) {
    tools.push("scientific_search", "doi_validator", "citation_formatter", "evidence_grounding");
  }
  if (taxonomyIntent.default_required_capabilities.includes("code")) tools.push("data_analysis_sandbox");
  if (kind !== "text") tools.push("artifact_validator");
  return tools;
}

function agentForSiraTool(toolName) {
  if (/search|doi|citation|source|evidence|contradiction/i.test(toolName)) return "research_verifier_agent";
  if (/xlsx|spreadsheet|analysis/i.test(toolName)) return "data_analyst_agent";
  if (/docx|pdf|pptx|svg|artifact|chart/i.test(toolName)) return "artifact_agent";
  if (/code|test|build/i.test(toolName)) return "code_agent";
  return "tool_router_agent";
}

function deriveSafety(taxonomyIntent, decision) {
  const risks = [];
  if (taxonomyIntent.default_required_capabilities.includes("research")) {
    risks.push({ category: "external_research", risk: "source_quality_or_hallucinated_citations", mitigation: "validate_sources_and_doi" });
  }
  if (taxonomyIntent.default_required_capabilities.includes("code") || taxonomyIntent.default_required_capabilities.includes("sandbox")) {
    risks.push({ category: "code_execution", risk: "unsafe_generated_code", mitigation: "execute_only_in_sandbox" });
  }
  if (taxonomyIntent.id === "web_scraping") {
    risks.push({ category: "web_automation", risk: "violation_of_terms_of_service", mitigation: "respect_robots_no_captcha_bypass" });
  }
  if (taxonomyIntent.id === "database_query") {
    risks.push({ category: "data_access", risk: "unintended_writes", mitigation: "read_only_default_writes_require_approval" });
  }
  return {
    overall_risk_level: taxonomyIntent.default_risk,
    risk_categories: risks,
    requires_user_confirmation: taxonomyIntent.default_risk === "critical",
    allowed_actions: ["read_uploaded_files", "create_new_artifacts", "call_registered_tools"],
    blocked_actions: ["delete_user_files", "overwrite_original_files", "send_email_without_confirmation", "publish_online_without_confirmation", "make_payments", "access_private_external_accounts_without_permission"],
    privacy: { contains_sensitive_data: "unknown", should_mask_personal_data: true, store_in_memory: "only_summary_if_user_allows" },
  };
}

function deriveQualityPlan(taxonomyIntent, decision, requestIntelligence = null, contextualUnderstanding = null) {
  const validators = [{ name: "intent_fulfillment_validator", checks: ["all_requested_outputs_created", "user_goal_satisfied"] }];
  if (taxonomyIntent.default_required_capabilities.includes("research") || requestIntelligence?.context?.has_research_requirement) {
    validators.push({ name: "source_validator", checks: ["no_fake_references", "doi_or_url_present_when_available", "sources_match_claims", "citation_style_correct"] });
  }
  const valueContext = normalizeContextualValueContext(contextualUnderstanding?.value_context);
  if (valueContext.values.length > 0 || valueContext.constraints.length > 0) {
    validators.push({
      name: "contextual_alignment_validator",
      checks: ["respect_inferred_user_values", "preserve_explicit_constraints", "match_collaboration_mode"],
    });
  }
  if (taxonomyIntent.family === "document_artifacts" || taxonomyIntent.family === "spreadsheet_artifacts" || taxonomyIntent.family === "presentation_artifacts") {
    validators.push({ name: "artifact_validator", checks: ["file_opens_successfully", "format_sovereignty"] });
  }
  if (taxonomyIntent.id === "data_analysis") {
    validators.push({ name: "data_validator", checks: ["charts_match_dataset", "statistics_computed_correctly", "no_unexplained_missing_values"] });
  }
  validators.push({ name: "language_validator", checks: ["formal_when_required", "no_unwanted_language_switching", "grammar_and_style_polished"] });
  return {
    quality_level: taxonomyIntent.family === "document_artifacts" ? "professional_academic" : "professional",
    validators,
    minimum_acceptance_score: 0.88,
    regenerate_if_below_score: true,
  };
}

function deriveUiPlan(plan, taxonomyIntent) {
  const labels = (plan.nodes || []).map(n => humanise(n.id));
  return {
    show_progress_steps: labels.length > 1,
    progress_labels: labels,
    show_tool_activity: "summarized",
    show_intermediate_preview: taxonomyIntent.family !== "conversation",
    final_response_style: taxonomyIntent.family === "conversation" ? "concise_text" : "concise_with_artifact_links",
    artifact_cards: deriveArtifactCards(taxonomyIntent),
  };
}

function deriveArtifactCards(taxonomyIntent) {
  const k = taxonomyIntent.default_output_kind;
  if (k === "text") return [];
  if (k.startsWith("file:")) {
    const fmt = k.split(":")[1];
    return [{ type: "download_card", label: `Documento ${fmt.toUpperCase()}`, format: fmt }];
  }
  if (k === "image" || k.startsWith("image:")) return [{ type: "preview_card", label: "Imagen", format: k.split(":")[1] || "png" }];
  if (k === "video") return [{ type: "preview_card", label: "Video", format: "mp4" }];
  if (k === "code_artifact") return [{ type: "download_card", label: "Proyecto", format: "zip" }, { type: "preview_card", label: "Vista previa", format: "url" }];
  return [];
}

function deriveMemoryPolicy(taxonomyIntent, attachments) {
  return {
    read_memory: true,
    write_memory: true,
    memory_items_to_read: ["preferred_language", "preferred_citation_style", "preferred_document_style", "previous_project_context"],
    memory_items_to_write: [
      { key: "last_intent_family", value: taxonomyIntent.family, confidence: 0.9 },
    ],
    do_not_store: ["raw_sensitive_dataset", "private_identifiers_without_consent"],
  };
}

function deriveCostLatencyPolicy(taxonomyIntent) {
  const isCheap = taxonomyIntent.default_complexity === "low";
  return {
    priority: taxonomyIntent.default_complexity === "very_high" ? "quality_over_speed" : "balanced",
    max_tool_calls: isCheap ? 5 : 25,
    max_research_sources: isCheap ? 0 : 20,
    max_final_sources: isCheap ? 0 : 10,
    prefer_parallel_execution: true,
    expensive_tools_allowed: !isCheap,
    fallback_to_cheaper_tools: false,
  };
}

function deriveMustInclude(taxonomyIntent) {
  const out = ["breve_resumen_de_lo_realizado"];
  if (taxonomyIntent.default_output_kind !== "text") out.push("archivos_generados");
  if (taxonomyIntent.default_required_capabilities.includes("research")) out.push("fuentes_usadas_si_aplica");
  out.push("advertencias_si_existen");
  return out;
}

function deriveClarificationPolicy({
  decision,
  text,
  taxonomyIntent,
  attachments = [],
  contextualUnderstanding = null,
} = {}) {
  const trajectory = normalizeTaskTrajectory(contextualUnderstanding?.value_context?.task_trajectory);
  const baseNeedsClarification = Boolean(decision?.needs_clarification);
  const confidence = clamp01(Number(decision?.confidence || 0));
  const canUseEndToEndAssumptions = trajectory.mode === "end_to_end_execution"
    && trajectory.confidence >= 0.72
    && confidence >= 0.55;
  const criticalMissing = detectCriticalMissingInformation({ text, taxonomyIntent, attachments });

  if (baseNeedsClarification && canUseEndToEndAssumptions && criticalMissing.length === 0) {
    return {
      needs_clarification: false,
      clarification_reason: "contextual_end_to_end_assumptions",
      questions: [],
      auto_assumptions_allowed: true,
      act_without_clarification_if_confidence_above: 0.82,
      ask_user_if_confidence_below: 0.55,
    };
  }

  const needsClarification = baseNeedsClarification || criticalMissing.length > 0;
  return {
    needs_clarification: needsClarification,
    clarification_reason: needsClarification
      ? criticalMissing[0] || "input_under_specified"
      : null,
    questions: needsClarification
      ? deriveClarifyingQuestions(text, taxonomyIntent, criticalMissing)
      : [],
    auto_assumptions_allowed: !needsClarification,
    act_without_clarification_if_confidence_above: 0.82,
    ask_user_if_confidence_below: 0.55,
  };
}

function detectCriticalMissingInformation({ text, taxonomyIntent, attachments = [] } = {}) {
  const current = String(text || "");
  const missing = [];
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  if (/(?:analiza|analizar|procesa|procesar|extrae|leer)\s+(?:el|este|esta)?\s*(archivo|excel|pdf|word|csv|imagen|documento)\b/i.test(current) && !hasAttachments) {
    missing.push("missing_referenced_attachment");
  }
  if (/\b(?:enviar|manda(?:r)?\s+(?:correo|email)|transferir|pagar|cobrar|borrar|eliminar|destruir|publicar\s+(?:en\s+)?(?:twitter|x|linkedin|facebook|instagram))\b/i.test(current)) {
    missing.push("external_or_destructive_action_requires_confirmation");
  }
  if (taxonomyIntent?.id === "database_query" && /\b(update|delete|drop|truncate|insert)\b/i.test(current)) {
    missing.push("database_write_requires_confirmation");
  }
  return missing.slice(0, 3);
}

function deriveClarifyingQuestions(text, taxonomyIntent, criticalMissing = []) {
  const out = [];
  if (criticalMissing.includes("missing_referenced_attachment")) {
    out.push("Sube el archivo o confirma cuál documento debo usar.");
  }
  if (criticalMissing.includes("external_or_destructive_action_requires_confirmation")) {
    out.push("Confirma explícitamente la acción externa o irreversible antes de ejecutarla.");
  }
  if (criticalMissing.includes("database_write_requires_confirmation")) {
    out.push("Confirma la operación de escritura en base de datos y el alcance exacto.");
  }
  if (taxonomyIntent.family === "document_artifacts") out.push("¿Sobre qué tema específico quieres el documento?");
  if (taxonomyIntent.id === "image_generation") out.push("¿Estilo realista, ilustración o 3D?");
  if (taxonomyIntent.id === "video_generation") out.push("¿Cuántos segundos y qué tipo de cámara?");
  if (out.length === 0) out.push("¿Puedes dar más contexto sobre el resultado que esperas?");
  return out.slice(0, 3);
}

// ── Pure helpers ────────────────────────────────────────────────────

function normaliseText(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function detectLanguage(text) {
  const t = String(text).toLowerCase();
  if (/[áéíóúñ¿¡]/.test(t) || /\b(que|para|como|donde|cuando|porque)\b/.test(t)) return "es";
  if (/[äöüß]/.test(t) || /\b(und|nicht|aber|wenn)\b/.test(t)) return "de";
  if (/\b(que|comme|pour|parce|alors)\b/.test(t)) return "fr";
  return "en";
}

function pickInputMode(text, attachments) {
  if (attachments.length > 0 && text.length === 0) return "file_only";
  if (attachments.length > 0 && text.length > 0) return "mixed";
  return "text";
}

function inferTone(text) {
  if (/!/.test(text) && /[A-ZÁÉÍÓÚ]{5,}/.test(text)) return "frustrated";
  if (/por favor|please|could you|podrías/i.test(text)) return "polite_request";
  if (text.length < 30) return "casual";
  return /\?/.test(text) ? "exploratory" : "direct_request";
}

function inferSpellingQuality(text) {
  const errors = (text.match(/\b(dle|qye|hcaer|hsacer|tu sofware|crea m e)\b/gi) || []).length;
  if (errors >= 2) return "very_noisy";
  if (errors >= 1) return "noisy_but_understandable";
  return "clean";
}

function inferDomain(text, taxonomyIntent) {
  if (taxonomyIntent.family === "high_risk_domains") return taxonomyIntent.id;
  if (/medic|salud|paciente/i.test(text)) return "healthcare";
  if (/legal|abogad|contrato|juicio/i.test(text)) return "legal";
  if (/finan|inversi|contab/i.test(text)) return "finance";
  if (/educa|tesis|docente|estudi/i.test(text)) return "academic";
  return "general";
}

function normaliseAttachment(a, idx) {
  const mime = a.mime_type || a.mimeType || "";
  const detected = detectAttachmentType(mime, a.filename || a.name || "");
  return {
    file_id: a.file_id || a.id || `file_${idx + 1}`,
    filename: a.filename || a.name || `attachment_${idx + 1}`,
    mime_type: mime,
    detected_type: detected,
    size_bytes: a.size_bytes || a.size || 0,
    status: "available",
  };
}

function detectAttachmentType(mime, name) {
  const m = (mime || "").toLowerCase();
  const ext = name.split(".").pop().toLowerCase();
  if (m.includes("spreadsheet") || ext === "xlsx" || ext === "xls" || ext === "csv") return "spreadsheet";
  if (m.includes("wordprocessing") || ext === "docx" || ext === "doc") return "document";
  if (m.includes("presentation") || ext === "pptx" || ext === "ppt") return "presentation";
  if (m.includes("pdf") || ext === "pdf") return "pdf";
  if (m.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(ext)) return "image";
  if (m.startsWith("audio/") || ["mp3", "wav", "ogg", "m4a"].includes(ext)) return "audio";
  if (m.startsWith("video/") || ["mp4", "mov", "webm", "mkv"].includes(ext)) return "video";
  if (m.startsWith("text/") || ["txt", "md", "json", "yaml", "yml"].includes(ext)) return "text";
  return "unknown";
}

function extractLinks(text) {
  return (String(text).match(/https?:\/\/\S+/g) || []).slice(0, 20);
}

function humanise(id) {
  return String(id || "").replace(/[._-]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function slug(id) {
  return String(id || "documento").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function clamp01(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function nonNegativeInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function normalizeContextualValueContext(valueContext) {
  const ctx = valueContext && typeof valueContext === "object" ? valueContext : {};
  const values = Array.isArray(ctx.values) ? ctx.values : [];
  const constraints = Array.isArray(ctx.constraints) ? ctx.constraints : [];
  return {
    source: String(ctx.source || "deterministic_contextual_value_mapper"),
    values: values.slice(0, 8).map(value => ({
      id: String(value?.id || ""),
      domain: String(value?.domain || ""),
      label: String(value?.label || ""),
      evidence: String(value?.evidence || ""),
      confidence: clamp01(Number(value?.confidence || 0)),
    })).filter(value => value.id && value.domain && value.label),
    primary_domains: Array.isArray(ctx.primary_domains)
      ? ctx.primary_domains.map(String).filter(Boolean).slice(0, 5)
      : [],
    constraints: constraints.slice(0, 8).map(constraint => ({
      id: String(constraint?.id || ""),
      label: String(constraint?.label || ""),
      evidence: String(constraint?.evidence || ""),
      priority: constraint?.priority === "hard" ? "hard" : "soft",
    })).filter(constraint => constraint.id && constraint.label),
    task_trajectory: normalizeTaskTrajectory(ctx.task_trajectory),
    task_context: String(ctx.task_context || "general"),
    subjectivity: {
      score: clamp01(Number(ctx.subjectivity?.score || 0)),
      label: String(ctx.subjectivity?.label || "objective"),
      signals: Array.isArray(ctx.subjectivity?.signals)
        ? ctx.subjectivity.signals.slice(0, 6).map(signal => ({
          id: String(signal?.id || ""),
          label: String(signal?.label || ""),
        })).filter(signal => signal.id && signal.label)
        : [],
    },
    collaboration_mode: String(ctx.collaboration_mode || "direct_response"),
    response_posture: String(ctx.response_posture || "neutral_acknowledgment"),
    response_type: String(ctx.response_type || ctx.response_posture || "neutral_acknowledgment"),
    confidence: clamp01(Number(ctx.confidence || 0)),
  };
}

function normalizeTaskTrajectory(taskTrajectory) {
  const trajectory = taskTrajectory && typeof taskTrajectory === "object" ? taskTrajectory : {};
  return {
    mode: String(trajectory.mode || "single_turn"),
    objective: trajectory.objective ? String(trajectory.objective).slice(0, 220) : null,
    phases: Array.isArray(trajectory.phases)
      ? trajectory.phases.map(String).filter(Boolean).slice(0, 10)
      : [],
    success_criteria: Array.isArray(trajectory.success_criteria)
      ? trajectory.success_criteria.map(String).filter(Boolean).slice(0, 6)
      : [],
    stop_conditions: Array.isArray(trajectory.stop_conditions)
      ? trajectory.stop_conditions.map(String).filter(Boolean).slice(0, 5)
      : [],
    confidence: clamp01(Number(trajectory.confidence || 0)),
  };
}

function compactContextualValueContext(valueContext) {
  const normalized = normalizeContextualValueContext(valueContext);
  if (normalized.values.length === 0 && normalized.constraints.length === 0) return null;
  return {
    primary_domains: normalized.primary_domains,
    value_ids: normalized.values.map(value => value.id).slice(0, 5),
    constraints: normalized.constraints.map(constraint => constraint.id).slice(0, 5),
    task_context: normalized.task_context,
    subjectivity: normalized.subjectivity.label,
    collaboration_mode: normalized.collaboration_mode,
    response_posture: normalized.response_posture,
    response_type: normalized.response_type,
    task_trajectory_mode: normalized.task_trajectory.mode,
    task_trajectory_phases: normalized.task_trajectory.phases,
    confidence: normalized.confidence,
  };
}

function normalizeContextualUnderstanding(contextualUnderstanding) {
  if (!contextualUnderstanding || typeof contextualUnderstanding !== "object") return null;
  return {
    applied: Boolean(contextualUnderstanding.applied),
    original_text: String(contextualUnderstanding.original_text || ""),
    effective_text: String(contextualUnderstanding.effective_text || ""),
    recent_turn_count: Number.isFinite(contextualUnderstanding.recent_turn_count)
      ? contextualUnderstanding.recent_turn_count
      : 0,
    coreference: contextualUnderstanding.coreference && typeof contextualUnderstanding.coreference === "object"
      ? contextualUnderstanding.coreference
      : { source: "not_run", latency_ms: 0, references: [] },
    lexicon_terms: Array.isArray(contextualUnderstanding.lexicon_terms)
      ? contextualUnderstanding.lexicon_terms
      : [],
    repair: contextualUnderstanding.repair && typeof contextualUnderstanding.repair === "object"
      ? contextualUnderstanding.repair
      : { is_repair: false, repair_type: null, contract_override: null },
    misunderstanding_signals: Array.isArray(contextualUnderstanding.misunderstanding_signals)
      ? contextualUnderstanding.misunderstanding_signals.map(String).slice(0, 10)
      : [],
    context_memory: normalizeContextMemory(contextualUnderstanding.context_memory),
    value_context: normalizeContextualValueContext(contextualUnderstanding.value_context),
    goal_understanding: normalizeGoalUnderstanding(contextualUnderstanding.goal_understanding),
    attribution_graph_context: normalizeAttributionGraphContext(contextualUnderstanding.attribution_graph_context),
  };
}

function compactContextualUnderstanding(contextualUnderstanding) {
  const normalized = normalizeContextualUnderstanding(contextualUnderstanding);
  if (!normalized) return null;
  return {
    applied: normalized.applied,
    coreference_source: normalized.coreference?.source || null,
    lexicon_term_count: normalized.lexicon_terms.length,
    is_repair: Boolean(normalized.repair?.is_repair),
    repair_type: normalized.repair?.repair_type || null,
    signal_count: normalized.misunderstanding_signals.length,
    primary_value_domains: normalized.value_context.primary_domains,
    task_context: normalized.value_context.task_context,
    subjectivity: normalized.value_context.subjectivity.label,
    collaboration_mode: normalized.value_context.collaboration_mode,
    response_posture: normalized.value_context.response_posture,
    response_type: normalized.value_context.response_type,
    constraint_count: normalized.value_context.constraints.length,
    semantic_memory_count: normalized.context_memory.counts.semantic,
    project_memory_count: normalized.context_memory.counts.project,
    project_context_docs: normalized.context_memory.counts.project_docs,
    goal_understanding_confidence: normalized.goal_understanding.confidence,
    desired_outcome: normalized.goal_understanding.desired_outcome,
    proactive_next_steps: normalized.goal_understanding.proactive_next_steps,
    attribution_graph_confidence: normalized.attribution_graph_context.confidence,
    attribution_hypothesis: normalized.attribution_graph_context.hypothesis,
    attribution_critical_paths: normalized.attribution_graph_context.critical_paths,
  };
}

function normalizeContextMemory(contextMemory) {
  const ctx = contextMemory && typeof contextMemory === "object" ? contextMemory : {};
  const semantic = normalizeContextMemoryItems(ctx.semantic);
  const project = normalizeContextMemoryItems(ctx.project);
  const projectContext = normalizeProjectMemoryContext(ctx.project_context);
  const counts = ctx.counts && typeof ctx.counts === "object" ? ctx.counts : {};
  return {
    source: String(ctx.source || "deterministic_context_memory"),
    semantic,
    project,
    project_context: projectContext,
    counts: {
      semantic: nonNegativeInt(counts.semantic ?? semantic.length),
      project: nonNegativeInt(counts.project ?? project.length),
      project_docs: nonNegativeInt(counts.project_docs ?? projectContext?.docs?.length ?? 0),
      recent_conversations: nonNegativeInt(counts.recent_conversations ?? projectContext?.recent_conversations?.length ?? 0),
    },
    confidence: clamp01(Number(ctx.confidence || 0)),
  };
}

function normalizeContextMemoryItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 5).map((item) => ({
    id: item?.id ? String(item.id).slice(0, 120) : null,
    text: String(item?.text || "").slice(0, 360),
    score: item?.score == null ? null : clamp01(Number(item.score)),
    importance: item?.importance == null ? null : clamp01(Number(item.importance)),
  })).filter((item) => item.text.length > 0);
}

function normalizeProjectMemoryContext(projectContext) {
  if (!projectContext || typeof projectContext !== "object") return null;
  return {
    project_id: projectContext.project_id ? String(projectContext.project_id).slice(0, 120) : null,
    member_role: projectContext.member_role ? String(projectContext.member_role).slice(0, 80) : null,
    capabilities: Array.isArray(projectContext.capabilities)
      ? projectContext.capabilities.map(String).filter(Boolean).slice(0, 10)
      : [],
    instructions: projectContext.instructions ? String(projectContext.instructions).slice(0, 600) : null,
    docs: Array.isArray(projectContext.docs)
      ? projectContext.docs.slice(0, 5).map((doc) => ({
        id: doc?.id ? String(doc.id).slice(0, 120) : null,
        title: doc?.title ? String(doc.title).slice(0, 180) : null,
        summary: doc?.summary ? String(doc.summary).slice(0, 220) : null,
        type: doc?.type ? String(doc.type).slice(0, 80) : null,
      })).filter((doc) => doc.id || doc.title || doc.summary || doc.type)
      : [],
    recent_conversations: Array.isArray(projectContext.recent_conversations)
      ? projectContext.recent_conversations.slice(0, 4).map((conv) => ({
        id: conv?.id ? String(conv.id).slice(0, 120) : null,
        title: conv?.title ? String(conv.title).slice(0, 180) : null,
      })).filter((conv) => conv.id || conv.title)
      : [],
  };
}

function normalizeAttributionGraphContext(graph) {
  const ctx = graph && typeof graph === "object" ? graph : {};
  return {
    source: String(ctx.source || "deterministic_attribution_graph_context"),
    hypothesis: ctx.hypothesis ? String(ctx.hypothesis).slice(0, 300) : null,
    supernodes: Array.isArray(ctx.supernodes)
      ? ctx.supernodes.slice(0, 10).map((node) => ({
        id: String(node?.id || ""),
        label: String(node?.label || "").slice(0, 90),
        evidence: String(node?.evidence || "").slice(0, 160),
        confidence: clamp01(Number(node?.confidence || 0)),
        kind: String(node?.kind || "feature"),
      })).filter((node) => node.id && node.label)
      : [],
    edges: Array.isArray(ctx.edges)
      ? ctx.edges.slice(0, 12).map((edge) => ({
        from: String(edge?.from || ""),
        to: String(edge?.to || ""),
        relation: String(edge?.relation || "").slice(0, 120),
        weight: clamp01(Number(edge?.weight || 0)),
      })).filter((edge) => edge.from && edge.to)
      : [],
    critical_paths: Array.isArray(ctx.critical_paths)
      ? ctx.critical_paths.map(String).filter(Boolean).slice(0, 5)
      : [],
    uncertainty: Array.isArray(ctx.uncertainty)
      ? ctx.uncertainty.map(String).filter(Boolean).slice(0, 5)
      : [],
    confidence: clamp01(Number(ctx.confidence || 0)),
  };
}

function normalizeGoalUnderstanding(goalUnderstanding) {
  const goal = goalUnderstanding && typeof goalUnderstanding === "object" ? goalUnderstanding : {};
  return {
    source: String(goal.source || "deterministic_goal_understanding"),
    explicit_request: goal.explicit_request ? String(goal.explicit_request).slice(0, 240) : null,
    inferred_user_goal: goal.inferred_user_goal ? String(goal.inferred_user_goal).slice(0, 360) : null,
    desired_outcome: goal.desired_outcome ? String(goal.desired_outcome).slice(0, 120) : null,
    continuity_anchors: Array.isArray(goal.continuity_anchors)
      ? goal.continuity_anchors.map(String).filter(Boolean).slice(0, 8)
      : [],
    missing_context: Array.isArray(goal.missing_context)
      ? goal.missing_context.map(String).filter(Boolean).slice(0, 5)
      : [],
    proactive_next_steps: Array.isArray(goal.proactive_next_steps)
      ? goal.proactive_next_steps.map(String).filter(Boolean).slice(0, 8)
      : [],
    confidence: clamp01(Number(goal.confidence || 0)),
  };
}

module.exports = {
  buildEnvelope,
  SIRA_EXECUTION_LAW,
  // exposed for tests
  mapRouterIntentToTaxonomy,
  deriveOutputContract,
  deriveSafety,
  deriveQualityPlan,
  normalizeContextualUnderstanding,
  normalizeContextualValueContext,
  normalizeContextMemory,
  normalizeGoalUnderstanding,
  normalizeAttributionGraphContext,
  compactContextualUnderstanding,
  compactContextualValueContext,
};

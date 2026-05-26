/**
 * semantic-intent-router — LLM-primary + regex-fallback hybrid
 * intent comprehension layer for the AI Product OS.
 *
 * The platform stops thinking like:
 *
 *   if (msg.includes("word")) createDocument()
 *
 * and starts thinking like:
 *
 *   {
 *     intent_primary: "complex_academic_document_generation",
 *     intent_secondary: ["scientific_research", "doi_validation",
 *                        "apa7_citation", "docx_export"],
 *     required_agents:  ["planner", "research-verifier",
 *                        "document-analyst", "frontend-engineer", ...],
 *     required_tools:   ["read_excel", "web_search", "doi_checker",
 *                        "rag_retriever", "docx_generator"],
 *     confidence:       0.96,
 *     needs_clarification: false,
 *     final_output:     "word_document"
 *   }
 *
 * Tiers, in order:
 *   T1 — LLM with structured outputs (OpenAI Responses /
 *        Chat Completions JSON schema mode). Caller injects the
 *        client; if absent we skip to T2.
 *   T2 — Regex fast-path (the existing classifyIntentFastPath logic
 *        re-encoded server-side so we don't depend on the frontend).
 *   T3 — Deterministic deduce: pick "text" with low confidence and
 *        suggest needs_clarification when the prompt is too short or
 *        too generic to be acted on.
 *
 * Pure JS, deterministic when seeded, zero compulsory deps. Tests
 * stub the LLM client.
 */

const { listAgents, AGENTS_BY_ID } = require("./agentic-kernel");

const PRIMARY_INTENTS = Object.freeze([
  "text_answer",
  "research_question",
  "complex_academic_document_generation",
  "spreadsheet_generation",
  "presentation_generation",
  "pdf_report_generation",
  "image_generation",
  "video_generation",
  "code_generation",
  "web_app_build",
  "data_analysis",
  "database_query",
  "web_scraping",
  "design_system",
  "email_send",
  "calendar_action",
  "drive_action",
  "math_solving",
  "viz_generation",
  "agent_long_running_task",
  "small_talk",
  "unknown",
]);

const FINAL_OUTPUT_BY_INTENT = Object.freeze({
  text_answer: "text",
  research_question: "text_with_citations",
  complex_academic_document_generation: "word_document",
  spreadsheet_generation: "xlsx_document",
  presentation_generation: "pptx_document",
  pdf_report_generation: "pdf_document",
  image_generation: "image",
  video_generation: "video",
  code_generation: "code_artifact",
  web_app_build: "web_app",
  data_analysis: "analysis_report",
  database_query: "query_result",
  web_scraping: "scraped_corpus",
  design_system: "design_tokens",
  email_send: "email_action",
  calendar_action: "calendar_action",
  drive_action: "drive_action",
  math_solving: "math_solution",
  viz_generation: "chart",
  agent_long_running_task: "multi_artifact_bundle",
  small_talk: "text",
  unknown: "text",
});

const AGENT_BUNDLE_BY_INTENT = Object.freeze({
  research_question:                       ["intent-compiler", "planner", "research-verifier", "document-analyst", "qa-regression", "telemetry"],
  complex_academic_document_generation:    ["intent-compiler", "constraint-extractor", "planner", "research-verifier", "document-analyst", "code-architect", "frontend-engineer", "qa-regression", "release-manager", "telemetry"],
  spreadsheet_generation:                  ["intent-compiler", "constraint-extractor", "planner", "bi-analyst", "qa-regression", "release-manager", "telemetry"],
  presentation_generation:                 ["intent-compiler", "constraint-extractor", "planner", "design-director", "qa-regression", "release-manager", "telemetry"],
  pdf_report_generation:                   ["intent-compiler", "constraint-extractor", "planner", "research-verifier", "document-analyst", "qa-regression", "release-manager", "telemetry"],
  code_generation:                         ["intent-compiler", "code-architect", "frontend-engineer", "backend-engineer", "security-reviewer", "qa-regression", "telemetry"],
  web_app_build:                           ["intent-compiler", "constraint-extractor", "planner", "code-architect", "design-director", "frontend-engineer", "backend-engineer", "security-reviewer", "qa-regression", "release-manager", "telemetry"],
  data_analysis:                           ["intent-compiler", "planner", "database", "bi-analyst", "qa-regression", "telemetry"],
  database_query:                          ["intent-compiler", "database", "qa-regression", "telemetry"],
  web_scraping:                            ["intent-compiler", "planner", "scraping", "document-analyst", "qa-regression", "telemetry"],
  design_system:                           ["intent-compiler", "design-director", "qa-regression", "telemetry"],
  agent_long_running_task:                 ["intent-compiler", "constraint-extractor", "planner", "tool-router", "qa-regression", "release-manager", "telemetry"],
  text_answer:                             ["intent-compiler"],
  small_talk:                              ["intent-compiler"],
  unknown:                                 ["intent-compiler"],
});

const TOOL_BUNDLE_BY_INTENT = Object.freeze({
  research_question:                       ["research.agenticBatch", "docintel.ground", "self_rag.answer"],
  complex_academic_document_generation:    ["research.agenticBatch", "docintel.analyze", "docintel.ground", "create_document", "verify_artifact"],
  spreadsheet_generation:                  ["bi.semanticModel.compile", "create_document", "verify_artifact"],
  presentation_generation:                 ["create_document", "verify_artifact"],
  pdf_report_generation:                   ["docintel.analyze", "create_document", "verify_artifact"],
  code_generation:                         ["scaffolder.preview", "code-review.analyze", "sbom.generate"],
  web_app_build:                           ["scaffolder.nextjs", "scaffolder.fastapi", "code-review.analyze", "sbom.generate", "dependency-audit.run", "seo.validate", "wcag.check", "cwv.analyze"],
  data_analysis:                           ["sql.safety.analyze", "bi.semanticModel.compile", "bi.market.framework"],
  database_query:                          ["sql.safety.analyze"],
  web_scraping:                            ["web.url.canonical", "web.robots.parse", "web.scraper.policy", "web.rate.limit", "web.html.extract"],
  design_system:                           ["design.tokens.build", "wcag.contrast.check"],
  image_generation:                        ["image.generate"],
  viz_generation:                          ["chart.render"],
  text_answer:                             [],
  small_talk:                              [],
  unknown:                                 [],
});

/**
 * @typedef {{
 *   intent_primary: string,
 *   intent_secondary: string[],
 *   required_agents: string[],
 *   required_tools: string[],
 *   confidence: number,
 *   needs_clarification: boolean,
 *   final_output: string,
 *   tier: "llm"|"regex"|"deterministic",
 *   trace: object,
 * }} RouterDecision
 */

/**
 * Build the LLM call contract: a JSON schema the model MUST emit so
 * downstream code never has to "fix up" the response.
 */
function buildClassifierSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "intent_primary", "intent_secondary", "required_agents",
      "required_tools", "confidence", "needs_clarification", "final_output",
    ],
    properties: {
      intent_primary: { type: "string", enum: [...PRIMARY_INTENTS] },
      intent_secondary: { type: "array", items: { type: "string" }, maxItems: 8 },
      required_agents: { type: "array", items: { type: "string" }, maxItems: 12 },
      required_tools: { type: "array", items: { type: "string" }, maxItems: 12 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      needs_clarification: { type: "boolean" },
      final_output: { type: "string" },
    },
  };
}

const SYSTEM_PROMPT = [
  "You are the SemanticIntentRouter for the AI Product Operating System.",
  "Read the user's last turn (and short prior context). Output a SINGLE JSON object that matches the provided schema EXACTLY — no prose.",
  "",
  "Rules:",
  "1. intent_primary MUST be one of the enum values.",
  "2. intent_secondary lists ≤ 8 fine-grained sub-intents (free text snake_case).",
  "3. required_agents lists ≤ 12 agent ids drawn from the agentic-kernel registry (you receive that list).",
  "4. required_tools lists ≤ 12 tool ids drawn from the tool registry (you receive that list).",
  "5. confidence is your real estimate in [0,1] — do NOT default to 1.0.",
  "6. needs_clarification = true ONLY when the request is ambiguous, missing required inputs (e.g. file/data), or under-specified.",
  "7. final_output is the concrete deliverable kind ('word_document', 'text', 'pdf_document', 'web_app', 'image', 'chart', etc.).",
  "8. NEVER invent tools or agents that are not in the supplied registries — choose the closest valid id.",
  "9. If the prompt is a question about an already-uploaded document, intent_primary is 'text_answer' or 'research_question', NOT a generation intent.",
].join("\n");

/**
 * Classify a user prompt and produce a RouterDecision.
 *
 * @param {object} args
 * @param {string} args.prompt
 * @param {Array<{role:string,content:string}>} [args.history]
 * @param {object} [args.context] — has_attachments, attachment_kinds, etc.
 * @param {object} [args.llmClient] — { classify({system,user,schema}) → object }
 * @param {boolean} [args.preferRegex=false] — force fast-path
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<RouterDecision>}
 */
async function classifyIntent({
  prompt,
  history = [],
  context = {},
  llmClient = null,
  preferRegex = false,
  signal = null,
} = {}) {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return deterministicDecision({ reason: "empty_prompt" });
  }

  if (!preferRegex && llmClient && typeof llmClient.classify === "function") {
    try {
      const raw = await llmClient.classify({
        system: SYSTEM_PROMPT,
        user: buildLlmUserPayload(prompt, history, context),
        schema: buildClassifierSchema(),
        signal,
      });
      const sanitized = sanitizeLlmDecision(raw, { prompt, context });
      if (sanitized) {
        return { ...sanitized, tier: "llm", trace: { source: "llm" } };
      }
    } catch (err) {
      // fall through to regex
      const fallback = regexDecision(prompt, context);
      fallback.trace.llm_error = err && err.message ? err.message : "unknown_llm_error";
      return fallback;
    }
  }

  return regexDecision(prompt, context);
}

function buildLlmUserPayload(prompt, history, context) {
  const trimmedHistory = (history || [])
    .slice(-6)
    .map(h => `${(h.role || "user").toUpperCase()}: ${truncate(String(h.content || ""), 240)}`)
    .join("\n");
  const ctxLines = [];
  if (context.has_attachments) ctxLines.push(`attachments: ${(context.attachment_kinds || []).join(", ") || "yes"}`);
  if (context.locale) ctxLines.push(`locale: ${context.locale}`);
  if (context.user_role) ctxLines.push(`user_role: ${context.user_role}`);
  return [
    "USER_PROMPT:",
    truncate(prompt, 4000),
    "",
    "RECENT_CONTEXT:",
    trimmedHistory || "(none)",
    "",
    "EXTRA_CONTEXT:",
    ctxLines.join("\n") || "(none)",
    "",
    `KNOWN_AGENTS: ${listAgents().map(a => a.id).join(", ")}`,
  ].join("\n");
}

/**
 * Sanitise a raw LLM decision — coerce types, drop unknown agents/tools,
 * clamp confidence, and refuse if the primary intent is not in the enum.
 */
function sanitizeLlmDecision(raw, { prompt, context } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const primary = String(raw.intent_primary || "").trim();
  if (!PRIMARY_INTENTS.includes(primary)) return null;

  const secondary = Array.isArray(raw.intent_secondary)
    ? raw.intent_secondary.filter(s => typeof s === "string" && s.length > 0).slice(0, 8)
    : [];

  const agentIds = Array.isArray(raw.required_agents)
    ? raw.required_agents.filter(a => typeof a === "string" && AGENTS_BY_ID[a]).slice(0, 12)
    : [];
  const tools = Array.isArray(raw.required_tools)
    ? raw.required_tools.filter(t => typeof t === "string" && t.length > 0).slice(0, 12)
    : [];
  const confidence = clamp01(Number(raw.confidence));
  const needsClarification = Boolean(raw.needs_clarification);
  const finalOutput = typeof raw.final_output === "string" && raw.final_output.length > 0
    ? raw.final_output
    : (FINAL_OUTPUT_BY_INTENT[primary] || "text");

  // If model returned no agents but we have a sensible default for this
  // intent, fill from the bundle (model never violates the registry).
  const agents = agentIds.length > 0 ? agentIds : (AGENT_BUNDLE_BY_INTENT[primary] || ["intent-compiler"]);
  const toolList = tools.length > 0 ? tools : (TOOL_BUNDLE_BY_INTENT[primary] || []);

  // Force needs_clarification ON when the prompt is so short the model
  // can't have understood it (e.g. "ok", "...", single emoji), regardless
  // of what the model said.
  const adjustedNeedsClarification = needsClarification || isUnderSpecified(prompt, context);

  return {
    intent_primary: primary,
    intent_secondary: secondary,
    required_agents: agents,
    required_tools: toolList,
    confidence: confidence,
    needs_clarification: adjustedNeedsClarification,
    final_output: finalOutput,
  };
}

function deterministicDecision({ reason } = {}) {
  return {
    intent_primary: "unknown",
    intent_secondary: [],
    required_agents: ["intent-compiler"],
    required_tools: [],
    confidence: 0,
    needs_clarification: true,
    final_output: "text",
    tier: "deterministic",
    trace: { reason: reason || "unknown" },
  };
}

/**
 * Deterministic regex fast-path — the existing fallback.
 *
 * This is strictly weaker than the LLM tier: it can only match the
 * loud, common cases. Output is shaped the same way so the caller
 * downstream doesn't branch on tier.
 */
function regexDecision(prompt, context = {}) {
  const lc = normalize(prompt);
  let primary = "text_answer";
  const secondary = [];
  let confidence = 0.55;

  // ── Core routing patterns ────────────────────────────────────────
  if (/\b(gmail|correo|email|enviar?\s+(un\s+)?correo|inbox|bandeja)\b/i.test(lc)) {
    primary = "email_send"; confidence = 0.78;
  } else if (/\b(calendario|calendar|reuniones?|eventos?)\b/i.test(lc)) {
    primary = "calendar_action"; confidence = 0.72;
  } else if (/\b(drive|google\s*drive|mis\s+archivos)\b/i.test(lc)) {
    primary = "drive_action"; confidence = 0.7;
  } else if (matchesGenerationVerbAndDocNoun(lc)) {
    const out = inferDocOutput(lc);
    primary = out.intent;
    secondary.push(...out.secondary);
    confidence = 0.82;
  } else if (matchesResearchAsk(lc)) {
    primary = "research_question";
    secondary.push("citation_grounding", "multi_provider_search");
    confidence = 0.78;
  } else if (matchesCodeAsk(lc)) {
    primary = "code_generation"; confidence = 0.75;
  } else if (matchesWebAppAsk(lc)) {
    primary = "web_app_build"; confidence = 0.78;
  } else if (matchesImageAsk(lc)) {
    primary = "image_generation"; confidence = 0.78;
  } else if (matchesVideoAsk(lc)) {
    primary = "video_generation"; confidence = 0.74;
  } else if (matchesVizAsk(lc)) {
    primary = "viz_generation"; confidence = 0.74;
  } else if (matchesMathAsk(lc)) {
    primary = "math_solving"; confidence = 0.72;
  } else if (matchesScraperAsk(lc)) {
    primary = "web_scraping"; confidence = 0.7;
  } else if (matchesDbAsk(lc)) {
    primary = "database_query"; confidence = 0.72;
  } else if (matchesLongRunning(lc)) {
    primary = "agent_long_running_task"; confidence = 0.74;
  } else if (matchesSmallTalk(lc)) {
    primary = "small_talk"; confidence = 0.6;
  } else {
    primary = "text_answer"; confidence = 0.55;
  }

  // If the user has an attachment open and didn't explicitly say
  // "generate a NEW", they almost always want an answer about it.
  if (context.has_attachments && (primary === "text_answer" || primary === "research_question")) {
    secondary.push("answer_against_attachment");
    confidence = Math.max(confidence, 0.78);
  }

  return {
    intent_primary: primary,
    intent_secondary: secondary,
    required_agents: AGENT_BUNDLE_BY_INTENT[primary] || ["intent-compiler"],
    required_tools: TOOL_BUNDLE_BY_INTENT[primary] || [],
    confidence,
    needs_clarification: isUnderSpecified(prompt, context),
    final_output: FINAL_OUTPUT_BY_INTENT[primary] || "text",
    tier: "regex",
    trace: { source: "regex" },
  };
}

// ── Regex sub-matchers (focused, conservative) ───────────────────────

function matchesGenerationVerbAndDocNoun(lc) {
  return /\b(?:descargar?|genera(?:r|me)?|crea(?:me|r)?|exporta(?:r|me)?|haz(?:me)?|envia(?:me)?|elabora(?:me|r)?|redacta(?:me|r)?|prepara(?:me|r)?|arma(?:me)?|construye(?:me)?|necesito|quiero|dame)\s+(?:un[oa]?\s+|el\s+|la\s+|los\s+|las\s+)?(?:nuev[oa]\s+)?(?:documento|archivo|informe|reporte|tesis|monograf[ií]a|ensayo|memoria|presentaci[oó]n|hoja\s+de\s+c[aá]lculo|spreadsheet|ppt|pptx?|docx?|word|excel|powerpoint|pdf|xlsx)\b/i.test(lc);
}

function inferDocOutput(lc) {
  if (/\b(pptx?|powerpoint|presentaci[oó]n|slides|diapositivas)\b/i.test(lc)) {
    return { intent: "presentation_generation", secondary: ["slide_layout"] };
  }
  if (/\b(xlsx|excel|hoja\s+de\s+c[aá]lculo|spreadsheet|tabla\s+de\s+datos)\b/i.test(lc)) {
    return { intent: "spreadsheet_generation", secondary: ["tabular_data"] };
  }
  if (/\b(pdf|reporte|informe(?!\s+apa))\b/i.test(lc) && !/\b(word|docx?)\b/i.test(lc)) {
    return { intent: "pdf_report_generation", secondary: [] };
  }
  if (/\b(tesis|apa\s*7|apa\s+septima|monograf[ií]a|ensayo|memoria|art[ií]culo\s+cient[ií]fico)\b/i.test(lc)) {
    return { intent: "complex_academic_document_generation", secondary: ["scientific_research", "apa7_citation", "docx_export"] };
  }
  if (/\b(word|docx?)\b/i.test(lc)) {
    return { intent: "complex_academic_document_generation", secondary: ["docx_export"] };
  }
  return { intent: "complex_academic_document_generation", secondary: [] };
}

function matchesResearchAsk(lc) {
  return /\b(busca(?:r|me)?|investiga(?:r|me)?|encuentra(?:me)?|paper|art[ií]culos?|fuentes?|citas?|referencias?|cita\s+apa|citar\s+apa|noticias?|web\s*search|search|scopus|openalex|crossref|pubmed|doaj|scielo|semantic\s*scholar|qui[eé]n\s+es|qu[eé]\s+es|c[oó]mo\s+funciona|cu[aá]ndo\s+ocurri[oó])\b/i.test(lc);
}

function matchesCodeAsk(lc) {
  return /\b(c[oó]digo|code|programa|script|funci[oó]n|class|debug|bug|error|stack\s*trace|implementa(?:r|me)?|refactor)\b/i.test(lc) && !/\b(palabra|texto|cuento|historia)\b/i.test(lc);
}

function matchesWebAppAsk(lc) {
  return /\b(crea(?:r|me)?|build|construye|implementa(?:r)?|genera(?:r)?|haz(?:me)?)\b.*\b(web|website|webpage|p[aá]gina\s+web|sitio\s+web|landing|portfolio|tienda\s+online|ecommerce|next\.?js|app\s+web|SaaS)\b/i.test(lc);
}

function matchesImageAsk(lc) {
  return /\b(genera(?:r|me)?|crea(?:r|me)?|haz(?:me)?|disena(?:r|me)?|diseña(?:r|me)?|p[oó]ntame|dibuja(?:me)?)\s+(?:una?\s+)?(?:imagen|foto|ilustraci[oó]n|render|wallpaper|logo)/i.test(lc);
}

function matchesVideoAsk(lc) {
  return /\b(genera(?:r|me)?|crea(?:r|me)?|haz(?:me)?)\s+(?:un\s+)?(?:video|clip|animaci[oó]n)/i.test(lc) || /\b(veo\s*3|sora)\b/i.test(lc);
}

function matchesVizAsk(lc) {
  return /\b(grafic[ao]s?|graficas?|plot|histogram(?:a|as)?|pareto|ishikawa|fishbone|box[- ]?plot|diagrama\s+de\s+caja|scatter|dispersion|gantt|sankey|treemap|heatmap|mapa\s+de\s+calor|chart\.?js|d3|plotly|recharts|mermaid)\b/i.test(lc);
}

function matchesMathAsk(lc) {
  return /\b(integral|derivada|d\/dx|ecuaci[oó]n|cronbach|alpha\s+de\s+cronbach|matriz\s+(inversa|transpuesta|determinante)|regresi[oó]n|chi[- ]?cuadrado|anova|t[- ]?test|p[- ]?valor|varianza|desviaci[oó]n\s+(estandar|t[ií]pica)|sistema\s+de\s+ecuaciones|factorizar|simplifica)\b/i.test(lc);
}

function matchesScraperAsk(lc) {
  return /\b(scrap(?:e|ea|ear|eando|earon|aste|amos|ing)|crawl(?:ear)?|extra(?:e|er)\s+(?:datos|info|precios)\s+de\s+(?:la\s+)?web|navegar?\s+(?:la\s+)?web)\b/i.test(lc);
}

function matchesSmallTalk(lc) {
  const words = lc.split(/\s+/).filter(Boolean);
  if (words.length > 6) return false;
  return /^(hola|hi|hey|buen[oa]s|gracias|ok|listo|adi[oó]s|chao|saludos)\b/.test(lc);
}

function matchesDbAsk(lc) {
  return /\b(consulta\s+(?:la\s+)?base\s+de\s+datos|sql|select\s+\*|join\s+on|prepared\s+statement|esquema\s+(?:de\s+)?la\s+(?:base|db)|introspect(?:a|ar)?\s+(?:el\s+)?schema|postgres|mysql|sqlite)\b/i.test(lc);
}

function matchesLongRunning(lc) {
  return /\b(2\s+horas|dos\s+horas|30\s+minutos|60\s+minutos|una\s+hora|sin\s+detenerse|sin\s+parar|persistente|background|mientras\s+salgo|aunque\s+cierre|auto.?corrige|aut[oó]nom[oa]|self.?check|self.?supervision)\b/i.test(lc);
}

// ── Helpers ──────────────────────────────────────────────────────────

function isUnderSpecified(prompt, context = {}) {
  const trimmed = String(prompt || "").trim();
  if (trimmed.length < 6) return true;
  const tokenCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (tokenCount < 3 && !context.has_attachments) return true;
  if (/^(que|qu[eé]|c[oó]mo|por\s+qu[eé]|cu[aá]ndo|d[oó]nde)\??$/i.test(trimmed)) return true;
  return false;
}

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function truncate(s, n) {
  const str = String(s);
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

function normalize(text) {
  return String(text || "")
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

module.exports = {
  classifyIntent,
  buildClassifierSchema,
  sanitizeLlmDecision,
  regexDecision,
  PRIMARY_INTENTS,
  AGENT_BUNDLE_BY_INTENT,
  TOOL_BUNDLE_BY_INTENT,
  FINAL_OUTPUT_BY_INTENT,
  SYSTEM_PROMPT,
};

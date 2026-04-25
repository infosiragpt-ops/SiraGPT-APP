/**
 * intent-taxonomy — Cira's universal intent taxonomy.
 *
 * 14 task families × ~85 intents. Built so the platform can route ANY
 * user request without inventing one-off categories.
 *
 * Every intent carries:
 *   - id, family, label
 *   - default_output_kind        ("text" | "file:docx" | "image" | …)
 *   - default_complexity          ("low" | "medium" | "high" | "very_high")
 *   - default_risk                ("low" | "medium" | "high" | "critical")
 *   - default_min_plan            ("FREE" | "PRO" | "ENTERPRISE")
 *   - default_required_capabilities (subset of {reasoning, code, tools,
 *                                  vision, long_context, audio, video,
 *                                  research, sandbox, browser})
 *
 * Pure JS, deterministic, zero deps.
 */

const FAMILIES = Object.freeze([
  "conversation",
  "document_artifacts",
  "spreadsheet_artifacts",
  "presentation_artifacts",
  "coding",
  "design_visual",
  "image",
  "video",
  "audio",
  "research",
  "data",
  "automation",
  "business",
  "education",
  "high_risk_domains",
]);

const INTENTS = [
  // ── Conversation ──────────────────────────────────────────────────
  ["general_question",     "conversation", "Pregunta general",                "text",        "low",       "low",      "FREE", ["reasoning"]],
  ["explanation",          "conversation", "Explicación",                     "text",        "low",       "low",      "FREE", ["reasoning"]],
  ["translation",          "conversation", "Traducción",                      "text",        "low",       "low",      "FREE", ["reasoning"]],
  ["summarization",        "conversation", "Resumen",                         "text",        "medium",    "low",      "FREE", ["reasoning", "long_context"]],
  ["brainstorming",        "conversation", "Lluvia de ideas",                 "text",        "low",       "low",      "FREE", ["reasoning"]],
  ["comparison",           "conversation", "Comparación",                     "text",        "medium",    "low",      "FREE", ["reasoning"]],
  ["recommendation",       "conversation", "Recomendación",                   "text",        "low",       "low",      "FREE", ["reasoning"]],
  ["small_talk",           "conversation", "Charla casual",                   "text",        "low",       "low",      "FREE", []],

  // ── Document artefacts ────────────────────────────────────────────
  ["docx_generation",         "document_artifacts", "Generación Word",          "file:docx", "medium",  "low",   "FREE", ["tools"]],
  ["pdf_generation",          "document_artifacts", "Generación PDF",           "file:pdf",  "medium",  "low",   "FREE", ["tools"]],
  ["report_generation",       "document_artifacts", "Reporte",                  "file:docx", "medium",  "low",   "FREE", ["reasoning", "tools"]],
  ["academic_document",       "document_artifacts", "Documento académico",      "file:docx", "high",    "medium","FREE", ["reasoning", "tools", "research"]],
  ["legal_document",          "document_artifacts", "Documento legal",          "file:docx", "high",    "high",  "PRO",  ["reasoning", "tools", "research"]],
  ["business_proposal",       "document_artifacts", "Propuesta comercial",      "file:docx", "high",    "medium","FREE", ["reasoning", "tools"]],
  ["cv_resume",               "document_artifacts", "CV / hoja de vida",        "file:docx", "low",     "low",   "FREE", ["tools"]],
  ["contract_draft",          "document_artifacts", "Borrador de contrato",     "file:docx", "high",    "high",  "PRO",  ["reasoning", "tools"]],
  ["letter_or_email",         "document_artifacts", "Carta / correo",           "file:docx", "low",     "low",   "FREE", ["tools"]],
  ["form_generation",         "document_artifacts", "Formulario",               "file:docx", "low",     "low",   "FREE", ["tools"]],

  // ── Spreadsheet artefacts ─────────────────────────────────────────
  ["xlsx_generation",         "spreadsheet_artifacts", "Generación Excel",       "file:xlsx", "medium",  "low",   "FREE", ["tools"]],
  ["spreadsheet_analysis",    "spreadsheet_artifacts", "Análisis de Excel",      "file:xlsx", "high",    "medium","FREE", ["reasoning", "tools", "code"]],
  ["financial_model",         "spreadsheet_artifacts", "Modelo financiero",      "file:xlsx", "high",    "medium","PRO",  ["reasoning", "tools", "code"]],
  ["budget_template",         "spreadsheet_artifacts", "Plantilla presupuesto",  "file:xlsx", "low",     "low",   "FREE", ["tools"]],
  ["inventory_sheet",         "spreadsheet_artifacts", "Inventario",             "file:xlsx", "low",     "low",   "FREE", ["tools"]],
  ["dashboard_spreadsheet",   "spreadsheet_artifacts", "Dashboard Excel",        "file:xlsx", "high",    "medium","PRO",  ["reasoning", "tools"]],
  ["formula_generation",      "spreadsheet_artifacts", "Generación de fórmula",  "text",      "medium",  "low",   "FREE", ["reasoning"]],

  // ── Presentation artefacts ────────────────────────────────────────
  ["pptx_generation",         "presentation_artifacts", "Generación PPT",        "file:pptx", "medium",  "low",   "FREE", ["tools"]],
  ["pitch_deck",              "presentation_artifacts", "Pitch deck",            "file:pptx", "high",    "medium","PRO",  ["reasoning", "tools"]],
  ["academic_presentation",   "presentation_artifacts", "Presentación académica","file:pptx", "high",    "medium","FREE", ["reasoning", "tools"]],
  ["business_presentation",   "presentation_artifacts", "Presentación empresa",  "file:pptx", "medium",  "low",   "FREE", ["tools"]],
  ["training_deck",           "presentation_artifacts", "Material formativo",    "file:pptx", "medium",  "low",   "FREE", ["tools"]],
  ["slide_redesign",          "presentation_artifacts", "Rediseño de slides",    "file:pptx", "medium",  "low",   "FREE", ["tools", "vision"]],

  // ── Coding ────────────────────────────────────────────────────────
  ["code_generation",         "coding", "Generación de código",                 "code_artifact",   "medium",   "medium","FREE", ["reasoning", "code"]],
  ["code_debugging",          "coding", "Debug de código",                       "text",            "medium",   "medium","FREE", ["reasoning", "code"]],
  ["code_review",             "coding", "Revisión de código",                    "text",            "medium",   "low",   "FREE", ["reasoning", "code"]],
  ["app_generation",          "coding", "Generación de app",                     "code_artifact",   "very_high","high",  "PRO",  ["reasoning", "code", "tools", "sandbox"]],
  ["api_generation",          "coding", "Generación de API",                     "code_artifact",   "high",     "medium","FREE", ["reasoning", "code"]],
  ["database_schema",         "coding", "Esquema de base de datos",              "code_artifact",   "medium",   "medium","FREE", ["reasoning"]],
  ["landing_page_generation", "coding", "Landing page",                          "code_artifact",   "high",     "medium","FREE", ["reasoning", "code", "tools"]],
  ["frontend_component",      "coding", "Componente frontend",                   "code_artifact",   "medium",   "low",   "FREE", ["reasoning", "code"]],
  ["backend_service",         "coding", "Servicio backend",                      "code_artifact",   "high",     "high",  "PRO",  ["reasoning", "code"]],
  ["script_generation",       "coding", "Script (bash/py/js)",                   "code_artifact",   "low",      "medium","FREE", ["reasoning", "code"]],
  ["web_app_generation",      "coding", "Web app full-stack",                    "code_artifact",   "very_high","high",  "PRO",  ["reasoning", "code", "tools", "sandbox"]],

  // ── Design / visual ───────────────────────────────────────────────
  ["svg_generation",          "design_visual", "SVG",                            "image:svg",       "medium",   "low",   "FREE", ["reasoning"]],
  ["logo_concept",            "design_visual", "Logo",                           "image",           "medium",   "low",   "FREE", ["vision"]],
  ["infographic",             "design_visual", "Infografía",                     "image:svg",       "high",     "low",   "FREE", ["reasoning", "vision"]],
  ["chart_generation",        "design_visual", "Gráfico de datos",               "image:png",       "medium",   "low",   "FREE", ["reasoning", "code"]],
  ["diagram_generation",      "design_visual", "Diagrama técnico",               "image:svg",       "medium",   "low",   "FREE", ["reasoning"]],
  ["mermaid_diagram",         "design_visual", "Diagrama Mermaid",               "code_artifact",   "low",      "low",   "FREE", ["reasoning"]],
  ["ui_mockup",               "design_visual", "Mockup UI",                      "image",           "high",     "low",   "PRO",  ["reasoning", "vision"]],
  ["brand_kit",               "design_visual", "Kit de marca",                   "multi_artifact",  "high",     "low",   "PRO",  ["reasoning", "vision", "tools"]],

  // ── Image ─────────────────────────────────────────────────────────
  ["image_generation",        "image", "Generación de imagen",                   "image",           "medium",   "low",   "FREE", ["vision"]],
  ["image_editing",           "image", "Edición de imagen",                      "image",           "medium",   "low",   "FREE", ["vision"]],
  ["image_prompt_engineering","image", "Mejora de prompt visual",                "text",            "low",      "low",   "FREE", ["reasoning"]],
  ["style_transfer",          "image", "Style transfer",                         "image",           "medium",   "low",   "FREE", ["vision"]],
  ["product_mockup",          "image", "Mockup de producto",                     "image",           "medium",   "low",   "PRO",  ["vision"]],
  ["character_design",        "image", "Diseño de personaje",                    "image",           "medium",   "low",   "PRO",  ["vision"]],

  // ── Video ─────────────────────────────────────────────────────────
  ["video_generation",        "video", "Generación de video",                    "video",           "high",     "medium","PRO",  ["video"]],
  ["video_script",            "video", "Guion de video",                         "text",            "medium",   "low",   "FREE", ["reasoning"]],
  ["storyboard",              "video", "Storyboard",                             "image",           "medium",   "low",   "FREE", ["reasoning", "vision"]],
  ["shot_list",               "video", "Lista de planos",                        "text",            "low",      "low",   "FREE", ["reasoning"]],
  ["video_prompt",            "video", "Prompt de video",                        "text",            "low",      "low",   "FREE", ["reasoning"]],
  ["animation_plan",          "video", "Plan de animación",                      "text",            "medium",   "low",   "FREE", ["reasoning"]],

  // ── Audio ─────────────────────────────────────────────────────────
  ["audio_transcription",     "audio", "Transcripción",                          "text",            "low",      "low",   "FREE", ["audio"]],
  ["text_to_speech",          "audio", "Texto a voz",                            "audio",           "low",      "low",   "FREE", ["audio"]],
  ["audio_summarization",     "audio", "Resumen de audio",                       "text",            "medium",   "low",   "FREE", ["audio", "reasoning"]],
  ["audio_translation",       "audio", "Traducción de audio",                    "audio",           "medium",   "low",   "FREE", ["audio", "reasoning"]],

  // ── Research ──────────────────────────────────────────────────────
  ["web_research",             "research", "Investigación web",                  "text",            "medium",   "low",   "FREE", ["research", "tools"]],
  ["scientific_research",      "research", "Investigación científica",            "text",            "high",     "medium","FREE", ["research", "tools", "reasoning"]],
  ["market_research",          "research", "Estudio de mercado",                  "multi_artifact",  "high",     "medium","PRO",  ["research", "tools", "reasoning"]],
  ["competitive_analysis",     "research", "Análisis competitivo",                "text",            "high",     "medium","PRO",  ["research", "reasoning"]],
  ["source_validation",        "research", "Validación de fuentes",               "text",            "medium",   "low",   "FREE", ["research"]],
  ["bibliography_generation",  "research", "Bibliografía",                        "text",            "medium",   "low",   "FREE", ["research"]],
  ["doi_validation",           "research", "Validación DOI",                      "text",            "low",      "low",   "FREE", ["research"]],

  // ── Data ──────────────────────────────────────────────────────────
  ["data_analysis",            "data", "Análisis de datos",                       "multi_artifact",  "high",     "medium","FREE", ["reasoning", "code", "tools"]],
  ["data_cleaning",            "data", "Limpieza de datos",                       "file:xlsx",       "medium",   "low",   "FREE", ["reasoning", "code"]],
  ["statistics",               "data", "Estadística",                             "text",            "high",     "medium","FREE", ["reasoning", "code"]],
  ["forecasting",              "data", "Pronóstico",                              "multi_artifact",  "high",     "medium","PRO",  ["reasoning", "code"]],
  ["visualization",            "data", "Visualización",                           "image",           "medium",   "low",   "FREE", ["reasoning", "code"]],
  ["database_query",           "data", "Consulta SQL",                            "text",            "medium",   "high",  "PRO",  ["reasoning", "code"]],
  ["data_pipeline",            "data", "Pipeline de datos",                       "code_artifact",   "high",     "high",  "PRO",  ["reasoning", "code"]],
  ["csv_processing",           "data", "Procesar CSV",                            "file:csv",        "low",      "low",   "FREE", ["reasoning", "code"]],

  // ── Automation ────────────────────────────────────────────────────
  ["workflow_automation",      "automation", "Automatización de workflow",        "code_artifact",   "high",     "medium","PRO",  ["reasoning", "code", "tools"]],
  ["email_automation",         "automation", "Automatización de correo",          "code_artifact",   "high",     "high",  "PRO",  ["reasoning", "tools"]],
  ["crm_update",               "automation", "Actualizar CRM",                    "text",            "medium",   "high",  "PRO",  ["tools"]],
  ["calendar_scheduling",      "automation", "Agendar en calendario",             "text",            "low",      "medium","FREE", ["tools"]],
  ["web_scraping",             "automation", "Scraping web",                      "multi_artifact",  "high",     "high",  "PRO",  ["browser", "tools"]],
  ["browser_automation",       "automation", "Automatización de navegador",       "code_artifact",   "high",     "high",  "PRO",  ["browser"]],
  ["api_integration",          "automation", "Integración con API",               "code_artifact",   "high",     "medium","PRO",  ["reasoning", "code", "tools"]],

  // ── Business ──────────────────────────────────────────────────────
  ["business_plan",            "business", "Plan de negocio",                     "file:docx",       "high",     "medium","PRO",  ["reasoning", "research"]],
  ["marketing_plan",           "business", "Plan de marketing",                   "file:docx",       "high",     "medium","FREE", ["reasoning", "research"]],
  ["sales_copy",               "business", "Copy de ventas",                      "text",            "medium",   "low",   "FREE", ["reasoning"]],
  ["financial_analysis",       "business", "Análisis financiero",                 "multi_artifact",  "high",     "medium","PRO",  ["reasoning", "code"]],
  ["operations_process",       "business", "Proceso operativo",                   "file:docx",       "medium",   "medium","PRO",  ["reasoning"]],
  ["customer_support_response","business", "Respuesta de soporte",                "text",            "low",      "low",   "FREE", ["reasoning"]],
  ["product_strategy",         "business", "Estrategia de producto",              "file:docx",       "high",     "medium","PRO",  ["reasoning", "research"]],

  // ── Education ─────────────────────────────────────────────────────
  ["lesson_plan",              "education", "Plan de clase",                      "file:docx",       "medium",   "low",   "FREE", ["reasoning"]],
  ["exam_generation",          "education", "Generación de examen",               "file:docx",       "medium",   "low",   "FREE", ["reasoning"]],
  ["rubric_generation",        "education", "Generación de rúbrica",              "file:docx",       "medium",   "low",   "FREE", ["reasoning"]],
  ["study_guide",              "education", "Guía de estudio",                    "file:docx",       "medium",   "low",   "FREE", ["reasoning"]],
  ["course_design",            "education", "Diseño de curso",                    "multi_artifact",  "high",     "low",   "PRO",  ["reasoning"]],
  ["flashcards",               "education", "Flashcards",                         "text",            "low",      "low",   "FREE", ["reasoning"]],

  // ── High-risk domains ─────────────────────────────────────────────
  ["medical_guidance",         "high_risk_domains", "Guía médica",                "text",            "high",     "critical","PRO", ["reasoning", "research"]],
  ["legal_guidance",           "high_risk_domains", "Guía legal",                 "text",            "high",     "critical","PRO", ["reasoning", "research"]],
  ["financial_advice",         "high_risk_domains", "Asesoría financiera",        "text",            "high",     "critical","PRO", ["reasoning", "research"]],
  ["employment_decision",      "high_risk_domains", "Decisión de empleo",         "text",            "medium",   "critical","ENTERPRISE", ["reasoning"]],
  ["safety_critical_instruction","high_risk_domains", "Instrucción crítica de seguridad", "text", "high", "critical", "ENTERPRISE", ["reasoning"]],
];

const TAXONOMY = INTENTS.map(([id, family, label, default_output_kind, default_complexity, default_risk, default_min_plan, default_required_capabilities]) => ({
  id, family, label, default_output_kind, default_complexity, default_risk, default_min_plan, default_required_capabilities,
}));

const TAXONOMY_BY_ID = Object.freeze(TAXONOMY.reduce((m, t) => { m[t.id] = t; return m; }, {}));

function listIntents({ family } = {}) {
  if (!family) return TAXONOMY.map(t => ({ ...t, default_required_capabilities: [...t.default_required_capabilities] }));
  return TAXONOMY.filter(t => t.family === family).map(t => ({ ...t, default_required_capabilities: [...t.default_required_capabilities] }));
}

function getIntent(id) {
  return TAXONOMY_BY_ID[id] ? { ...TAXONOMY_BY_ID[id], default_required_capabilities: [...TAXONOMY_BY_ID[id].default_required_capabilities] } : null;
}

function listFamilies() {
  return [...FAMILIES];
}

function intentsByFamily() {
  const out = {};
  for (const f of FAMILIES) out[f] = TAXONOMY.filter(t => t.family === f).map(t => t.id);
  return out;
}

function integrity() {
  const seen = new Set();
  const issues = [];
  for (const t of TAXONOMY) {
    if (seen.has(t.id)) issues.push(`duplicate intent id "${t.id}"`);
    seen.add(t.id);
    if (!FAMILIES.includes(t.family)) issues.push(`${t.id} → unknown family "${t.family}"`);
    if (!["low", "medium", "high", "very_high"].includes(t.default_complexity)) issues.push(`${t.id} bad complexity`);
    if (!["low", "medium", "high", "critical"].includes(t.default_risk)) issues.push(`${t.id} bad risk`);
  }
  return { ok: issues.length === 0, issues, total: TAXONOMY.length, families: FAMILIES.length };
}

module.exports = {
  TAXONOMY,
  TAXONOMY_BY_ID,
  FAMILIES,
  listIntents,
  getIntent,
  listFamilies,
  intentsByFamily,
  integrity,
};

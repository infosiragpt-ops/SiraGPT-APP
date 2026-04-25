/**
 * cira/tool-registry — Cira Tool Registry as defined in the
 * MASTER_SPEC §11-12.
 *
 * Each tool is a typed contract:
 *
 *   {
 *     name, displayName, description,
 *     inputSchema, outputSchema, category, riskLevel,
 *     permissionsRequired[], timeoutMs, retryable,
 *     requiresHumanConfirmation,
 *     execute(input, context) → CiraToolResult
 *   }
 *
 * 60+ default tools registered across 10 categories:
 *   - document   (10 tools)
 *   - spreadsheet ( 9 tools)
 *   - presentation ( 6 tools)
 *   - pdf        ( 5 tools)
 *   - svg/visual ( 7 tools)
 *   - landing/app(12 tools)
 *   - research   ( 8 tools)
 *   - code       ( 7 tools)
 *   - image/video( 5 tools)
 *   - validator  ( 5 tools)
 *
 * Each tool's `execute` defaults to a deterministic stub that emits
 * a typed CiraToolResult. The platform works zero-deps; production
 * deploys swap concrete implementations via toolRegistry.register().
 *
 * Pure JS, deterministic, zero deps.
 */

const TOOL_PERMISSIONS = Object.freeze([
  "none",
  "read_uploaded_file",
  "write_artifact",
  "execute_sandboxed_code",
  "external_api_access",
  "browser_access",
  "database_read",
  "database_write",
  "send_message",
  "publish_online",
]);

const TOOL_RISK_LEVELS = Object.freeze(["low", "medium", "high", "critical"]);

const TOOL_CATEGORIES = Object.freeze([
  "document", "spreadsheet", "presentation", "pdf", "svg", "landing",
  "research", "code", "image", "video", "browser", "database",
  "validator", "storage", "custom",
]);

class CiraToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    validateToolContract(tool);
    if (this.tools.has(tool.name)) {
      throw new Error(`cira-tool-registry: tool already registered: "${tool.name}"`);
    }
    this.tools.set(tool.name, tool);
    return tool;
  }

  get(name) {
    return this.tools.get(name) || null;
  }

  has(name) {
    return this.tools.has(name);
  }

  list() {
    return [...this.tools.values()];
  }

  listForModelPrompt() {
    return this.list().map(t => ({
      name: t.name,
      description: t.description,
      category: t.category,
      riskLevel: t.riskLevel,
      permissionsRequired: [...t.permissionsRequired],
      requiresHumanConfirmation: t.requiresHumanConfirmation,
    }));
  }

  byCategory(category) {
    return this.list().filter(t => t.category === category);
  }

  /**
   * Execute a tool through the registry. Enforces permission policy
   * (caller's `grantedPermissions` must cover tool.permissionsRequired)
   * and a hard timeout.
   */
  async invoke(name, input, context = {}) {
    const tool = this.tools.get(name);
    if (!tool) {
      return mkErr("tool_not_found", `tool "${name}" is not registered`);
    }
    const granted = new Set(context.permissions || []);
    const missing = tool.permissionsRequired.filter(p => p !== "none" && !granted.has(p));
    if (missing.length > 0) {
      return mkErr("permission_denied", `tool "${name}" requires ${missing.join(", ")}`);
    }
    if (tool.requiresHumanConfirmation && context.humanApproved !== true) {
      return {
        status: "requires_confirmation",
        error: { code: "needs_human_approval", message: `tool "${name}" requires explicit human approval` },
        metadata: { tool: name, risk: tool.riskLevel },
      };
    }
    try {
      const result = await runWithTimeout(() => tool.execute(input, context), tool.timeoutMs);
      return shapeResult(result);
    } catch (err) {
      return mkErr(err && err.code ? err.code : "tool_execution_error", err && err.message ? err.message : String(err));
    }
  }

  integrity() {
    const seen = new Set();
    const issues = [];
    for (const t of this.tools.values()) {
      if (seen.has(t.name)) issues.push(`duplicate "${t.name}"`);
      seen.add(t.name);
      if (!TOOL_RISK_LEVELS.includes(t.riskLevel)) issues.push(`${t.name} bad riskLevel "${t.riskLevel}"`);
      if (!TOOL_CATEGORIES.includes(t.category)) issues.push(`${t.name} bad category "${t.category}"`);
      for (const p of t.permissionsRequired) {
        if (!TOOL_PERMISSIONS.includes(p)) issues.push(`${t.name} bad permission "${p}"`);
      }
    }
    return {
      ok: issues.length === 0,
      issues,
      total: this.tools.size,
      by_category: countBy([...this.tools.values()], "category"),
    };
  }
}

// ── Validation + helpers ────────────────────────────────────────────

function validateToolContract(t) {
  if (!t || typeof t !== "object") throw new Error("cira-tool-registry: tool must be an object");
  if (!t.name || typeof t.name !== "string") throw new Error("cira-tool-registry: tool.name required");
  if (typeof t.execute !== "function") throw new Error(`cira-tool-registry: ${t.name}.execute() required`);
  if (!TOOL_CATEGORIES.includes(t.category)) throw new Error(`cira-tool-registry: ${t.name}.category invalid`);
  if (!TOOL_RISK_LEVELS.includes(t.riskLevel)) throw new Error(`cira-tool-registry: ${t.name}.riskLevel invalid`);
  if (!Array.isArray(t.permissionsRequired)) throw new Error(`cira-tool-registry: ${t.name}.permissionsRequired must be array`);
  if (typeof t.timeoutMs !== "number" || t.timeoutMs <= 0) throw new Error(`cira-tool-registry: ${t.name}.timeoutMs must be positive number`);
}

function shapeResult(r) {
  if (!r || typeof r !== "object") return mkErr("invalid_tool_result", "tool returned non-object");
  if (!r.status) r.status = "success";
  if (!["success", "error", "requires_confirmation"].includes(r.status)) {
    return mkErr("invalid_tool_status", `bad status "${r.status}"`);
  }
  return r;
}

function mkErr(code, message) {
  return { status: "error", error: { code, message } };
}

function runWithTimeout(fn, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      const e = new Error(`tool timed out after ${ms}ms`);
      e.code = "tool_timeout";
      reject(e);
    }, ms);
    Promise.resolve()
      .then(fn)
      .then(v => { if (done) return; done = true; clearTimeout(t); resolve(v); })
      .catch(err => { if (done) return; done = true; clearTimeout(t); reject(err); });
  });
}

function countBy(arr, key) {
  return arr.reduce((m, x) => { m[x[key]] = (m[x[key]] || 0) + 1; return m; }, {});
}

// ── Default tool registrations ──────────────────────────────────────
//
// Each default tool is a typed contract with a deterministic stub.
// Production replaces stubs by calling registry.register() with
// concrete executors (e.g. the docx renderer at advanced-document-
// pipeline.js).

const DEFAULTS = [
  // Document
  d("create_docx", "document", "low", ["write_artifact"], "Genera Word profesional desde un outline estructurado."),
  d("render_docx_from_outline", "document", "low", ["write_artifact"], "Render Word desde sections/headings/charts/tables."),
  d("render_docx_from_markdown", "document", "low", ["write_artifact"], "Markdown → DOCX preservando títulos, listas y tablas."),
  d("apply_docx_template", "document", "low", ["read_uploaded_file", "write_artifact"], "Aplica template DOCX a contenido nuevo."),
  d("validate_docx", "validator", "low", [], "Valida que un .docx abra y cumpla estructura mínima."),
  d("export_docx_to_pdf", "document", "low", ["write_artifact"], "Convierte DOCX a PDF preservando formato."),
  d("create_academic_report", "document", "low", ["write_artifact"], "Informe académico APA 7 con secciones canónicas."),
  d("create_business_report", "document", "low", ["write_artifact"], "Informe corporativo profesional."),
  d("create_contract_draft", "document", "high", ["write_artifact"], "Borrador de contrato con disclaimer legal."),
  d("create_resume_cv", "document", "low", ["write_artifact"], "CV moderno o académico."),

  // Spreadsheet
  d("read_spreadsheet", "spreadsheet", "low", ["read_uploaded_file"], "Lee un Excel y devuelve hojas/columnas/tipos."),
  d("profile_spreadsheet", "spreadsheet", "low", ["read_uploaded_file"], "Perfil estadístico de cada columna."),
  d("clean_spreadsheet_data", "spreadsheet", "low", ["read_uploaded_file"], "Limpia nulos, duplicados, tipos."),
  d("analyze_spreadsheet", "spreadsheet", "medium", ["read_uploaded_file", "execute_sandboxed_code"], "Análisis estadístico + chart candidates."),
  d("create_xlsx", "spreadsheet", "low", ["write_artifact"], "Crea Excel desde un manifest de hojas/columnas/fórmulas/charts."),
  d("create_xlsx_dashboard", "spreadsheet", "low", ["write_artifact"], "Dashboard Excel con KPIs + gráficos."),
  d("add_formulas_to_xlsx", "spreadsheet", "low", ["write_artifact"], "Inyecta fórmulas en celdas específicas."),
  d("add_charts_to_xlsx", "spreadsheet", "low", ["write_artifact"], "Añade gráficos a hojas existentes."),
  d("validate_xlsx", "validator", "low", [], "Valida que el .xlsx abra y cumpla shape esperada."),

  // Presentation
  d("create_pptx", "presentation", "low", ["write_artifact"], "PowerPoint profesional desde plan de slides."),
  d("create_pitch_deck", "presentation", "low", ["write_artifact"], "Pitch deck con secciones canónicas (problem/solution/market/team/ask)."),
  d("create_academic_presentation", "presentation", "low", ["write_artifact"], "Presentación académica."),
  d("create_training_deck", "presentation", "low", ["write_artifact"], "Material formativo con notas del orador."),
  d("redesign_slides", "presentation", "low", ["read_uploaded_file", "write_artifact"], "Mejora un .pptx existente."),
  d("validate_pptx", "validator", "low", [], "Valida estructura, slides mínimos y notas."),

  // PDF
  d("render_pdf_from_html", "pdf", "low", ["write_artifact"], "Render PDF desde HTML usando un renderer headless."),
  d("render_pdf_from_docx", "pdf", "low", ["write_artifact"], "Convierte DOCX a PDF."),
  d("merge_pdfs", "pdf", "low", ["write_artifact"], "Combina varios PDFs en uno."),
  d("annotate_pdf", "pdf", "low", ["write_artifact"], "Añade marcas, comentarios o highlights."),
  d("validate_pdf", "validator", "low", [], "Valida que el PDF abra y tenga páginas legibles."),

  // SVG / visual
  d("create_svg", "svg", "low", ["write_artifact"], "Genera SVG limpio y minificado."),
  d("optimize_svg", "svg", "low", ["write_artifact"], "Optimiza tamaño y elimina metadata."),
  d("create_infographic_svg", "svg", "low", ["write_artifact"], "Infografía SVG con leyendas."),
  d("create_mermaid_diagram", "svg", "low", ["write_artifact"], "Genera diagrama Mermaid (código + render)."),
  d("create_chart", "svg", "low", ["write_artifact"], "Gráfico SVG/PNG (bar/line/pie/scatter/histogram)."),
  d("create_dashboard_html", "svg", "low", ["write_artifact"], "Dashboard interactivo en HTML."),
  d("validate_svg", "validator", "low", [], "Valida que el SVG parsee y cumpla viewBox."),

  // Landing / app
  d("generate_landing_spec", "landing", "low", [], "Spec estructurado para una landing (sections, copy, theme)."),
  d("create_nextjs_landing", "landing", "medium", ["write_artifact"], "Genera proyecto Next.js para landing."),
  d("create_react_component", "code", "low", ["write_artifact"], "Componente React tipado."),
  d("create_app_project", "code", "high", ["write_artifact"], "Proyecto full-stack: front + back + DB schema."),
  d("run_frontend_build", "code", "medium", ["execute_sandboxed_code"], "Ejecuta build en sandbox."),
  d("run_lint", "validator", "low", ["execute_sandboxed_code"], "Ejecuta lint en sandbox."),
  d("run_tests", "validator", "medium", ["execute_sandboxed_code"], "Ejecuta tests en sandbox."),
  d("create_preview_url", "landing", "medium", ["publish_online"], "Despliega preview temporal."),
  d("capture_preview_screenshot", "browser", "low", ["browser_access"], "Captura screenshot del preview."),
  d("zip_project", "storage", "low", ["write_artifact"], "Empaqueta el proyecto en .zip."),
  d("validate_responsive_design", "validator", "low", [], "Valida breakpoints + reflow + min font sizes."),
  d("validate_accessibility", "validator", "low", [], "Valida WCAG 2.1 AA en HTML."),

  // Research
  d("scientific_search", "research", "low", ["external_api_access"], "Busca papers en Scopus/OpenAlex/SciELO/PubMed/Crossref/DOAJ/Semantic Scholar."),
  d("doi_validator", "research", "low", ["external_api_access"], "Valida DOI y devuelve metadatos canónicos."),
  d("citation_formatter", "research", "low", [], "Formatea referencias APA 7/Vancouver/IEEE/MLA."),
  d("source_ranker", "research", "low", [], "Rankea fuentes por relevancia, recencia y autoridad."),
  d("bibliography_generator", "research", "low", [], "Genera bibliografía formateada desde un set de DOIs."),
  d("web_search", "research", "low", ["external_api_access"], "Búsqueda web general (no académica)."),
  d("evidence_grounding", "validator", "low", [], "Verifica que cada claim cite ≥1 fuente."),
  d("contradiction_detector", "validator", "low", [], "Detecta contradicciones entre claims/sources."),

  // Code
  d("code_project_generator", "code", "high", ["write_artifact"], "Genera estructura de un proyecto a partir de spec."),
  d("data_analysis_sandbox", "code", "medium", ["execute_sandboxed_code"], "Ejecuta análisis Python/Node en sandbox."),
  d("code_sandbox_python", "code", "medium", ["execute_sandboxed_code"], "Sandbox Python aislado."),
  d("code_sandbox_node", "code", "medium", ["execute_sandboxed_code"], "Sandbox Node aislado."),
  d("code_review", "validator", "low", [], "Revisa código por complejidad/secrets/dangerous calls."),
  d("artifact_validator", "validator", "low", [], "Valida que un artifact cumpla format_sovereignty."),
  d("playwright_tester", "validator", "medium", ["browser_access"], "Smoke E2E con Playwright en headless."),

  // Image / video
  d("image_prompt_builder", "image", "low", [], "Convierte descripción simple en prompt visual avanzado."),
  d("image_generation_api", "image", "low", ["external_api_access"], "Llama al modelo de imagen elegido por el usuario."),
  d("image_quality_checker", "validator", "low", [], "Verifica que la imagen cumpla el prompt."),
  d("video_prompt_builder", "video", "low", [], "Convierte descripción en prompt cinematográfico."),
  d("video_generation_api", "video", "low", ["external_api_access"], "Llama al modelo de video elegido por el usuario."),
];

/**
 * d() — short-hand factory that creates a tool descriptor with a
 * deterministic stub executor.
 */
function d(name, category, riskLevel, permissionsRequired, description) {
  return {
    name,
    displayName: humanise(name),
    description,
    inputSchema: { type: "object", additionalProperties: true },
    outputSchema: { type: "object", additionalProperties: true },
    category,
    riskLevel,
    permissionsRequired: [...permissionsRequired],
    timeoutMs: 30000,
    retryable: true,
    requiresHumanConfirmation: riskLevel === "critical" || (category === "landing" && permissionsRequired.includes("publish_online")),
    async execute(input, context) {
      return {
        status: "success",
        output: {
          tool: name,
          stub: true,
          input_keys: input && typeof input === "object" ? Object.keys(input).slice(0, 8) : [],
          ts: new Date().toISOString(),
        },
        metadata: { category, riskLevel, request_id: context?.requestId || null },
      };
    },
  };
}

function humanise(s) {
  return String(s || "").replace(/[._-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Factory — returns a fresh registry pre-populated with the default
 * 60+ tool stubs. Production passes its own concrete executors via
 * registry.register() AFTER instantiating.
 */
function createDefaultRegistry() {
  const reg = new CiraToolRegistry();
  for (const t of DEFAULTS) reg.register(t);
  return reg;
}

module.exports = {
  CiraToolRegistry,
  createDefaultRegistry,
  TOOL_PERMISSIONS,
  TOOL_RISK_LEVELS,
  TOOL_CATEGORIES,
  DEFAULT_TOOLS: DEFAULTS,
};

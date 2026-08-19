/**
 * tool-registry — single source of truth for every tool the AI Product
 * OS knows about.
 *
 * The registry stores typed tool descriptors:
 *
 *   {
 *     id,                  // canonical id (snake or dotted path)
 *     name,                // human label
 *     description,         // one-line purpose
 *     category,            // "research" | "document" | "code" | "db" | …
 *     input_schema,        // JSON Schema for arguments
 *     output_schema,       // JSON Schema for the return shape
 *     scopes,              // required permission scopes
 *     side_effect_level,   // "read" | "write" | "external" | "destructive"
 *     requires_confirmation,
 *     sandbox_required,
 *     audit_policy,        // "always" | "on_write" | "never"
 *     data_classes,        // ["pii", "internal", "public"]
 *     recommended_for,     // intent ids this tool is useful for
 *     binder,              // optional → MCP gateway tool name
 *   }
 *
 * The registry is queryable:
 *   - byId(id)               → tool or null
 *   - byCategory(cat)        → tool[]
 *   - recommendedFor(intent) → tool[]
 *   - search(text)           → tool[]
 *   - integrity()            → schema/wiring check
 *
 * It can also bind itself to an MCP gateway (registers each tool).
 *
 * Pure JS, deterministic, zero deps.
 */

const TOOLS = [
  // ── Research / web ────────────────────────────────────────────────
  {
    id: "research.agenticBatch", name: "Agentic Research Batch",
    description: "Run a 7-provider scholarly search loop with rerank, dedupe and citation block.",
    category: "research",
    input_schema: { type: "object", required: ["query"], properties: { query: { type: "string" }, perBatch: { type: "integer" }, maxResults: { type: "integer" } } },
    output_schema: { type: "object" },
    scopes: ["net.read"], side_effect_level: "external", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["public"],
    recommended_for: ["research_question", "complex_academic_document_generation", "pdf_report_generation"],
  },
  {
    id: "self_rag.answer", name: "Self-RAG answer",
    description: "Self-RAG reflective answer with retrieve/ISREL/ISSUP/ISUSE tokens.",
    category: "research",
    input_schema: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    output_schema: { type: "object" },
    scopes: ["net.read"], side_effect_level: "external", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["public"],
    recommended_for: ["research_question", "text_answer"],
  },
  {
    id: "rag.retrieve", name: "RAG retrieve",
    description: "Hybrid retrieval (BM25 + dense) over the user knowledge base.",
    category: "research",
    input_schema: { type: "object", required: ["query"], properties: { query: { type: "string" }, topK: { type: "integer" } } },
    output_schema: { type: "object" },
    scopes: ["kb.read"], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["internal"],
    recommended_for: ["research_question", "complex_academic_document_generation"],
  },

  // ── Document intelligence ─────────────────────────────────────────
  {
    id: "docintel.analyze", name: "Document structural analysis",
    description: "Layout-aware structural analyser: heading hierarchy + table + figure detection + section chunks.",
    category: "document",
    input_schema: { type: "object", properties: { text: { type: "string" }, pages: { type: "array" } } },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "never", data_classes: ["internal"],
    recommended_for: ["complex_academic_document_generation", "pdf_report_generation", "research_question"],
  },
  {
    id: "docintel.ground", name: "Citation grounding",
    description: "Verify each factual claim is grounded in ≥1 source via jaccard + 4-gram + numeric match.",
    category: "document",
    input_schema: { type: "object", required: ["answer", "sources"], properties: { answer: { type: "string" }, sources: { type: "array" } } },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["internal"],
    recommended_for: ["research_question", "complex_academic_document_generation"],
  },
  {
    id: "docintel.contradictions", name: "Contradiction detector",
    description: "Find polarity, comparative or numeric divergence between claims across sources.",
    category: "document",
    input_schema: { type: "object", required: ["claims"], properties: { claims: { type: "array" } } },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["internal"],
    recommended_for: ["research_question", "complex_academic_document_generation"],
  },

  // ── Document generation ───────────────────────────────────────────
  {
    id: "create_document", name: "Create document",
    description: "Generate a docx/xlsx/pptx/pdf via the multi-agent pipeline.",
    category: "document",
    input_schema: { type: "object", required: ["script"], properties: { script: { type: "string" }, format: { type: "string" } } },
    output_schema: { type: "object" },
    scopes: ["sandbox.exec"], side_effect_level: "external", requires_confirmation: false,
    sandbox_required: true, audit_policy: "always", data_classes: ["internal"],
    recommended_for: ["complex_academic_document_generation", "spreadsheet_generation", "presentation_generation", "pdf_report_generation"],
  },
  {
    id: "verify_artifact", name: "Verify artifact",
    description: "Run the deterministic Artifact Reviewer over a generated file (extension, MIME, structure, min content).",
    category: "document",
    input_schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["internal"],
    recommended_for: ["complex_academic_document_generation", "spreadsheet_generation", "presentation_generation", "pdf_report_generation"],
  },

  // ── Database ──────────────────────────────────────────────────────
  {
    id: "sql.safety.analyze", name: "SQL safety analyser",
    description: "Static analysis: read-only-by-default, DDL rejection, SQLi pattern detection.",
    category: "db",
    input_schema: { type: "object", required: ["sql"], properties: { sql: { type: "string" } } },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["internal"],
    recommended_for: ["database_query", "data_analysis"],
  },

  // ── Web automation ────────────────────────────────────────────────
  {
    id: "web.url.canonical", name: "URL canonicalise",
    description: "Strip tracking params, normalise to eTLD+1, dedupe.",
    category: "web",
    input_schema: { type: "object", required: ["url"], properties: { url: { type: "string" } } },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "never", data_classes: ["public"],
    recommended_for: ["web_scraping", "research_question"],
  },
  {
    id: "web.robots.parse", name: "robots.txt parser",
    description: "Parse robots.txt with longest-prefix allow/disallow + crawl-delay.",
    category: "web",
    input_schema: { type: "object", required: ["robots", "userAgent", "url"], properties: { robots: { type: "string" }, userAgent: { type: "string" }, url: { type: "string" } } },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["public"],
    recommended_for: ["web_scraping"],
  },
  {
    id: "web.scraper.policy", name: "Scraper compliance gate",
    description: "Reject configs that try to bypass robots, captchas, paywalls, auth.",
    category: "web",
    input_schema: { type: "object", required: ["config"] },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["public"],
    recommended_for: ["web_scraping"],
  },
  {
    id: "web.html.extract", name: "HTML structured-data extractor",
    description: "JSON-LD + OpenGraph + Twitter cards + breadcrumbs (pure regex).",
    category: "web",
    input_schema: { type: "object", required: ["html"] },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "never", data_classes: ["public"],
    recommended_for: ["web_scraping", "research_question"],
  },
  {
    id: "web.rate.limit", name: "Web rate limiter",
    description: "Apply per-domain crawl budgets, exponential backoff and retry-after compliance before fetching.",
    category: "web",
    input_schema: {
      type: "object",
      required: ["domain"],
      properties: {
        domain: { type: "string" },
        crawlDelayMs: { type: "integer" },
        retryAfterMs: { type: "integer" },
      },
    },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["public"],
    recommended_for: ["web_scraping"],
  },

  // ── BI / data ─────────────────────────────────────────────────────
  {
    id: "bi.semanticModel.compile", name: "BI semantic model compiler",
    description: "Star schema + DAX-like measures + KPI cards.",
    category: "bi",
    input_schema: { type: "object", required: ["model"] },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["internal"],
    recommended_for: ["data_analysis", "spreadsheet_generation"],
  },
  {
    id: "bi.market.framework", name: "Market frameworks",
    description: "TAM/SAM/SOM + Porter + SWOT + PESTEL + unit economics + cohort retention.",
    category: "bi",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["internal"],
    recommended_for: ["data_analysis", "complex_academic_document_generation"],
  },

  // ── Code / build ──────────────────────────────────────────────────
  {
    id: "code-review.analyze", name: "Code reviewer",
    description: "Cyclomatic complexity, nesting, dangerous calls, secret scan.",
    category: "code",
    input_schema: { type: "object", required: ["source"] },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["internal"],
    recommended_for: ["code_generation", "web_app_build"],
  },
  {
    id: "sbom.generate", name: "SBOM generator",
    description: "CycloneDX 1.5 SBOM from package.json/lockfile/requirements/pyproject.",
    category: "code",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["internal"],
    recommended_for: ["code_generation", "web_app_build"],
  },
  {
    id: "dependency-audit.run", name: "Dependency auditor",
    description: "License, duplicate version, deprecated package, unpinned-range checks.",
    category: "code",
    input_schema: { type: "object", required: ["sbom"] },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["internal"],
    recommended_for: ["code_generation", "web_app_build"],
  },
  {
    id: "scaffolder.nextjs", name: "Next.js App Router scaffolder",
    description: "Repo descriptor + Playwright E2E + Docker + CI/CD workflow.",
    category: "code",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "write", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["internal"],
    recommended_for: ["web_app_build"],
  },
  {
    id: "scaffolder.fastapi", name: "FastAPI / Pydantic scaffolder",
    description: "Repo descriptor + Alembic + Docker + CI/CD workflow.",
    category: "code",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "write", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["internal"],
    recommended_for: ["web_app_build", "code_generation"],
  },
  {
    id: "seo.validate", name: "SEO validator",
    description: "Title/desc budget, OG/Twitter, schema.org, vague anchors.",
    category: "code",
    input_schema: { type: "object", required: ["html"] },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["internal"],
    recommended_for: ["web_app_build"],
  },
  {
    id: "wcag.check", name: "WCAG AA checker",
    description: "Image alt, label/for, heading order, accessible names, duplicate ids.",
    category: "code",
    input_schema: { type: "object", required: ["html"] },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["internal"],
    recommended_for: ["web_app_build", "design_system"],
  },
  {
    id: "cwv.analyze", name: "Core Web Vitals budget",
    description: "JS/CSS/image bytes, render-blocking, CLS/LCP risk.",
    category: "code",
    input_schema: { type: "object", required: ["html"] },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["internal"],
    recommended_for: ["web_app_build"],
  },

  // ── Design ────────────────────────────────────────────────────────
  {
    id: "design.tokens.build", name: "Design tokens builder",
    description: "Palette → CSS vars + JSON tokens + WCAG contrast verdicts.",
    category: "design",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["internal"],
    recommended_for: ["design_system", "web_app_build"],
  },
  {
    id: "wcag.contrast.check", name: "Contrast ratio",
    description: "WCAG AA/AAA contrast verdict for fg / bg colour pair.",
    category: "design",
    input_schema: { type: "object", required: ["fg", "bg"] },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "never", data_classes: ["public"],
    recommended_for: ["design_system", "web_app_build"],
  },

  // ── Security ──────────────────────────────────────────────────────
  {
    id: "asvs.evaluate", name: "OWASP ASVS evaluator",
    description: "Run ASVS L1 controls and emit per-control verdicts.",
    category: "security",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["internal"],
    recommended_for: ["web_app_build", "code_generation"],
  },
  {
    id: "secret-scanner.scan", name: "Secret scanner",
    description: "15-pattern regex scan (AWS, GitHub, Slack, Stripe, OpenAI, Anthropic, PEM, JWT…).",
    category: "security",
    input_schema: { type: "object", required: ["text"] },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "read", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["internal"],
    recommended_for: ["code_generation", "web_app_build"],
  },

  // ── Observability / Audit ─────────────────────────────────────────
  {
    id: "observability.span.create", name: "Create OTel span",
    description: "Create an OpenTelemetry-compatible span and attach it to a trace.",
    category: "observability",
    input_schema: { type: "object", required: ["name"] },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "write", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["internal"],
    recommended_for: [],
  },
  {
    id: "audit.write", name: "Audit log write",
    description: "Append-only audit record for compliance and replay.",
    category: "observability",
    input_schema: { type: "object", required: ["event"] },
    output_schema: { type: "object" },
    scopes: ["audit.write"], side_effect_level: "write", requires_confirmation: false,
    sandbox_required: false, audit_policy: "always", data_classes: ["internal"],
    recommended_for: [],
  },

  // ── HITL ──────────────────────────────────────────────────────────
  {
    id: "hitl.request", name: "Human-in-the-loop request",
    description: "Submit a destructive or ambiguous action for human approval.",
    category: "governance",
    input_schema: { type: "object", required: ["payload"] },
    output_schema: { type: "object" },
    scopes: [], side_effect_level: "write", requires_confirmation: true,
    sandbox_required: false, audit_policy: "always", data_classes: ["internal"],
    recommended_for: ["agent_long_running_task", "database_query"],
  },
];

const TOOLS_BY_ID = Object.freeze(
  TOOLS.reduce((m, t) => { m[t.id] = t; return m; }, {})
);

function listTools() {
  return TOOLS.map(t => ({ ...t, scopes: [...t.scopes], recommended_for: [...t.recommended_for] }));
}

function byId(id) {
  return TOOLS_BY_ID[id] ? { ...TOOLS_BY_ID[id] } : null;
}

function byCategory(category) {
  return TOOLS.filter(t => t.category === category).map(t => ({ ...t }));
}

function recommendedFor(intent) {
  return TOOLS.filter(t => t.recommended_for.includes(intent)).map(t => ({ ...t }));
}

function search(query) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return [];
  return TOOLS
    .filter(t => t.id.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
    .map(t => ({ ...t }));
}

function integrity() {
  const seen = new Set();
  const issues = [];
  for (const t of TOOLS) {
    if (!t.id) issues.push(`tool missing id: ${JSON.stringify(t).slice(0, 80)}`);
    if (seen.has(t.id)) issues.push(`duplicate tool id "${t.id}"`);
    seen.add(t.id);
    if (!t.input_schema) issues.push(`"${t.id}" missing input_schema`);
    if (!t.output_schema) issues.push(`"${t.id}" missing output_schema`);
    if (!Array.isArray(t.scopes)) issues.push(`"${t.id}" scopes must be array`);
    if (!Array.isArray(t.recommended_for)) issues.push(`"${t.id}" recommended_for must be array`);
  }
  return { ok: issues.length === 0, issues, total: TOOLS.length, by_category: countBy(TOOLS, "category") };
}

function bindToMcpGateway(gateway, { handlerFor } = {}) {
  if (!gateway || typeof gateway.registerTool !== "function") {
    throw new Error("tool-registry.bindToMcpGateway: gateway with registerTool() required");
  }
  let bound = 0;
  for (const t of TOOLS) {
    const handler = typeof handlerFor === "function" ? handlerFor(t) : null;
    if (typeof handler !== "function") continue; // only bind tools the caller knows how to run
    gateway.registerTool({
      name: t.id,
      description: t.description,
      input_schema: t.input_schema,
      output_schema: t.output_schema,
      scopes: t.scopes,
      handler,
    });
    bound += 1;
  }
  return { bound, total: TOOLS.length };
}

function countBy(arr, key) {
  const out = {};
  for (const x of arr) out[x[key]] = (out[x[key]] || 0) + 1;
  return out;
}

module.exports = {
  TOOLS,
  TOOLS_BY_ID,
  listTools,
  byId,
  byCategory,
  recommendedFor,
  search,
  integrity,
  bindToMcpGateway,
};

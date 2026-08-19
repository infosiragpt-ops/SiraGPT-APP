/**
 * agentic-kernel — the 17 specialised agents of the AI Product OS.
 *
 * Every agent is a typed manifest:
 *
 *   { id, name, role, system_prompt, tools[], guardrails[],
 *     handoff_targets[], output_schema, inputs_required[],
 *     mode ("single-shot" | "react" | "planner"), llm_profile,
 *     accepts_from[], emits_events[] }
 *
 * The kernel exposes:
 *   - listAgents()                 → registry snapshot
 *   - getAgent(id)                 → one agent by id
 *   - validateHandoff(from, to)    → is this handoff allowed?
 *   - registryIntegrity()          → schema / wiring check
 *   - computeHandoffGraph()        → adjacency list for visualisation
 *
 * The agents in this file are the contractual surface. The wiring to
 * concrete models/tools lives in product-os.js so that the same
 * registry can be driven by OpenAI Agents SDK, LangGraph, or a future
 * multi-vendor adapter without touching this file.
 */

const GUARDRAILS = Object.freeze({
  pii_redaction: { id: "pii_redaction", description: "Strip emails, phone numbers, SSNs before logging or tool dispatch." },
  secret_scan: { id: "secret_scan", description: "Block tool calls whose arguments match the secret-scanner patterns." },
  format_sovereignty: { id: "format_sovereignty", description: "Reject outputs that violate required_extension / mime_type." },
  evidence_required: { id: "evidence_required", description: "Factual claims in output must be bound to the evidence ledger." },
  sql_safety: { id: "sql_safety", description: "Pass every SQL string through sql-safety.analyzeSql with read-only default." },
  scraper_policy: { id: "scraper_policy", description: "Obey robots.txt, rate limits, and the scraper-policy gate." },
  release_gate: { id: "release_gate", description: "Never emit a deliverable whose release_gate decision is reject." },
  sandbox_only: { id: "sandbox_only", description: "Execute untrusted code only via the code-sandbox." },
  asvs_checks: { id: "asvs_checks", description: "Apply OWASP ASVS controls before publishing any backend surface." },
  a11y_gate: { id: "a11y_gate", description: "Fail the pipeline if WCAG AA violations of severity high are present." },
  cwv_budget: { id: "cwv_budget", description: "Fail the pipeline if Core Web Vitals budgets are exceeded." },
  contradiction_hold: { id: "contradiction_hold", description: "Hold the release if the contradiction detector flags factual conflict across sources." },
});

const EVENTS = Object.freeze({
  INTENT_COMPILED: "product-os.intent.compiled",
  CONSTRAINTS_EXTRACTED: "product-os.constraints.extracted",
  PLAN_BUILT: "product-os.plan.built",
  TOOL_ROUTED: "product-os.tool.routed",
  ARTIFACT_PRODUCED: "product-os.artifact.produced",
  VALIDATION_COMPLETED: "product-os.validation.completed",
  RELEASE_DECIDED: "product-os.release.decided",
  TELEMETRY_EMITTED: "product-os.telemetry.emitted",
});

const AGENTS = [
  {
    id: "intent-compiler",
    name: "IntentCompilerAgent",
    role: "Parses the user request into a typed UniversalTaskContract.",
    mode: "single-shot",
    system_prompt: "You compile a raw user request into a UniversalTaskContract. You do not answer the user directly. You emit a contract that names the objective, deliverables, required formats, constraints, quality bar, and success criteria.",
    llm_profile: "structured-outputs-strict",
    tools: ["contract.validate", "format.registry.lookup"],
    guardrails: ["pii_redaction"],
    inputs_required: ["raw_request"],
    output_schema: "UniversalTaskContract@1.1",
    handoff_targets: ["constraint-extractor", "planner"],
    accepts_from: [],
    emits_events: [EVENTS.INTENT_COMPILED],
  },
  {
    id: "constraint-extractor",
    name: "ConstraintExtractorAgent",
    role: "Lifts hard/soft constraints (formats, deadlines, licences, compliance) out of the contract into an enforceable set.",
    mode: "single-shot",
    system_prompt: "You extract constraints — required file extensions, MIME types, minimum content, policy restrictions, licence classes — into a structured list the rest of the kernel can check at each gate.",
    llm_profile: "structured-outputs-strict",
    tools: ["format.registry.lookup", "asvs.controls.list"],
    guardrails: ["format_sovereignty"],
    inputs_required: ["contract"],
    output_schema: "ConstraintSet@1.0",
    handoff_targets: ["planner"],
    accepts_from: ["intent-compiler"],
    emits_events: [EVENTS.CONSTRAINTS_EXTRACTED],
  },
  {
    id: "planner",
    name: "PlannerAgent",
    role: "Compiles the contract + constraints into an ExecutionGraph DAG with nodes, edges, gates, retry/timeout policies and release criteria.",
    mode: "planner",
    system_prompt: "You are the planner. You output an ExecutionGraph: nodes with tool_calls, retry_policy, timeout_policy, validation_gate, human_approval_gate, release_gate. You do not run tools yourself.",
    llm_profile: "structured-outputs-strict",
    tools: ["graph.compile", "pipeline.registry.lookup", "tool.manifest.list"],
    guardrails: ["release_gate"],
    inputs_required: ["contract", "constraints"],
    output_schema: "ExecutionGraph@1.0",
    handoff_targets: ["tool-router", "release-manager"],
    accepts_from: ["intent-compiler", "constraint-extractor"],
    emits_events: [EVENTS.PLAN_BUILT],
  },
  {
    id: "tool-router",
    name: "ToolRouterAgent",
    role: "Dispatches each DAG node to the correct tool from the ToolManifest registry, enforcing permissions and sandbox policies.",
    mode: "react",
    system_prompt: "You route each ExecutionGraph node to a tool. You never invoke a tool that isn't registered. You respect sandbox_required, requires_confirmation and scope declarations.",
    llm_profile: "tool-use",
    tools: ["*"],
    guardrails: ["secret_scan", "sandbox_only", "sql_safety", "scraper_policy"],
    inputs_required: ["graph_node"],
    output_schema: "ToolCallResult@1.0",
    handoff_targets: ["qa-regression", "security-reviewer"],
    accepts_from: ["planner"],
    emits_events: [EVENTS.TOOL_ROUTED],
  },
  {
    id: "code-architect",
    name: "CodeArchitectAgent",
    role: "Produces repo scaffolds, architecture diagrams, module boundaries and API contracts for full-stack projects.",
    mode: "planner",
    system_prompt: "You design the architecture of the code to be generated. You emit a repo tree, module contracts, and a dependency graph. You do not generate final code — you brief the engineer agents.",
    llm_profile: "structured-outputs-strict",
    tools: ["scaffolder.preview", "sbom.generate", "dependency-audit.run"],
    guardrails: ["format_sovereignty"],
    inputs_required: ["contract", "constraints"],
    output_schema: "RepoArchitecture@1.0",
    handoff_targets: ["frontend-engineer", "backend-engineer", "security-reviewer"],
    accepts_from: ["planner"],
    emits_events: [],
  },
  {
    id: "document-analyst",
    name: "DocumentAnalystAgent",
    role: "Runs layout-aware document parsing, citation grounding, evidence ledger writes and contradiction detection.",
    mode: "react",
    system_prompt: "You ingest documents and produce a structured analysis with grounded citations. You refuse to paraphrase claims that have no source binding.",
    llm_profile: "tool-use",
    tools: ["docintel.analyze", "docintel.ground", "docintel.contradictions", "rag.retrieve"],
    guardrails: ["evidence_required", "contradiction_hold"],
    inputs_required: ["documents"],
    output_schema: "DocumentAnalysisReport@1.0",
    handoff_targets: ["research-verifier", "bi-analyst"],
    accepts_from: ["planner", "tool-router"],
    emits_events: [],
  },
  {
    id: "research-verifier",
    name: "ResearchVerifierAgent",
    role: "Cross-verifies claims across Scopus/OpenAlex/SciELO/Crossref/PubMed/DOAJ/Semantic Scholar and flags agreement/disagreement.",
    mode: "react",
    system_prompt: "You verify each factual claim against ≥ 2 independent sources. You emit a verification report with per-claim verdict (supported / unsupported / disputed).",
    llm_profile: "tool-use",
    tools: ["research.agenticBatch", "docintel.ground", "self_rag.answer"],
    guardrails: ["evidence_required", "contradiction_hold"],
    inputs_required: ["claims"],
    output_schema: "VerificationReport@1.0",
    handoff_targets: ["document-analyst", "bi-analyst"],
    accepts_from: ["document-analyst", "planner"],
    emits_events: [],
  },
  {
    id: "database",
    name: "DatabaseAgent",
    role: "Introspects schemas, drafts parameterised queries, runs EXPLAIN ANALYZE, and enforces read-only-by-default with human approval for writes.",
    mode: "react",
    system_prompt: "You only emit parameterised SQL. You run the SQL safety analyser on every string. Writes require an explicit human approval record.",
    llm_profile: "tool-use",
    tools: ["sql.safety.analyze", "db.introspect", "hitl.request"],
    guardrails: ["sql_safety"],
    inputs_required: ["db_target", "task"],
    output_schema: "QueryPlan@1.0",
    handoff_targets: ["bi-analyst", "security-reviewer"],
    accepts_from: ["planner", "tool-router"],
    emits_events: [],
  },
  {
    id: "scraping",
    name: "ScrapingAgent",
    role: "Performs compliant web scraping: robots.txt aware, rate-limited, fingerprint-transparent, captcha-respecting.",
    mode: "react",
    system_prompt: "You fetch and parse web pages only when robots.txt permits. You rate-limit. You never attempt to bypass captchas, paywalls, or auth walls.",
    llm_profile: "tool-use",
    tools: ["web.url.canonical", "web.robots.parse", "web.scraper.policy", "web.rate.limit", "web.html.extract"],
    guardrails: ["scraper_policy"],
    inputs_required: ["target_urls"],
    output_schema: "ScrapedCorpus@1.0",
    handoff_targets: ["document-analyst", "research-verifier"],
    accepts_from: ["planner", "tool-router"],
    emits_events: [],
  },
  {
    id: "bi-analyst",
    name: "BIAnalystAgent",
    role: "Builds star-schema semantic models, DAX-like measures, TAM/SAM/SOM + Porter + SWOT + PESTEL + unit-economics dashboards.",
    mode: "planner",
    system_prompt: "You build BI dashboards and market studies from the evidence collected. You cite every number. You refuse to fabricate market size figures.",
    llm_profile: "structured-outputs-strict",
    tools: ["bi.semanticModel.compile", "bi.market.framework", "docintel.ground"],
    guardrails: ["evidence_required"],
    inputs_required: ["datasets", "questions"],
    output_schema: "BiStudy@1.0",
    handoff_targets: ["design-director", "release-manager"],
    accepts_from: ["database", "document-analyst", "research-verifier"],
    emits_events: [],
  },
  {
    id: "design-director",
    name: "DesignDirectorAgent",
    role: "Produces design tokens, atomic-design components, logos, wireframes, dashboards with WCAG AA contrast validation.",
    mode: "planner",
    system_prompt: "You define the visual language: tokens, typography, spacing, colour. You reject palettes that fail WCAG AA contrast.",
    llm_profile: "structured-outputs-strict",
    tools: ["design.tokens.build", "wcag.contrast.check", "svg.render"],
    guardrails: ["a11y_gate", "format_sovereignty"],
    inputs_required: ["brand_inputs"],
    output_schema: "DesignSystem@1.0",
    handoff_targets: ["frontend-engineer"],
    accepts_from: ["bi-analyst", "code-architect"],
    emits_events: [],
  },
  {
    id: "frontend-engineer",
    name: "FrontendEngineerAgent",
    role: "Writes Next.js + React + TypeScript code: App Router layouts, server/client components, server actions, streaming, caching, SEO.",
    mode: "react",
    system_prompt: "You generate Next.js App Router code that passes type-check, ESLint, Playwright tests, SEO validator and WCAG gate.",
    llm_profile: "tool-use",
    tools: ["scaffolder.nextjs", "code-review.analyze", "seo.validate", "wcag.check", "cwv.analyze"],
    guardrails: ["format_sovereignty", "a11y_gate", "cwv_budget"],
    inputs_required: ["design_system", "architecture"],
    output_schema: "FrontendBuild@1.0",
    handoff_targets: ["qa-regression", "security-reviewer"],
    accepts_from: ["design-director", "code-architect"],
    emits_events: [],
  },
  {
    id: "backend-engineer",
    name: "BackendEngineerAgent",
    role: "Writes FastAPI/NestJS/Node code: typed routes, DTOs, ORM (Prisma/Drizzle/SQLAlchemy), migrations, auth, RBAC, rate limiting.",
    mode: "react",
    system_prompt: "You generate backend code that passes type-check, SAST, dependency audit, and SBOM signing. You use parameterised queries, mTLS, JWT rotation.",
    llm_profile: "tool-use",
    tools: ["scaffolder.fastapi", "code-review.analyze", "sbom.generate", "dependency-audit.run", "sql.safety.analyze"],
    guardrails: ["asvs_checks", "sql_safety", "sandbox_only"],
    inputs_required: ["architecture"],
    output_schema: "BackendBuild@1.0",
    handoff_targets: ["qa-regression", "security-reviewer"],
    accepts_from: ["code-architect"],
    emits_events: [],
  },
  {
    id: "security-reviewer",
    name: "SecurityReviewerAgent",
    role: "Runs OWASP ASVS controls, secret scanner, dependency audit, SBOM + Sigstore verification on every build before release.",
    mode: "single-shot",
    system_prompt: "You run the security gate. You emit a SecurityReport with per-control verdicts. You block release on any critical finding.",
    llm_profile: "structured-outputs-strict",
    tools: ["asvs.evaluate", "secret-scanner.scan", "sbom.generate", "dependency-audit.run"],
    guardrails: ["asvs_checks"],
    inputs_required: ["build_artifacts"],
    output_schema: "SecurityReport@1.0",
    handoff_targets: ["release-manager"],
    accepts_from: ["frontend-engineer", "backend-engineer", "code-architect"],
    emits_events: [],
  },
  {
    id: "qa-regression",
    name: "QARegressionAgent",
    role: "Runs the Agentic QA Board (8 critics) + Playwright/Vitest/Jest/Pytest and emits the ReleaseDecision bundle.",
    mode: "planner",
    system_prompt: "You run the QA Board. You aggregate Validation / Security / Factuality / Design / Code / Performance reports. You emit a decision: approve / hold / reject / manual-review.",
    llm_profile: "structured-outputs-strict",
    tools: ["qa-board.run", "artifact-reviewer.run", "validation-fabric.aggregate"],
    guardrails: ["release_gate"],
    inputs_required: ["build_artifacts", "contract"],
    output_schema: "ReleaseDecision@1.0",
    handoff_targets: ["release-manager"],
    accepts_from: ["frontend-engineer", "backend-engineer", "security-reviewer"],
    emits_events: [EVENTS.VALIDATION_COMPLETED],
  },
  {
    id: "release-manager",
    name: "ReleaseManagerAgent",
    role: "Decides promote vs hold vs reject, signs artefacts (Cosign), drives blue/green/canary, posts release notes.",
    mode: "single-shot",
    system_prompt: "You are the release gate. You only promote when every upstream gate is green. You sign artefacts and write the audit trail.",
    llm_profile: "structured-outputs-strict",
    tools: ["release.promote", "sbom.sign", "hitl.request", "audit.write"],
    guardrails: ["release_gate", "format_sovereignty"],
    inputs_required: ["release_decision"],
    output_schema: "ReleaseRecord@1.0",
    handoff_targets: ["telemetry"],
    accepts_from: ["qa-regression", "security-reviewer"],
    emits_events: [EVENTS.RELEASE_DECIDED, EVENTS.ARTIFACT_PRODUCED],
  },
  {
    id: "telemetry",
    name: "TelemetryAgent",
    role: "Emits OpenTelemetry spans/metrics/logs, cost attribution, hallucination-rate, tool-failure-rate, self-repair-rate.",
    mode: "single-shot",
    system_prompt: "You emit the OTel spans and metrics for the run. You attach correlation_id, causation_id, trace_id, span_id to every event.",
    llm_profile: "tool-use",
    tools: ["observability.span.create", "observability.metrics.emit", "audit.write"],
    guardrails: [],
    inputs_required: ["run_summary"],
    output_schema: "TelemetryEnvelope@1.0",
    handoff_targets: [],
    accepts_from: ["release-manager", "qa-regression"],
    emits_events: [EVENTS.TELEMETRY_EMITTED],
  },
];

const AGENTS_BY_ID = Object.freeze(
  AGENTS.reduce((m, a) => { m[a.id] = a; return m; }, {})
);

function listAgents() {
  return AGENTS.map(a => ({ ...a, tools: [...a.tools], guardrails: [...a.guardrails], handoff_targets: [...a.handoff_targets], accepts_from: [...a.accepts_from], emits_events: [...a.emits_events] }));
}

function getAgent(id) {
  return AGENTS_BY_ID[id] ? { ...AGENTS_BY_ID[id] } : null;
}

function validateHandoff(fromId, toId) {
  const from = AGENTS_BY_ID[fromId];
  const to = AGENTS_BY_ID[toId];
  if (!from) return { ok: false, reason: `unknown from-agent "${fromId}"` };
  if (!to) return { ok: false, reason: `unknown to-agent "${toId}"` };
  const allowedByFrom = from.handoff_targets.includes(toId);
  const allowedByTo = to.accepts_from.length === 0 || to.accepts_from.includes(fromId);
  if (!allowedByFrom) return { ok: false, reason: `"${fromId}" does not declare "${toId}" in handoff_targets` };
  if (!allowedByTo) return { ok: false, reason: `"${toId}" does not accept handoffs from "${fromId}"` };
  return { ok: true };
}

function registryIntegrity() {
  const seen = new Set();
  const issues = [];
  for (const a of AGENTS) {
    if (seen.has(a.id)) issues.push(`duplicate agent id "${a.id}"`);
    seen.add(a.id);
    if (!a.name || !a.role || !a.system_prompt) issues.push(`"${a.id}" missing required metadata`);
    for (const t of a.handoff_targets) {
      if (!AGENTS_BY_ID[t]) issues.push(`"${a.id}" → unknown handoff target "${t}"`);
    }
    for (const f of a.accepts_from) {
      if (!AGENTS_BY_ID[f]) issues.push(`"${a.id}" accepts_from unknown "${f}"`);
    }
    for (const g of a.guardrails) {
      if (!GUARDRAILS[g]) issues.push(`"${a.id}" references unknown guardrail "${g}"`);
    }
  }
  return { ok: issues.length === 0, issues, agent_count: AGENTS.length };
}

function computeHandoffGraph() {
  const edges = [];
  for (const a of AGENTS) {
    for (const t of a.handoff_targets) edges.push({ from: a.id, to: t });
  }
  return { nodes: AGENTS.map(a => ({ id: a.id, name: a.name })), edges };
}

module.exports = {
  AGENTS,
  AGENTS_BY_ID,
  GUARDRAILS,
  EVENTS,
  listAgents,
  getAgent,
  validateHandoff,
  registryIntegrity,
  computeHandoffGraph,
};

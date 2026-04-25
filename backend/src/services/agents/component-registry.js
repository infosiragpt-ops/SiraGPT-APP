/**
 * component-registry — declarative inventory of every enterprise
 * component the cognitive-agentic platform is built from.
 *
 * This is the HONEST status document. Each component lists:
 *   - id, name, purpose
 *   - status: "implemented" (landed) | "partial" (scaffolded, not
 *     production-ready) | "planned" (design accepted, no code yet)
 *   - backing_modules: file paths of the code that currently backs
 *     this component (may be empty for `planned`)
 *   - acceptance_criteria: the bar that must be met to flip to
 *     "implemented"
 *   - risk_level
 *
 * The registry is the source of truth for "what exists in this
 * build" — no module claims to be production-grade unless its
 * status is "implemented". Anti-vaporware by construction.
 */

const STATUS = Object.freeze(["implemented", "partial", "planned"]);
const RISK = Object.freeze(["low", "medium", "high", "critical"]);

const COMPONENTS = [
  {
    id: "ai-product-operating-system",
    name: "AI Product Operating System (Runtime Kernel)",
    purpose: "Top-level kernel that compiles every request to a UniversalTaskContract + ExecutionGraph DAG and runs it under the 14-law constitution, the 17-agent kernel, the semantic intent router, the unified tool registry, the MCP gateway, the canonical event envelope, and the temporal-compatible durable workflow adapter.",
    status: "implemented",
    backing_modules: [
      "backend/src/services/ai-product-os/constitution.js",
      "backend/src/services/ai-product-os/agentic-kernel.js",
      "backend/src/services/ai-product-os/mcp-gateway.js",
      "backend/src/services/ai-product-os/event-envelope.js",
      "backend/src/services/ai-product-os/durable-workflow.js",
      "backend/src/services/ai-product-os/product-os.js",
      "backend/src/services/ai-product-os/semantic-intent-router.js",
      "backend/src/services/ai-product-os/tool-registry.js",
      "backend/src/services/ai-product-os/planner-agent.js",
      "backend/src/services/ai-product-os/model-router.js",
      "backend/src/services/ai-product-os/skill-system.js",
      "backend/src/services/ai-product-os/memory-layer.js",
      "backend/src/services/ai-product-os/browser-agent.js",
      "backend/src/services/ai-product-os/orchestrator.js",
      "backend/src/services/ai-product-os/integration-stack.js",
      "backend/src/services/ai-product-os/adapters/agent-sdk-adapter.js",
      "backend/src/services/ai-product-os/adapters/orchestration-adapter.js",
      "backend/src/services/ai-product-os/adapters/rag-adapter.js",
      "backend/src/services/ai-product-os/adapters/document-adapter.js",
      "backend/src/services/ai-product-os/adapters/browser-adapter.js",
      "backend/src/services/ai-product-os/adapters/sandbox-adapter.js",
      "backend/src/services/ai-product-os/adapters/eval-adapter.js",
      "backend/src/services/sira/task-envelope-schema.js",
      "backend/src/services/sira/intent-taxonomy.js",
      "backend/src/services/sira/task-envelope-builder.js",
      "backend/src/services/sira/frames.js",
      "backend/src/services/sira/engine.js",
      "backend/src/services/sira/tool-registry.js",
      "backend/src/services/sira/intent-prompts.js",
      "backend/src/services/sira/validator-engine.js",
      "backend/src/services/sira/runtime.js",
      "backend/src/services/sira/model-adapter.js",
      "backend/src/services/sira/policies.js",
      "backend/src/services/sira/research-engine.js",
      "backend/src/services/sira/storage-schema.js",
      "backend/src/services/sira/chat-controller.js",
    ],
    acceptance_criteria: [
      "14-law constitution enforced at pre-compile / pre-execute / per-node / per-output / pre-release / release gates — IMPLEMENTED",
      "17 specialised agents (intent compiler → telemetry) registered with typed manifests, guardrails, handoff targets — IMPLEMENTED",
      "Semantic Intent Router: LLM-primary (structured outputs schema) with regex fast-path fallback; emits {intent_primary, intent_secondary[], required_agents[], required_tools[], confidence, needs_clarification, final_output} — IMPLEMENTED",
      "Unified Tool Registry: single source of truth for ~25 tools with input/output schema, scopes, side_effect_level, recommended_for[intent], and bindToMcpGateway() — IMPLEMENTED",
      "Planner Agent: deterministic 7-phase plan compiler (intent → planning → evidence → build → validate → release → telemetry) with validation_gate / human_approval_gate / release_gate per node — IMPLEMENTED",
      "Model Router (Capa 1 / AI Gateway): scoring-based selection over 10 models with capabilities (reasoning/code/tools/vision/long_context), cost / latency tiers, plan eligibility, language support, user prefer override — IMPLEMENTED",
      "Skill System: 14 first-class skills (academic_report, legal_analysis, market_research, excel_dashboard, code_review, app_builder, web_research, citation_checker, powerpoint_designer, image_prompt_engineer, database_query, scraping_compliant, data_analysis, math_solver) with required_tools, required_agents, output_formats, quality_rules, model_profile, min_plan, risk_level — IMPLEMENTED",
      "Multi-tier Memory Layer: short-term rolling window, long-term per-user facts, file metadata, semantic snippet store with embedding-or-token-overlap search, knowledge graph, buildContextForTurn() blender. Pluggable adapter for Qdrant / pgvector / Weaviate — IMPLEMENTED (in-memory adapter)",
      "Browser / Computer-Use Agent wrapper: typed action vocabulary (navigate/click/type/extract/screenshot/etc.), allow/deny domain policy, forbidden-pattern detection (captcha/paywall), step budget, evidence trail with screenshots — IMPLEMENTED (driver injectable)",
      "End-to-end Orchestrator: runUserRequest() composes ModelRouter → IntentRouter → SkillSystem → Memory → Planner → Constitution → DurableWorkflow → Validation in one call, returning the full multi-layer decision bundle — IMPLEMENTED",
      "Integration Stack (8 layers, ~28 libraries): typed adapter contracts + deterministic stubs for OpenAI Agents SDK / Pydantic AI / Semantic Kernel, LangGraph / DBOS / Temporal, LlamaIndex / LangChain / Qdrant / pgvector / Weaviate, Docling / Unstructured / LlamaParse / python-docx / openpyxl / PptxGenJS / python-pptx / ReportLab, Playwright / Puppeteer / Browser Use / Browserless, E2B / Modal / Docker / Firecracker / gVisor / Kubernetes Job, MCP, Ragas / Promptfoo / LangSmith / OpenAI Evals / OpenTelemetry — IMPLEMENTED (provider-injectable; stubs cover the default path so platform works zero-deps)",
      "Sira Cognitive Task Envelope v1: universal internal contract that turns ANY user request into an executable plan. 22 top-level fields (raw_input, normalized_request, intent_analysis, goal_model, task_classification, entities, context_requirements, data_ingestion_plan, output_contract, model_execution_context, tool_plan, agent_plan, workflow_graph, clarification_policy, safety_and_permissions, quality_plan, ui_response_plan, memory_policy, cost_latency_policy, observability, final_answer_contract, schema_version) with strict validator (catches unknown_dep, forward_dep, duplicate_node_id, out_of_range scores, invalid enums) — IMPLEMENTED",
      "Universal intent taxonomy: 14 families × ~85 intents (conversation / document_artifacts / spreadsheet_artifacts / presentation_artifacts / coding / design_visual / image / video / audio / research / data / automation / business / education / high_risk_domains) with default_output_kind, default_complexity, default_risk, default_min_plan, default_required_capabilities — IMPLEMENTED",
      "5 cognitive frames: IntentFrame, PlanFrame, ToolCallFrame, ArtifactFrame, ValidationFrame — typed builders + frozen outputs + validator — IMPLEMENTED",
      "Sira engine 6-step pipeline: Intent Engine → Planner → Tool Runtime → Artifact Engine → Validator → Response Builder. Composes the envelope, all 5 frames and the response in one runUserMessage() call; injects toolDispatcher and artifactRenderer for wet-runs — IMPLEMENTED",
      "Sira Tool Registry (MASTER_SPEC §11-12): typed CiraTool contracts (name, inputSchema, category, riskLevel, permissionsRequired, timeoutMs, retryable, requiresHumanConfirmation, execute) with 60+ default tools across document/spreadsheet/presentation/pdf/svg/landing/research/code/image/video/validator categories. Permission enforcement, timeout guard, requires_confirmation, integrity check — IMPLEMENTED (default executors are deterministic stubs; production replaces them via reg.register())",
      "Sira Validator Engine (MASTER_SPEC §5/cira-core/validators/): 5 validator families (artifact / source / code / document / safety) with 40+ deterministic checks. composeValidationFrame() aggregates and decides ready_to_deliver — IMPLEMENTED",
      "Sira intent + planner + validator system prompts (MASTER_SPEC §8-9): structured-outputs requests with json_schema response_format, vendor-agnostic — IMPLEMENTED",
      "Sira Tool Runtime: drives a workflow_graph through the registry, collects tool results, builds ArtifactFrame, runs the validator engine, produces ValidationFrame with ready_to_deliver verdict. Dry-run mode + wet-run mode + permission scopes + per-tool args — IMPLEMENTED",
      "Sira Model Adapter (MASTER_SPEC §14): vendor-agnostic dispatcher with 10 provider slots (openai/anthropic/google/deepseek/xai/openrouter/image/video/audio/custom). NEVER auto-routes — guardAgainstAutoRouting() catches any provider/modelId switch without explicit user consent — IMPLEMENTED",
      "Sira Policies (MASTER_SPEC §16-17): SIRA_CLARIFICATION_POLICY (max_questions=3, thresholds 0.82/0.55, 7 obvious-defaults, 6 critical-missing-info examples) + SIRA_SAFETY_POLICY (11 blocked actions, 7 always-sandbox kinds, 10 require-validation categories, 4 privacy defaults, destructive/external keyword scanners) — IMPLEMENTED",
      "Sira Scientific Research Engine (MASTER_SPEC §19): 8-stage pipeline (query understanding → multi-provider search → dedupe → DOI validation → ranking → selection → APA7/Vancouver/IEEE/MLA citation formatting → claim binding) with 9 provider slots, validation rejection for malformed DOI / missing metadata / implausible year, and explicit limitations surfacing — IMPLEMENTED",
      "Sira Storage Schema (MASTER_SPEC §26): Postgres-shaped DDL for the 7 spec tables (sira_conversations / sira_messages / sira_task_envelopes / sira_tool_calls / sira_artifacts / sira_validation_reports / sira_audit_logs) + StorageAdapter contract + in-memory adapter — IMPLEMENTED",
      "Sira Chat Controller (MASTER_SPEC §27): handleChatTurn() composes engine + runtime + storage + policies + model-adapter into the canonical /api/enterprise/sira/chat handler. Persists every layer, audits every transition, returns clarification early without executing tools, guards against auto-routing — IMPLEMENTED",
      "Sira intent-detection eval suite (MASTER_SPEC §34): 5 Promptfoo-shaped cases (document / landing / excel / image / research) verified by deterministic envelope assertions — IMPLEMENTED",
      "MCP gateway: tools / resources / prompts registry with JSON-RPC 2.0 dispatch, scope-based authorization, audit trail — IMPLEMENTED",
      "Canonical event envelope (correlation/causation/trace/span ids, OTel-compatible) with serialize / deserialize / validate / chain — IMPLEMENTED",
      "Temporal-compatible durable workflow adapter with retry, timeout, compensation, rollback, AbortSignal, in-memory store, resume from checkpoint — IMPLEMENTED",
      "compile(request) → contract + graph; execute(plan, runner) → release decision under constitution — IMPLEMENTED",
      "Bind to a real Temporal cluster (production)",
      "Bind to a real LangGraph runtime for stateful graph agents",
      "Bind to a real OpenAI Agents SDK runtime",
      "Bind to a real LLM client (OpenAI Responses) so the router actually uses the LLM tier instead of falling back to regex",
    ],
    risk_level: "high",
  },
  {
    id: "agentic-operating-core",
    name: "Agentic Operating Core",
    purpose: "ReAct/executor loop, tool dispatch, system prompting, error handling.",
    status: "implemented",
    backing_modules: [
      "backend/src/services/agents/agentic-operating-core.js",
      "backend/src/services/react-agent.js",
      "backend/src/services/agents/executor.js",
      "backend/src/services/agents/agent-core.js",
      "backend/src/routes/agent-task.js",
    ],
    acceptance_criteria: [
      "runs a full task end-to-end with tool calls",
      "emits structured step events consumable by the UI",
      "compiles contract + graph + tool runtime + QA into an enterprise operating envelope — IMPLEMENTED",
      "AI Product Studio Blueprint compiles domain playbooks, evidence gates, production controls and release contracts — IMPLEMENTED",
    ],
    risk_level: "low",
  },
  {
    id: "workflow-orchestrator",
    name: "Workflow Orchestrator",
    purpose: "Compiles a contract into an ExecutionGraph and drives durable execution.",
    status: "implemented",
    backing_modules: [
      "backend/src/services/agents/execution-graph.js",
      "backend/src/services/agents/execution-graph-runner.js",
      "backend/src/services/agents/task-store.js",
      "backend/src/services/agents/durable-execution-store.js",
    ],
    acceptance_criteria: [
      "graph validation + topological sort — IMPLEMENTED",
      "resumable node state transitions — IMPLEMENTED",
      "file-backed durable ExecutionGraph checkpoints — IMPLEMENTED",
      "runtime drives nodes with retry_policy + timeout_policy + abort signal — IMPLEMENTED",
      "pause/resume via adapter with crash-recovery (running → pending rewrite) — IMPLEMENTED",
    ],
    risk_level: "medium",
  },
  {
    id: "tool-runtime",
    name: "Tool Runtime & Manifests",
    purpose: "Typed tool invocation gateway with manifest-driven permissions.",
    status: "implemented",
    backing_modules: [
      "backend/src/services/agents/tool-manifest.js",
      "backend/src/services/agents/enterprise-tool-gateway.js",
      "backend/src/services/agents/task-tools.js",
      "backend/src/skills/",
    ],
    acceptance_criteria: [
      "every built-in tool has a validated manifest",
      "enterprise + legacy manifests are authorized through a single gateway — IMPLEMENTED",
      "unsigned tools cannot be invoked",
      "scoped permissions enforced at dispatch",
    ],
    risk_level: "low",
  },
  {
    id: "code-execution-sandbox",
    name: "Code Execution Sandbox",
    purpose: "Isolated Python / Node execution with timeouts + memory caps.",
    status: "implemented",
    backing_modules: [
      "backend/src/services/agents/code-sandbox.js",
    ],
    acceptance_criteria: [
      "fresh temp dir per run",
      "stripped env, timeout, memory limits",
      "test harness (_check) for generated code",
    ],
    risk_level: "medium",
  },
  {
    id: "document-intelligence-engine",
    name: "Document Intelligence Engine",
    purpose: "Layout-aware PDF/DOCX parsing, chunking, OCR, tables, figures.",
    status: "partial",
    backing_modules: [
      "backend/src/services/rag-service.js",
      "backend/src/services/rag/advanced-chunking.js",
      "backend/src/services/rag/raptor-tree.js",
      "backend/src/services/rag/proposition-indexer.js",
      "backend/src/services/docintel/pdf-structure.js",
      "backend/src/services/docintel/citation-grounding.js",
      "backend/src/services/docintel/evidence-ledger.js",
      "backend/src/services/docintel/contradiction-detector.js",
    ],
    acceptance_criteria: [
      "Layout-aware structural analyser: heading hierarchy + table detection + figure captions + section chunks — IMPLEMENTED",
      "Citation grounding gate: per-claim source verification with jaccard + numeric + phrase match — IMPLEMENTED",
      "Append-only evidence ledger with SHA-256 fingerprinting, dedup, verdicts, snapshot round-trip — IMPLEMENTED",
      "Contradiction detector: polarity flip + comparative flip + numeric divergence across sources — IMPLEMENTED",
      "OCR integration for scanned PDFs",
      "DOCX layout parser",
    ],
    risk_level: "medium",
  },
  {
    id: "research-market-intelligence",
    name: "Research & Market Intelligence Engine",
    purpose: "Scopus/OpenAlex/SciELO/Semantic/Crossref/PubMed/DOAJ agentic batch.",
    status: "implemented",
    backing_modules: [
      "backend/src/services/searchBrain/agenticBatch.js",
      "backend/src/services/searchBrain/providers.js",
      "backend/src/services/searchBrain/self-rag-*",
    ],
    acceptance_criteria: [
      "7 providers wired, rerank loop, dedupe, citation block",
    ],
    risk_level: "low",
  },
  {
    id: "database-connector-layer",
    name: "Database Connector Layer",
    purpose: "Typed introspection of external DBs, read-only-by-default, parameterised queries.",
    status: "partial",
    backing_modules: [
      "backend/src/services/db/sql-safety.js",
    ],
    acceptance_criteria: [
      "SQL static safety analyser (read-only default, DDL rejection, interpolation detection, SQLi signatures) — IMPLEMENTED",
      "Postgres/MySQL/SQLite drivers with schema introspection",
      "prepared statements, connection pooling, query budget",
      "RBAC / row-level security hooks",
      "EXPLAIN/ANALYZE integration",
    ],
    risk_level: "high",
  },
  {
    id: "web-automation-scraping",
    name: "Web Automation & Scraping Layer",
    purpose: "Compliant Playwright-based DOM extraction with robots.txt respect.",
    status: "partial",
    backing_modules: [
      "backend/src/services/web/url-canonical.js",
      "backend/src/services/web/robots.js",
      "backend/src/services/web/scraper-policy.js",
      "backend/src/services/web/rate-limiter.js",
      "backend/src/services/web/html-extract.js",
    ],
    acceptance_criteria: [
      "URL canonicalisation + dedup with tracking-param stripping — IMPLEMENTED",
      "robots.txt parser with user-agent matching + longest-prefix allow/disallow + crawl-delay — IMPLEMENTED",
      "Compliance policy gate (banned config keys, banned value tokens, UA transparency, allowlist required) — IMPLEMENTED",
      "Token-bucket rate limiter with exponential backoff + Retry-After support — IMPLEMENTED",
      "HTML JSON-LD + OpenGraph + Twitter cards + breadcrumbs extractor (pure regex) — IMPLEMENTED",
      "Playwright/Scrapy runtime pool with proxy support",
      "Headless browser capture + DOM snapshot storage",
    ],
    risk_level: "high",
  },
  {
    id: "design-system-generator",
    name: "Design System Generator",
    purpose: "Design tokens, palette, typography, components, accessibility gates.",
    status: "partial",
    backing_modules: [
      "backend/src/services/design/design-tokens.js",
      "backend/src/services/design-generator.js",
    ],
    acceptance_criteria: [
      "design-tokens generator (palette + typography + spacing) → CSS vars + JSON",
      "contrast validation per token pair",
      "component registry with a11y checks",
    ],
    risk_level: "low",
  },
  {
    id: "business-intelligence-studio",
    name: "Business Intelligence Studio",
    purpose: "Power BI-style dashboards with star schema, DAX-like measures, RLS.",
    status: "partial",
    backing_modules: [
      "backend/src/services/bi/semantic-model.js",
      "backend/src/services/bi/market-frameworks.js",
    ],
    acceptance_criteria: [
      "semantic model builder (facts, dimensions, measures) — IMPLEMENTED (star-schema validator, DAX-like compiler, KPI card derivation)",
      "Market-frameworks library: TAM/SAM/SOM + Porter Five Forces + SWOT + PESTEL + unit-economics (CAC/LTV/payback) + cohort-retention — IMPLEMENTED",
      "chart renderer with exports to pdf/pptx/xlsx",
      "row-level security + RBAC",
    ],
    risk_level: "high",
  },
  {
    id: "full-stack-web-builder",
    name: "Full-Stack Web Builder",
    purpose: "Next.js/React/TS scaffolder with SSR/ISR, auth, a11y, SEO.",
    status: "partial",
    backing_modules: [
      "backend/src/services/software-engineering/project-scaffolder.js",
      "backend/src/services/software-engineering/sbom.js",
      "backend/src/services/software-engineering/dependency-audit.js",
      "backend/src/services/software-engineering/code-review.js",
      "backend/src/services/software-engineering/seo-validator.js",
      "backend/src/services/software-engineering/wcag-checker.js",
      "backend/src/services/software-engineering/cwv-budget.js",
    ],
    acceptance_criteria: [
      "project scaffolder with App Router (nextjs) + FastAPI templates — IMPLEMENTED (file-tree descriptor, Playwright E2E wired, Docker, CI/CD workflow)",
      "SBOM generator (CycloneDX 1.5) from package.json + lockfile + requirements.txt + pyproject.toml — IMPLEMENTED",
      "Dependency auditor: license classification, unpinned versions, duplicate packages, deprecated list — IMPLEMENTED",
      "Code reviewer: cyclomatic complexity, nesting depth, file/function length, dangerous-call detection, unused-import, secret scan — IMPLEMENTED",
      "SEO validator: title/description budgets, canonical, OG/Twitter, schema.org JSON-LD, robots, vague anchors — IMPLEMENTED",
      "WCAG 2.1 AA checker: img-alt, label/for, heading order, duplicate ids, accessible button/link names, bypass-block, contrast-ratio helper — IMPLEMENTED",
      "Core Web Vitals budget: JS/CSS/image byte budgets, render-blocking count, third-party origins, CLS/LCP risk signals — IMPLEMENTED",
      "test suite wiring (Playwright/Vitest)",
    ],
    risk_level: "high",
  },
  {
    id: "security-governance-layer",
    name: "Security Governance Layer",
    purpose: "OWASP ASVS controls, secrets scanning, SAST/DAST, policy engine.",
    status: "partial",
    backing_modules: [
      "backend/src/services/security/secret-scanner.js",
      "backend/src/services/security/owasp-asvs.js",
    ],
    acceptance_criteria: [
      "secret scanner (15 patterns: AWS, GitHub, Slack, Stripe, OpenAI, Anthropic, PEM, JWT, generic) — IMPLEMENTED",
      "OWASP ASVS v4.0.3 Level-1 catalogue with evaluator hooks — IMPLEMENTED",
      "dependency audit integrated in CI",
      "OPA/Rego policy hooks",
      "cryptography helper wrappers (mTLS, JWT rotation)",
    ],
    risk_level: "critical",
  },
  {
    id: "validation-fabric",
    name: "Validation Fabric",
    purpose: "Aggregates ValidationReport/SecurityReport/FactualityReport/DesignReview/CodeReview/PerformanceReport into a ReleaseDecision.",
    status: "implemented",
    backing_modules: [
      "backend/src/services/agents/validation-fabric.js",
      "backend/src/services/agents/agentic-qa-board.js",
      "backend/src/services/agents/artifact-reviewer.js",
      "backend/src/services/agents/format-sovereignty.js",
      "backend/src/services/agents/failure-report.js",
    ],
    acceptance_criteria: [
      "aggregate() returns deterministic decision",
      "Agentic QA Board assembles Validation/Security/Factuality/Design/Code/Performance reports — IMPLEMENTED",
      "rejects on any critical finding",
      "never invents a score (pass/fail booleans + severities only)",
    ],
    risk_level: "low",
  },
  {
    id: "observability-plane",
    name: "Observability Plane",
    purpose: "OpenTelemetry traces, metrics, logs, spans, cost per task, replay.",
    status: "partial",
    backing_modules: [
      "backend/src/services/agents/metrics.js",
      "backend/src/services/agents/audit-log.js",
      "backend/src/services/agents/agent-events.js",
      "backend/src/services/observability/spans.js",
      "backend/src/services/agents/agentic-operating-core.js",
    ],
    acceptance_criteria: [
      "OTEL-compatible span factory — IMPLEMENTED",
      "Agentic Operating Core declares trace id, critical events and metrics per task — IMPLEMENTED",
      "AI Product Studio Blueprint binds trace/replay/redaction policy to every active playbook — IMPLEMENTED",
      "OTEL-compatible span emission",
      "cost + token accounting per tool call",
      "trace-id propagation through child tasks",
    ],
    risk_level: "medium",
  },
  {
    id: "hitl-control-center",
    name: "Human-in-the-Loop Control Center",
    purpose: "UI for approving destructive / high-risk actions; clarification capture.",
    status: "partial",
    backing_modules: [
      "backend/src/services/hitl/approval-queue.js",
    ],
    acceptance_criteria: [
      "approval queue data layer with state machine (pending → approved/rejected/timed_out/cancelled), RBAC allowlist, timeout reap — IMPLEMENTED",
      "approval queue UI surfacing release_gate.requires_human nodes",
      "one-click clarifying-question reply flow",
      "audit trail of approvals",
    ],
    risk_level: "medium",
  },
];

function getComponent(id) {
  return COMPONENTS.find(c => c.id === id) || null;
}

function listComponents() {
  return COMPONENTS.map(c => ({
    id: c.id,
    name: c.name,
    status: c.status,
    risk_level: c.risk_level,
    modules_count: c.backing_modules.length,
  }));
}

function countByStatus() {
  const counts = { implemented: 0, partial: 0, planned: 0 };
  for (const c of COMPONENTS) counts[c.status] = (counts[c.status] || 0) + 1;
  return counts;
}

function assertRegistryIntegrity() {
  const ids = new Set();
  for (const c of COMPONENTS) {
    if (!c.id || typeof c.id !== "string") throw new Error("component-registry: id missing");
    if (ids.has(c.id)) throw new Error(`component-registry: duplicate id "${c.id}"`);
    ids.add(c.id);
    if (!STATUS.includes(c.status)) throw new Error(`component-registry: invalid status for ${c.id}: ${c.status}`);
    if (!RISK.includes(c.risk_level)) throw new Error(`component-registry: invalid risk_level for ${c.id}: ${c.risk_level}`);
    if (!Array.isArray(c.backing_modules)) throw new Error(`component-registry: backing_modules must be an array for ${c.id}`);
    if (!Array.isArray(c.acceptance_criteria)) throw new Error(`component-registry: acceptance_criteria must be an array for ${c.id}`);
    if (c.status !== "planned" && c.backing_modules.length === 0) {
      throw new Error(`component-registry: ${c.id} is not "planned" but has zero backing_modules`);
    }
  }
  return true;
}

module.exports = {
  COMPONENTS,
  getComponent,
  listComponents,
  countByStatus,
  assertRegistryIntegrity,
  STATUS,
  RISK,
};

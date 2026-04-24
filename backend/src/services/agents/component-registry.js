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
    id: "agentic-operating-core",
    name: "Agentic Operating Core",
    purpose: "ReAct/executor loop, tool dispatch, system prompting, error handling.",
    status: "implemented",
    backing_modules: [
      "backend/src/services/react-agent.js",
      "backend/src/services/agents/executor.js",
      "backend/src/services/agents/agent-core.js",
      "backend/src/routes/agent-task.js",
    ],
    acceptance_criteria: [
      "runs a full task end-to-end with tool calls",
      "emits structured step events consumable by the UI",
    ],
    risk_level: "low",
  },
  {
    id: "workflow-orchestrator",
    name: "Workflow Orchestrator",
    purpose: "Compiles a contract into an ExecutionGraph and drives durable execution.",
    status: "partial",
    backing_modules: [
      "backend/src/services/agents/execution-graph.js",
      "backend/src/services/agents/task-store.js",
      "backend/src/services/agents/durable-execution-store.js",
    ],
    acceptance_criteria: [
      "graph validation + topological sort",
      "resumable node state transitions",
      "file-backed durable ExecutionGraph checkpoints — IMPLEMENTED",
      "durable queue backing for pause/resume across restarts",
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
    ],
    acceptance_criteria: [
      "layout-aware PDF parser with table extraction",
      "structural chunking by heading level",
      "citation grounding per chunk",
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
    ],
    acceptance_criteria: [
      "semantic model builder (facts, dimensions, measures) — IMPLEMENTED (star-schema validator, DAX-like compiler, KPI card derivation)",
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
    ],
    acceptance_criteria: [
      "project scaffolder with App Router (nextjs) + FastAPI templates — IMPLEMENTED (file-tree descriptor, Playwright E2E wired, Docker, CI/CD workflow)",
      "SEO metadata + schema.org + sitemap",
      "WCAG AA validator + Core Web Vitals check",
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
    ],
    acceptance_criteria: [
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

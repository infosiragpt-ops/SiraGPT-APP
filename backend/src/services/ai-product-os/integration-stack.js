"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * integration-stack — internal capability registry for the AI Product OS.
 *
 * This file is intentionally dependency-free. It does not vendor LangChain,
 * LiteLLM, LangGraph, Temporal, LlamaIndex, Docling, Qdrant, Playwright, etc.
 * It gives the backend a typed operational map of those capabilities so every
 * task can be resolved into the correct runtime stack before execution.
 *
 * Production binds real providers via createIntegrationStack({ providers }).
 * The default path remains deterministic and safe with in-memory stubs.
 */

const { createAgentSdkAdapter } = require("./adapters/agent-sdk-adapter");
const { createOrchestrationAdapter } = require("./adapters/orchestration-adapter");
const { createRagAdapter } = require("./adapters/rag-adapter");
const { createDocumentAdapter } = require("./adapters/document-adapter");
const { createBrowserAdapter } = require("./adapters/browser-adapter");
const { createSandboxAdapter } = require("./adapters/sandbox-adapter");
const { createEvalAdapter } = require("./adapters/eval-adapter");
const { createMcpGateway } = require("./mcp-gateway");
const { createLiteLLMGateway, PROVIDER_MANIFESTS } = require("./litellm-gateway");

const CORE_LAYER_IDS = Object.freeze([
  "model-gateway",
  "structured-outputs",
  "agent-sdk",
  "mcp",
  "eval",
  "observability",
]);

const LAYERS = [
  layer({
    id: "model-gateway",
    adapter: "modelGateway",
    label: "AI Gateway / Model Router",
    description: "Multi-provider gateway for OpenAI-shaped model calls, budgets, fallback policy, retries, cost traces, and no silent model switching.",
    capabilities: ["multi_provider_llm", "model_fallback_policy", "cost_budgeting", "latency_budgeting", "streaming", "tool_calling", "structured_outputs"],
    validation_gates: ["provider_registered", "budget_within_limits", "selected_model_preserved"],
    security_gates: ["api_key_env_only", "no_silent_provider_switch", "provider_allowlist"],
    libraries: [
      lib("litellm", "LiteLLM", "Python / Proxy", "ai-gateway"),
      lib("vercel-ai", "Vercel AI SDK", "TypeScript", "ai-sdk"),
      lib("openai-sdk", "OpenAI SDK", "Python / TS", "provider-sdk"),
      lib("anthropic-sdk", "Anthropic SDK", "Python / TS", "provider-sdk"),
      lib("google-genai", "Google GenAI SDK", "Python / TS", "provider-sdk"),
      lib("openrouter-provider", "OpenRouter provider", "TS", "provider-router"),
      lib("ollama", "Ollama", "Local", "local-models"),
      lib("vllm", "vLLM", "Python", "model-serving"),
    ],
  }),
  layer({
    id: "agent-sdk",
    adapter: "agentSdk",
    label: "Agent Runtime / Tool Calling",
    description: "Agent runtime for planning, handoffs, tools, sessions, tracing, guardrails, and typed outputs.",
    capabilities: ["agent_runtime", "handoffs", "agents_as_tools", "guardrails", "sessions", "tool_calling"],
    validation_gates: ["agent_manifest_valid", "handoff_targets_valid", "tool_contracts_valid"],
    security_gates: ["least_privilege_tools", "guardrail_precheck", "tool_scope_check"],
    libraries: [
      lib("openai-agents-sdk", "OpenAI Agents SDK", "TypeScript / Python", "agent-runtime"),
      lib("pydantic-ai", "Pydantic AI", "Python", "type-safe-agents"),
      lib("semantic-kernel", "Semantic Kernel", "C# / Python / TS", "agent-runtime"),
      lib("google-adk", "Google ADK", "Python / TS / Go / Java", "agent-runtime"),
      lib("mastra", "Mastra", "TypeScript", "agent-workflows"),
      lib("crewai", "CrewAI", "Python", "multi-agent-teams"),
    ],
  }),
  layer({
    id: "orchestration",
    adapter: "orchestration",
    label: "Graph Orchestration / Durable Execution",
    description: "Stateful graph workflows, durable execution, checkpoints, pause/resume, retries, compensation, and human-in-the-loop.",
    capabilities: ["execution_graph", "durable_workflow", "checkpointing", "retries", "compensation", "human_in_the_loop"],
    validation_gates: ["dag_valid", "no_unknown_dependencies", "retry_policy_valid", "timeout_policy_valid"],
    security_gates: ["workflow_state_persisted", "compensation_defined_for_side_effects"],
    libraries: [
      lib("langgraph", "LangGraph", "Python / TS", "stateful-agent-graphs"),
      lib("temporal", "Temporal", "Multi", "durable-workflows"),
      lib("dbos", "DBOS", "TypeScript", "durable-workflows"),
      lib("prefect", "Prefect", "Python", "workflow-orchestration"),
      lib("dagster", "Dagster", "Python", "data-orchestration"),
      lib("bullmq", "BullMQ", "TypeScript", "redis-queues"),
    ],
  }),
  layer({
    id: "rag",
    adapter: "rag",
    label: "Hybrid RAG / Memory / Knowledge",
    description: "Hybrid retrieval over private files, web data, memory, vector stores, keyword search, reranking, and evidence grounding.",
    capabilities: ["hybrid_retrieval", "embeddings", "bm25", "reranking", "metadata_filters", "citation_grounding", "memory", "knowledge_graph"],
    validation_gates: ["retrieval_hits_present", "citation_grounding", "source_quality"],
    security_gates: ["tenant_isolation", "pii_redaction", "source_allowlist"],
    libraries: [
      lib("llamaindex", "LlamaIndex", "Python / TS", "rag-framework"),
      lib("langchain", "LangChain", "Python / TS", "rag-framework"),
      lib("haystack", "Haystack", "Python", "rag-pipelines"),
      lib("qdrant", "Qdrant", "Server", "vector-store"),
      lib("pgvector", "pgvector", "Postgres extension", "vector-store"),
      lib("opensearch", "OpenSearch", "Server", "bm25-vector-search"),
      lib("sentence-transformers", "Sentence Transformers", "Python", "embeddings-rerankers"),
      lib("graphrag", "Microsoft GraphRAG", "Python", "knowledge-graph-rag"),
      lib("mem0", "mem0", "Python / TS", "agent-memory"),
      lib("zep", "Zep", "Server", "conversation-memory"),
    ],
  }),
  layer({
    id: "document",
    adapter: "document",
    label: "Document Intelligence Engine",
    description: "Layout-aware parsing, OCR, tables, figures, chunks, citations, contradiction detection, and document normalization.",
    capabilities: ["pdf_parse", "docx_parse", "pptx_parse", "xlsx_parse", "ocr", "layout_parse", "table_extraction", "chunking", "evidence_ledger"],
    validation_gates: ["file_opened", "text_extracted", "source_hash_recorded", "page_spans_preserved"],
    security_gates: ["mime_verified", "virus_scan_required", "no_original_overwrite"],
    libraries: [
      lib("docling", "Docling", "Python", "document-parser"),
      lib("markitdown", "MarkItDown", "Python", "llm-markdown"),
      lib("mineru", "MinerU", "Python", "multi-format-parser"),
      lib("unstructured", "Unstructured", "Python", "document-parser"),
      lib("pymupdf", "PyMuPDF", "Python", "pdf-parser"),
      lib("pdfplumber", "pdfplumber", "Python", "pdf-layout-tables"),
      lib("tesseract", "Tesseract OCR", "Native", "ocr"),
      lib("paddleocr", "PaddleOCR", "Python", "ocr-layout"),
      lib("mammoth", "Mammoth", "JS", "docx-to-html"),
    ],
  }),
  layer({
    id: "docx-generation",
    label: "Word / DOCX Artifact Engine",
    description: "Professional DOCX creation, templates, images, tables, APA/Vancouver/IEEE references, comments, and integrity checks.",
    capabilities: ["docx_generation", "docx_templates", "tracked_changes_read", "tables", "references", "docx_preview"],
    validation_gates: ["docx_opens", "extension_matches_docx", "required_sections_present", "references_valid"],
    security_gates: ["write_new_artifact_only", "template_injection_guard"],
    libraries: [
      lib("python-docx", "python-docx", "Python", "docx-generator"),
      lib("docxtpl", "docxtpl", "Python", "docx-templating"),
      lib("docx", "docx", "TypeScript", "docx-generator"),
      lib("docxtemplater", "Docxtemplater", "JS", "office-templating"),
      lib("docx-preview", "docx-preview", "JS", "browser-preview"),
      lib("mammoth", "Mammoth", "JS", "docx-to-html"),
    ],
  }),
  layer({
    id: "spreadsheet-generation",
    label: "Excel / Spreadsheet Artifact Engine",
    description: "XLSX/CSV generation and analysis with formulas, styles, charts, validation, cleaning, and workbook consolidation.",
    capabilities: ["xlsx_generation", "spreadsheet_analysis", "formulas", "charts", "conditional_formatting", "data_cleaning", "csv_tsv"],
    validation_gates: ["workbook_opens", "required_sheets_present", "formulas_valid", "charts_bound_to_data"],
    security_gates: ["formula_injection_guard", "read_only_source_files", "data_masking"],
    libraries: [
      lib("openpyxl", "openpyxl", "Python", "xlsx-read-write"),
      lib("xlsxwriter", "XlsxWriter", "Python", "xlsx-generation"),
      lib("pandas", "Pandas", "Python", "dataframes"),
      lib("exceljs", "ExcelJS", "JS", "xlsx-read-write"),
      lib("duckdb", "DuckDB", "Python / SQL", "local-analytics"),
      lib("polars", "Polars", "Python / Rust", "dataframes"),
    ],
  }),
  layer({
    id: "presentation-generation",
    label: "PowerPoint / Slide Artifact Engine",
    description: "PPTX generation with programmatic layouts, speaker notes, templates, visuals, and render validation.",
    capabilities: ["pptx_generation", "slide_templates", "speaker_notes", "deck_outline", "visual_suggestions", "pptx_preview"],
    validation_gates: ["pptx_opens", "slide_count_matches_plan", "notes_present_when_required", "download_card_ready"],
    security_gates: ["write_new_artifact_only", "media_mime_verified"],
    libraries: [
      lib("pptxgenjs", "PptxGenJS", "TypeScript / JS", "pptx-generator"),
      lib("python-pptx", "python-pptx", "Python", "pptx-generator"),
      lib("docxtemplater-pptx", "Docxtemplater PPTX", "JS", "pptx-templating"),
      lib("marp", "Marp", "Node", "markdown-slides"),
      lib("revealjs", "Reveal.js", "JS", "html-slides"),
      lib("decktape", "DeckTape", "Node", "slides-to-pdf"),
    ],
  }),
  layer({
    id: "pdf-generation",
    label: "PDF Artifact Engine",
    description: "PDF creation, conversion, merge/split, watermark, forms, OCR, encryption, and print-grade rendering.",
    capabilities: ["pdf_generation", "html_to_pdf", "pdf_merge_split", "pdf_watermark", "pdf_forms", "pdf_ocr", "pdf_integrity"],
    validation_gates: ["pdf_opens", "page_count_valid", "fonts_embedded_or_safe", "links_valid"],
    security_gates: ["no_external_file_fetch_without_permission", "metadata_redaction"],
    libraries: [
      lib("reportlab", "ReportLab", "Python", "pdf-generation"),
      lib("weasyprint", "WeasyPrint", "Python", "html-to-pdf"),
      lib("playwright-pdf", "Playwright PDF", "Node", "browser-rendered-pdf"),
      lib("pdfkit", "PDFKit", "Node", "pdf-generation"),
      lib("pdf-lib", "pdf-lib", "JS", "pdf-manipulation"),
      lib("pypdf", "pypdf", "Python", "pdf-manipulation"),
      lib("pikepdf", "pikepdf", "Python", "pdf-security"),
    ],
  }),
  layer({
    id: "render-preview",
    label: "Render / Preview / Visual Validation",
    description: "Preview and visual validation for DOCX, PDF, PPTX, SVG, charts, dashboards, screenshots, and split-pane artifact review.",
    capabilities: ["pdf_preview", "docx_preview", "pptx_preview", "screenshot_evidence", "svg_render", "visual_diff", "artifact_cards"],
    validation_gates: ["preview_available", "render_screenshot_captured", "artifact_card_has_download"],
    security_gates: ["sandbox_preview", "no_untrusted_script_execution"],
    libraries: [
      lib("pdfjs", "PDF.js", "JS", "pdf-renderer"),
      lib("react-pdf", "React PDF", "React", "pdf-viewer"),
      lib("docx-preview", "docx-preview", "JS", "docx-viewer"),
      lib("canvg", "canvg", "JS", "svg-renderer"),
      lib("resvg", "resvg", "Rust / CLI", "svg-renderer"),
      lib("sharp", "Sharp", "Node", "image-processing"),
      lib("playwright", "Playwright", "Node", "screenshot-validation"),
    ],
  }),
  layer({
    id: "scientific-typesetting",
    label: "Scientific Typesetting / Citations",
    description: "Math, LaTeX, Typst, Pandoc/Quarto, CSL citations, bibliography formatting, and academic PDF/DOCX pipelines.",
    capabilities: ["latex_math", "markdown_science", "csl_citations", "bibtex", "apa7", "vancouver", "quarto_reports"],
    validation_gates: ["citation_style_valid", "bibliography_entries_valid", "math_render_valid"],
    security_gates: ["latex_shell_escape_disabled", "citation_no_fake_sources"],
    libraries: [
      lib("katex", "KaTeX", "JS", "math-rendering"),
      lib("mathjax", "MathJax", "JS", "math-rendering"),
      lib("pandoc", "Pandoc", "Native", "document-conversion"),
      lib("quarto", "Quarto", "Native", "scientific-publishing"),
      lib("typst", "Typst", "Native", "typesetting"),
      lib("citeproc-js", "citeproc-js", "JS", "csl-citations"),
      lib("csl-styles", "CSL styles", "Data", "citation-styles"),
    ],
  }),
  layer({
    id: "structured-outputs",
    label: "Structured Outputs / Guardrails",
    description: "JSON Schema, Pydantic/Zod contracts, retries, validation, prompt-injection defenses, PII redaction, and output sovereignty.",
    capabilities: ["json_schema", "zod", "pydantic", "contract_validation", "guardrails", "pii_redaction", "prompt_injection_defense"],
    validation_gates: ["schema_valid", "required_fields_present", "no_unknown_enum", "repair_before_delivery"],
    security_gates: ["prompt_injection_scan", "pii_masking", "never_fake_artifacts"],
    libraries: [
      lib("zod", "Zod", "TypeScript", "schema-validation"),
      lib("pydantic", "Pydantic", "Python", "schema-validation"),
      lib("ajv", "AJV", "JS", "json-schema-validation"),
      lib("instructor", "Instructor", "Python / TS", "structured-output-retries"),
      lib("guardrails", "Guardrails AI", "Python", "io-guardrails"),
      lib("nemo-guardrails", "NeMo Guardrails", "Python", "conversation-guardrails"),
      lib("presidio", "Microsoft Presidio", "Python", "pii-redaction"),
      lib("gitleaks", "Gitleaks", "Go", "secret-scanning"),
    ],
  }),
  layer({
    id: "mcp",
    adapter: "mcp",
    label: "MCP / Tool Mesh Gateway",
    description: "Typed tool, resource, and prompt registry for databases, APIs, repositories, files, calendars, CRMs, ERPs, BI, vector stores, and external services.",
    capabilities: ["tool_registry", "mcp_tools", "mcp_resources", "mcp_prompts", "permissions", "audit_policy", "tool_schemas"],
    validation_gates: ["tool_manifest_valid", "tool_input_schema_valid", "tool_output_schema_valid"],
    security_gates: ["scope_authorization", "dangerous_tool_confirmation", "audit_log_required"],
    libraries: [
      lib("mcp-typescript-sdk", "MCP TypeScript SDK", "TypeScript", "mcp-sdk"),
      lib("mcp-python-sdk", "MCP Python SDK", "Python", "mcp-sdk"),
      lib("mcp-servers", "MCP reference servers", "Multi", "tool-servers"),
      lib("mcp-inspector", "MCP Inspector", "Node", "tool-debugging"),
      lib("langchain-mcp-adapters", "LangChain MCP adapters", "Python / TS", "mcp-adapter"),
      lib("docker-mcp-gateway", "Docker MCP Gateway", "Docker", "mcp-gateway"),
    ],
  }),
  layer({
    id: "browser",
    adapter: "browser",
    label: "Compliant Web Automation / Scraping",
    description: "Robots-aware crawling, browser automation, DOM snapshots, selector extraction, screenshots, canonicalization, rate limits, and compliant web intelligence.",
    capabilities: ["browser_automation", "structured_crawling", "robots_txt", "rate_limiting", "dom_snapshots", "jsonld_extraction", "screenshot_evidence"],
    validation_gates: ["robots_policy_checked", "dedupe_complete", "source_snapshot_stored"],
    security_gates: ["no_captcha_bypass", "no_paywall_bypass", "no_auth_bypass", "transparent_user_agent"],
    libraries: [
      lib("playwright", "Playwright", "Node / Python", "browser-driver"),
      lib("puppeteer", "Puppeteer", "Node", "browser-driver"),
      lib("scrapy", "Scrapy", "Python", "crawler"),
      lib("crawlee", "Crawlee", "TypeScript", "crawler"),
      lib("firecrawl", "Firecrawl", "Service", "agentic-web-data"),
      lib("crawl4ai", "Crawl4AI", "Python", "llm-friendly-crawler"),
      lib("browserless", "Browserless", "Service", "managed-browser"),
      lib("stagehand", "Stagehand", "TypeScript", "browser-agent"),
    ],
  }),
  layer({
    id: "database",
    label: "Database Intelligence Layer",
    description: "Schema introspection, safe SQL generation, query plans, read-only defaults, migrations, pooling, RLS, masking, and database tools.",
    capabilities: ["schema_introspection", "parameterized_sql", "explain_analyze", "transactions", "connection_pooling", "rls", "data_masking", "query_budget"],
    validation_gates: ["sql_parameterized", "query_budget_ok", "results_validated", "write_requires_confirmation"],
    security_gates: ["read_only_by_default", "sqli_prevention", "rbac_abac", "pii_masking"],
    libraries: [
      lib("postgres", "PostgreSQL", "Server", "primary-database"),
      lib("prisma", "Prisma", "TypeScript", "orm"),
      lib("drizzle", "Drizzle ORM", "TypeScript", "orm"),
      lib("sqlalchemy", "SQLAlchemy", "Python", "orm"),
      lib("alembic", "Alembic", "Python", "migrations"),
      lib("redis", "Redis", "Server", "cache-queues"),
      lib("clickhouse", "ClickHouse", "Server", "analytics-db"),
      lib("neo4j", "Neo4j", "Server", "graph-db"),
      lib("kuzu", "Kuzu", "Embedded", "graph-db"),
    ],
  }),
  layer({
    id: "data-pipelines",
    label: "ETL / Data Quality / Lineage",
    description: "Ingestion, transformation, validation, lineage, CDC, analytics pipelines, and reproducible datasets.",
    capabilities: ["etl", "elt", "data_quality", "lineage", "cdc", "dbt_models", "dataframes", "lakehouse"],
    validation_gates: ["data_quality_checks_pass", "lineage_recorded", "schema_drift_checked"],
    security_gates: ["data_minimization", "tenant_isolation", "sensitive_columns_masked"],
    libraries: [
      lib("airbyte", "Airbyte", "Server", "etl-connectors"),
      lib("dbt", "dbt", "Python / SQL", "analytics-transformations"),
      lib("great-expectations", "Great Expectations", "Python", "data-quality"),
      lib("soda-core", "Soda Core", "Python", "data-quality"),
      lib("openlineage", "OpenLineage", "Spec", "data-lineage"),
      lib("duckdb", "DuckDB", "SQL", "local-analytics"),
      lib("polars", "Polars", "Python / Rust", "dataframes"),
      lib("apache-arrow", "Apache Arrow", "Multi", "columnar-format"),
    ],
  }),
  layer({
    id: "bi-studio",
    label: "Market Intelligence / BI Studio",
    description: "Market research, competitor tracking, semantic model, KPIs, star schema, dashboards, BI exports, and executive narratives.",
    capabilities: ["market_research", "competitor_crawler", "pricing_tracker", "semantic_model", "star_schema", "dashboards", "dax_like_metrics", "exports"],
    validation_gates: ["kpi_definitions_valid", "facts_dimensions_valid", "chart_data_valid", "source_quality"],
    security_gates: ["rls_for_dashboards", "scraping_compliance", "no_fake_market_data"],
    libraries: [
      lib("superset", "Apache Superset", "Python", "bi-platform"),
      lib("metabase", "Metabase", "Server", "bi-platform"),
      lib("cube", "Cube", "TypeScript", "semantic-layer"),
      lib("evidence", "Evidence", "Markdown / SQL", "bi-as-code"),
      lib("echarts", "Apache ECharts", "JS", "charts"),
      lib("plotly", "Plotly", "Python / JS", "charts"),
      lib("recharts", "Recharts", "React", "charts"),
      lib("d3", "D3", "JS", "visualization"),
    ],
  }),
  layer({
    id: "fullstack-web-builder",
    label: "Full-Stack Web Builder",
    description: "Generate and validate Next.js/React/TypeScript apps, APIs, auth, forms, payments, dashboards, SEO, CI, tests, and deployment-ready packages.",
    capabilities: ["nextjs_app_router", "react_components", "typescript", "tailwind", "api_routes", "auth", "forms", "payments", "seo", "e2e_tests", "deployment_package"],
    validation_gates: ["typecheck_passes", "build_passes", "e2e_passes", "accessibility_passes", "seo_metadata_present"],
    security_gates: ["xss_sanitization", "csrf_protection", "rate_limiting", "authz_checks", "secret_scan"],
    libraries: [
      lib("nextjs", "Next.js", "TypeScript", "web-framework"),
      lib("react", "React", "TypeScript", "ui-framework"),
      lib("tailwindcss", "Tailwind CSS", "CSS", "styling"),
      lib("shadcn-ui", "shadcn/ui", "React", "components"),
      lib("prisma", "Prisma", "TypeScript", "orm"),
      lib("drizzle", "Drizzle ORM", "TypeScript", "orm"),
      lib("playwright", "Playwright", "Node", "e2e-tests"),
      lib("vitest", "Vitest", "TypeScript", "unit-tests"),
      lib("eslint", "ESLint", "TypeScript", "linting"),
      lib("prettier", "Prettier", "Multi", "formatting"),
    ],
  }),
  layer({
    id: "design-canvas",
    label: "Design System / Visual Artifact Compiler",
    description: "Design tokens, accessible UI kits, SVGs, diagrams, mockups, dashboards, wireframes, and visual consistency checks.",
    capabilities: ["design_tokens", "atomic_design", "svg_generation", "diagrams", "mockups", "wcag_contrast", "responsive_breakpoints", "ui_kits"],
    validation_gates: ["contrast_passes", "responsive_breakpoints_valid", "tokens_consistent", "svg_valid"],
    security_gates: ["svg_script_stripped", "asset_mime_verified"],
    libraries: [
      lib("tldraw", "tldraw", "React", "canvas"),
      lib("excalidraw", "Excalidraw", "React", "diagrams"),
      lib("react-flow", "React Flow", "React", "node-graphs"),
      lib("mermaid", "Mermaid", "JS", "diagrams"),
      lib("d2", "D2", "CLI", "diagrams"),
      lib("svgjs", "SVG.js", "JS", "svg"),
      lib("fabricjs", "Fabric.js", "JS", "canvas"),
      lib("storybook", "Storybook", "JS", "component-docs"),
    ],
  }),
  layer({
    id: "sandbox",
    adapter: "sandbox",
    label: "Secure Sandbox / Code Runner",
    description: "Isolated code execution, generated-code tests, AST analysis, semantic patches, dependency review, and artifact packaging.",
    capabilities: ["sandboxed_code", "bash", "python", "node", "ast_analysis", "dependency_review", "unit_tests", "artifact_packaging"],
    validation_gates: ["sandbox_exit_zero", "tests_pass", "no_broken_imports", "artifact_exists"],
    security_gates: ["network_policy", "timeout_policy", "memory_limit", "filesystem_isolation", "dangerous_command_block"],
    libraries: [
      lib("e2b", "E2B", "Service", "managed-sandbox"),
      lib("daytona", "Daytona", "Service", "agentic-workspace"),
      lib("docker", "Docker", "Multi", "container"),
      lib("gvisor", "gVisor", "Multi", "container-isolation"),
      lib("firecracker", "Firecracker", "Multi", "microvm"),
      lib("tree-sitter", "tree-sitter", "Native", "ast"),
      lib("esbuild", "esbuild", "Go / JS", "build"),
      lib("ruff", "Ruff", "Python", "lint-format"),
      lib("mypy", "Mypy", "Python", "typecheck"),
    ],
  }),
  layer({
    id: "eval",
    adapter: "eval",
    label: "Validation Fabric / Agentic QA Board",
    description: "Deterministic validation, LLM/RAG evals, critic agents, regression suites, factuality checks, source checks, safety tests, and release decisions.",
    capabilities: ["validation_reports", "rag_evals", "prompt_evals", "critic_agents", "red_teaming", "release_decision", "regression_tests"],
    validation_gates: ["validation_report_passes", "factuality_report_passes", "security_report_passes", "release_decision_approved"],
    security_gates: ["block_release_if_validation_fails", "no_fake_scores", "no_fake_citations"],
    libraries: [
      lib("ragas", "Ragas", "Python", "rag-eval"),
      lib("promptfoo", "Promptfoo", "Node", "prompt-eval-ci"),
      lib("deepeval", "DeepEval", "Python", "llm-eval"),
      lib("giskard", "Giskard", "Python", "ai-testing"),
      lib("phoenix", "Arize Phoenix", "Python", "llm-observability-eval"),
      lib("langfuse", "Langfuse", "Server", "llm-tracing-evals"),
      lib("openai-evals", "OpenAI Evals", "Python", "model-evals"),
      lib("playwright", "Playwright", "Node", "e2e-validation"),
    ],
  }),
  layer({
    id: "observability",
    label: "Observability Plane",
    description: "OpenTelemetry traces, metrics, logs, spans, costs, tool failures, replay, SLOs, model/tool timelines, and debugging evidence.",
    capabilities: ["otel_traces", "metrics", "logs", "spans", "cost_attribution", "tool_failure_rate", "workflow_replay", "slo_error_budget"],
    validation_gates: ["trace_id_present", "tool_calls_logged", "validation_scores_logged"],
    security_gates: ["log_redaction", "sensitive_data_not_logged"],
    libraries: [
      lib("opentelemetry-js", "OpenTelemetry JS", "JS", "telemetry"),
      lib("opentelemetry-python", "OpenTelemetry Python", "Python", "telemetry"),
      lib("prometheus", "Prometheus", "Server", "metrics"),
      lib("grafana", "Grafana", "Server", "dashboards"),
      lib("tempo", "Tempo", "Server", "traces"),
      lib("loki", "Loki", "Server", "logs"),
      lib("jaeger", "Jaeger", "Server", "traces"),
      lib("sentry", "Sentry", "Service", "errors-performance"),
      lib("langfuse", "Langfuse", "Server", "llm-tracing"),
    ],
  }),
  layer({
    id: "durable-events",
    label: "Events / Queues / Streaming Runtime",
    description: "Event-driven execution, queues, streaming analytics, replay, dead-letter queues, backpressure, and async worker coordination.",
    capabilities: ["event_streaming", "queues", "pubsub", "dlq", "replay", "backpressure", "workers", "streaming_analytics"],
    validation_gates: ["idempotency_key_present", "event_envelope_valid", "dlq_policy_defined"],
    security_gates: ["message_authentication", "tenant_partitioning", "payload_redaction"],
    libraries: [
      lib("kafka", "Apache Kafka", "Server", "event-streaming"),
      lib("nats", "NATS JetStream", "Server", "low-latency-messaging"),
      lib("rabbitmq", "RabbitMQ", "Server", "message-broker"),
      lib("redis", "Redis", "Server", "queues-cache"),
      lib("celery", "Celery", "Python", "workers"),
      lib("bullmq", "BullMQ", "TypeScript", "workers"),
      lib("temporal", "Temporal", "Multi", "durable-events"),
    ],
  }),
  layer({
    id: "cloud-native",
    label: "Cloud-Native / DevOps Runtime",
    description: "Containers, Kubernetes, GitOps, IaC, autoscaling, service mesh, object storage, canary/blue-green release, and rollback.",
    capabilities: ["docker", "kubernetes", "helm", "terraform", "gitops", "autoscaling", "service_mesh", "object_storage", "canary_release"],
    validation_gates: ["container_build_passes", "k8s_manifests_valid", "rollback_strategy_defined"],
    security_gates: ["resource_limits", "network_policies", "secrets_not_in_manifests"],
    libraries: [
      lib("docker", "Docker", "Multi", "containers"),
      lib("kubernetes", "Kubernetes", "Server", "orchestration"),
      lib("helm", "Helm", "CLI", "k8s-packaging"),
      lib("kustomize", "Kustomize", "CLI", "k8s-config"),
      lib("terraform", "Terraform", "CLI", "iac"),
      lib("argo-cd", "Argo CD", "Server", "gitops"),
      lib("keda", "KEDA", "Kubernetes", "event-autoscaling"),
      lib("istio", "Istio", "Kubernetes", "service-mesh"),
      lib("minio", "MinIO", "Server", "s3-storage"),
    ],
  }),
  layer({
    id: "security-governance",
    label: "Security Governance / Supply Chain",
    description: "Zero-trust controls, secrets, policy-as-code, ASVS, SAST/DAST, SBOM, signing, vulnerability scans, and audit immutability.",
    capabilities: ["vault_secrets", "policy_as_code", "rbac_abac", "asvs", "sast", "dast", "sbom", "image_scanning", "supply_chain_signing", "audit_logs"],
    validation_gates: ["security_report_passes", "sbom_generated", "secret_scan_passes", "dependency_scan_passes"],
    security_gates: ["least_privilege", "mTLS", "oidc_oauth2", "audit_immutable", "destructive_action_confirmation"],
    libraries: [
      lib("vault", "HashiCorp Vault", "Server", "secrets"),
      lib("opa", "Open Policy Agent", "Go", "policy-as-code"),
      lib("casbin", "Casbin", "Multi", "rbac-abac"),
      lib("owasp-asvs", "OWASP ASVS", "Standard", "security-baseline"),
      lib("semgrep", "Semgrep", "Python", "sast"),
      lib("codeql", "CodeQL", "GitHub", "code-scanning"),
      lib("trivy", "Trivy", "Go", "vulnerability-scanning"),
      lib("syft", "Syft", "Go", "sbom"),
      lib("cosign", "Cosign", "Go", "artifact-signing"),
      lib("zap", "OWASP ZAP", "Java", "dast"),
    ],
  }),
  layer({
    id: "chat-runtime",
    label: "Chat Runtime / Message Events",
    description: "Backend-only chat states, streaming messages, attachments, activity timelines, tool events, artifact status events, and history preservation.",
    capabilities: ["message_events", "streaming_chat", "attachments", "conversation_memory", "activity_timeline", "artifact_status_events", "history_preservation"],
    validation_gates: ["user_message_preserved", "attachments_resolved", "tool_events_ordered"],
    security_gates: ["attachment_url_validated", "no_ui_contract_break"],
    libraries: [
      lib("vercel-ai", "Vercel AI SDK", "TypeScript", "chat-streaming"),
      lib("assistant-ui", "assistant-ui", "React", "chat-components-reference"),
      lib("copilotkit", "CopilotKit", "React", "copilot-reference"),
      lib("ws", "ws", "Node", "websocket"),
      lib("sse", "Server-Sent Events", "HTTP", "streaming"),
    ],
  }),
];

const LAYERS_BY_ID = Object.freeze(LAYERS.reduce((m, l) => {
  m[l.id] = l;
  return m;
}, {}));

const INTENT_LAYER_MAP = Object.freeze({
  academic_document: ["document", "docx-generation", "scientific-typesetting", "rag", "pdf-generation"],
  app_generation: ["fullstack-web-builder", "sandbox", "security-governance", "cloud-native"],
  api_generation: ["fullstack-web-builder", "database", "sandbox", "security-governance"],
  bibliography_generation: ["rag", "scientific-typesetting", "eval"],
  business_plan: ["document", "docx-generation", "spreadsheet-generation", "bi-studio", "pdf-generation"],
  chart_generation: ["spreadsheet-generation", "bi-studio", "design-canvas", "render-preview"],
  code_debugging: ["sandbox", "security-governance", "eval"],
  code_generation: ["sandbox", "security-governance", "fullstack-web-builder", "eval"],
  code_review: ["sandbox", "security-governance", "eval"],
  competitive_analysis: ["rag", "browser", "data-pipelines", "bi-studio"],
  csv_processing: ["spreadsheet-generation", "data-pipelines"],
  dashboard_spreadsheet: ["spreadsheet-generation", "bi-studio", "render-preview"],
  database_query: ["database", "security-governance", "eval"],
  data_analysis: ["spreadsheet-generation", "data-pipelines", "bi-studio", "sandbox"],
  data_cleaning: ["spreadsheet-generation", "data-pipelines"],
  diagram_generation: ["design-canvas", "render-preview"],
  docx_generation: ["document", "docx-generation", "render-preview"],
  doi_validation: ["rag", "scientific-typesetting", "eval"],
  excel_dashboard: ["spreadsheet-generation", "bi-studio", "render-preview"],
  frontend_component: ["fullstack-web-builder", "design-canvas", "sandbox"],
  image_generation: ["design-canvas", "render-preview", "eval"],
  landing_page_generation: ["fullstack-web-builder", "design-canvas", "sandbox", "eval"],
  market_research: ["rag", "browser", "data-pipelines", "bi-studio", "pdf-generation", "presentation-generation"],
  pdf_generation: ["document", "pdf-generation", "render-preview"],
  pptx_generation: ["presentation-generation", "render-preview", "design-canvas"],
  presentation_artifacts: ["presentation-generation", "render-preview", "design-canvas"],
  professional_document_generation: ["document", "docx-generation", "pdf-generation", "scientific-typesetting", "rag"],
  report_generation: ["document", "docx-generation", "pdf-generation", "rag"],
  scientific_research: ["rag", "scientific-typesetting", "browser", "eval"],
  source_validation: ["rag", "scientific-typesetting", "eval"],
  spreadsheet_analysis: ["spreadsheet-generation", "data-pipelines", "bi-studio"],
  svg_generation: ["design-canvas", "render-preview"],
  video_generation: ["render-preview", "design-canvas", "eval"],
  web_app_generation: ["fullstack-web-builder", "database", "sandbox", "security-governance", "cloud-native"],
  web_research: ["rag", "browser", "eval"],
  web_scraping: ["browser", "data-pipelines", "security-governance"],
  xlsx_generation: ["spreadsheet-generation", "render-preview"],
});

const FAMILY_LAYER_MAP = Object.freeze({
  artifact_creation: ["document", "render-preview"],
  code_artifact_creation: ["fullstack-web-builder", "sandbox", "security-governance"],
  conversation: ["chat-runtime"],
  data: ["data-pipelines", "spreadsheet-generation"],
  document_artifacts: ["document", "docx-generation", "pdf-generation"],
  high_risk_domains: ["security-governance", "eval"],
  research: ["rag", "browser", "eval"],
  software_artifact_creation: ["fullstack-web-builder", "database", "sandbox", "security-governance", "cloud-native"],
  spreadsheet_artifacts: ["spreadsheet-generation", "bi-studio"],
  visual_generation: ["design-canvas", "render-preview"],
});

const FORMAT_LAYER_MAP = Object.freeze({
  csv: ["spreadsheet-generation", "data-pipelines"],
  doc: ["document", "docx-generation"],
  docx: ["document", "docx-generation", "render-preview"],
  html: ["fullstack-web-builder", "render-preview"],
  json: ["structured-outputs"],
  md: ["document", "scientific-typesetting"],
  pdf: ["document", "pdf-generation", "render-preview"],
  png: ["render-preview", "design-canvas"],
  ppt: ["presentation-generation", "render-preview"],
  pptx: ["presentation-generation", "render-preview"],
  svg: ["design-canvas", "render-preview"],
  tsx: ["fullstack-web-builder", "sandbox"],
  xlsx: ["spreadsheet-generation", "render-preview"],
  zip: ["sandbox", "fullstack-web-builder"],
});

const TOOL_LAYER_RULES = Object.freeze([
  [/docx|word|document|citation|apa|vancouver/i, ["document", "docx-generation", "scientific-typesetting"]],
  [/xlsx|excel|spreadsheet|csv|chart|formula/i, ["spreadsheet-generation", "data-pipelines", "bi-studio"]],
  [/ppt|slide|powerpoint|deck/i, ["presentation-generation", "render-preview"]],
  [/pdf|ocr/i, ["document", "pdf-generation", "render-preview"]],
  [/web_search|search|doi|source|rag|retriever/i, ["rag", "browser", "eval"]],
  [/browser|scrap|crawl|playwright|puppeteer/i, ["browser", "security-governance"]],
  [/sql|database|postgres|prisma|drizzle/i, ["database", "security-governance"]],
  [/code|sandbox|build|test|lint|zip/i, ["sandbox", "fullstack-web-builder", "security-governance"]],
  [/image|svg|diagram|design|logo/i, ["design-canvas", "render-preview"]],
  [/dashboard|bi|market|pricing|competitor/i, ["bi-studio", "data-pipelines", "rag"]],
]);

const LIBRARY_RUNTIME_REQUIREMENTS = Object.freeze({
  "litellm": { python: ["litellm"], env_any: ["LITELLM_PROXY_URL", "LITELLM_HOST"], external: true },
  "vercel-ai": { npm: ["ai"] },
  "openai-sdk": { npm: ["openai"], env_any: ["OPENAI_API_KEY"] },
  "anthropic-sdk": { npm: ["@anthropic-ai/sdk"], env_any: ["ANTHROPIC_API_KEY"] },
  "google-genai": { npm: ["@google/genai", "@google/generative-ai"], env_any: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
  "openrouter-provider": { env_any: ["OPENROUTER_API_KEY"], external: true },
  "ollama": { env_any: ["OLLAMA_HOST"], external: true },
  "vllm": { env_any: ["VLLM_BASE_URL"], external: true },

  "openai-agents-sdk": { npm: ["@openai/agents"], python: ["openai-agents"], env_any: ["OPENAI_API_KEY"] },
  "pydantic-ai": { python: ["pydantic-ai"], external: true },
  "semantic-kernel": { npm: ["semantic-kernel"], python: ["semantic-kernel"], external: true },
  "google-adk": { npm: ["@google/adk"], python: ["google-adk"], external: true },
  "mastra": { npm: ["@mastra/core"] },
  "crewai": { python: ["crewai"], external: true },

  "langgraph": { npm: ["@langchain/langgraph"], python: ["langgraph"], external: true },
  "temporal": { npm: ["@temporalio/client", "@temporalio/worker"], env_any: ["TEMPORAL_ADDRESS"], external: true },
  "dbos": { npm: ["@dbos-inc/dbos-sdk"] },
  "prefect": { python: ["prefect"], external: true },
  "dagster": { python: ["dagster"], external: true },
  "bullmq": { npm: ["bullmq"] },

  "llamaindex": { npm: ["llamaindex"], python: ["llama-index"], external: true },
  "langchain": { npm: ["langchain", "@langchain/core"], python: ["langchain"], external: true },
  "haystack": { python: ["haystack-ai"], external: true },
  "qdrant": { env_any: ["QDRANT_URL"], external: true },
  "pgvector": { env_any: ["DATABASE_URL", "POSTGRES_URL"], external: true },
  "opensearch": { env_any: ["OPENSEARCH_URL"], external: true },
  "sentence-transformers": { python: ["sentence-transformers"], external: true },
  "graphrag": { python: ["graphrag"], external: true },
  "mem0": { npm: ["mem0ai"], python: ["mem0ai"], external: true },
  "zep": { env_any: ["ZEP_API_URL", "ZEP_API_KEY"], external: true },

  "docling": { python: ["docling"], external: true },
  "markitdown": { python: ["markitdown"], external: true },
  "mineru": { python: ["mineru"], external: true },
  "unstructured": { python: ["unstructured"], external: true },
  "pymupdf": { python: ["pymupdf"], external: true },
  "pdfplumber": { python: ["pdfplumber"], external: true },
  "tesseract": { npm: ["tesseract.js"], cli: ["tesseract"] },
  "paddleocr": { python: ["paddleocr"], external: true },
  "mammoth": { npm: ["mammoth"] },

  "python-docx": { python: ["python-docx"], external: true },
  "docxtpl": { python: ["docxtpl"], external: true },
  "docx": { npm: ["docx"] },
  "docxtemplater": { npm: ["docxtemplater"] },
  "docxtemplater-pptx": { npm: ["docxtemplater"] },
  "docx-preview": { npm: ["docx-preview"] },

  "openpyxl": { python: ["openpyxl"], external: true },
  "xlsxwriter": { python: ["XlsxWriter"], external: true },
  "pandas": { python: ["pandas"], external: true },
  "exceljs": { npm: ["exceljs"] },
  "duckdb": { npm: ["duckdb"], python: ["duckdb"], external: true },
  "polars": { npm: ["nodejs-polars"], python: ["polars"], external: true },

  "pptxgenjs": { npm: ["pptxgenjs"] },
  "python-pptx": { python: ["python-pptx"], external: true },
  "marp": { npm: ["@marp-team/marp-cli"] },
  "revealjs": { npm: ["reveal.js"] },
  "decktape": { npm: ["decktape"] },

  "reportlab": { python: ["reportlab"], external: true },
  "weasyprint": { python: ["weasyprint"], external: true },
  "playwright-pdf": { npm: ["playwright", "@playwright/test"] },
  "pdfkit": { npm: ["pdfkit"] },
  "pdf-lib": { npm: ["pdf-lib"] },
  "pypdf": { python: ["pypdf"], external: true },
  "pikepdf": { python: ["pikepdf"], external: true },
  "pdfjs": { npm: ["pdfjs-dist"] },
  "react-pdf": { npm: ["react-pdf", "@react-pdf/renderer"] },
  "canvg": { npm: ["canvg"] },
  "resvg": { npm: ["@resvg/resvg-js"], cli: ["resvg"] },
  "sharp": { npm: ["sharp"] },

  "katex": { npm: ["katex"] },
  "mathjax": { npm: ["mathjax"] },
  "pandoc": { npm: ["node-pandoc"], cli: ["pandoc"] },
  "quarto": { cli: ["quarto"], external: true },
  "typst": { cli: ["typst"], external: true },
  "citeproc-js": { npm: ["citeproc"] },
  "csl-styles": { reference: true },
  "zod": { npm: ["zod"] },
  "pydantic": { python: ["pydantic"], external: true },
  "ajv": { npm: ["ajv"] },
  "instructor": { npm: ["@instructor-ai/instructor"], python: ["instructor"], external: true },
  "guardrails": { python: ["guardrails-ai"], external: true },
  "nemo-guardrails": { python: ["nemoguardrails"], external: true },
  "presidio": { python: ["presidio-analyzer", "presidio-anonymizer"], external: true },
  "gitleaks": { cli: ["gitleaks"], external: true },

  "mcp-typescript-sdk": { npm: ["@modelcontextprotocol/sdk"] },
  "mcp-python-sdk": { python: ["mcp"], external: true },
  "mcp-servers": { external: true },
  "mcp-inspector": { npm: ["@modelcontextprotocol/inspector"] },
  "langchain-mcp-adapters": { npm: ["@langchain/mcp-adapters"], python: ["langchain-mcp-adapters"], external: true },
  "docker-mcp-gateway": { env_any: ["DOCKER_HOST"], external: true },

  "playwright": { npm: ["playwright", "@playwright/test"] },
  "puppeteer": { npm: ["puppeteer"] },
  "scrapy": { python: ["scrapy"], external: true },
  "crawlee": { npm: ["crawlee"] },
  "firecrawl": { npm: ["@mendable/firecrawl-js"], env_any: ["FIRECRAWL_API_KEY"], external: true },
  "crawl4ai": { python: ["crawl4ai"], external: true },
  "browserless": { env_any: ["BROWSERLESS_URL", "BROWSERLESS_API_KEY"], external: true },
  "stagehand": { npm: ["@browserbasehq/stagehand"], env_any: ["BROWSERBASE_API_KEY"], external: true },

  "postgres": { env_any: ["DATABASE_URL", "POSTGRES_URL"], external: true },
  "prisma": { npm: ["prisma", "@prisma/client"], env_any: ["DATABASE_URL"] },
  "drizzle": { npm: ["drizzle-orm"] },
  "sqlalchemy": { python: ["sqlalchemy"], external: true },
  "alembic": { python: ["alembic"], external: true },
  "redis": { npm: ["redis", "ioredis"], env_any: ["REDIS_URL"], external: true },
  "clickhouse": { npm: ["@clickhouse/client"], env_any: ["CLICKHOUSE_URL"], external: true },
  "neo4j": { npm: ["neo4j-driver"], env_any: ["NEO4J_URI"], external: true },
  "kuzu": { npm: ["kuzu"] },

  "airbyte": { env_any: ["AIRBYTE_API_URL"], external: true },
  "dbt": { python: ["dbt-core"], external: true },
  "great-expectations": { python: ["great-expectations"], external: true },
  "soda-core": { python: ["soda-core"], external: true },
  "openlineage": { python: ["openlineage-python"], external: true },
  "apache-arrow": { npm: ["apache-arrow"], python: ["pyarrow"], external: true },
  "superset": { env_any: ["SUPERSET_URL"], external: true },
  "metabase": { env_any: ["METABASE_URL"], external: true },
  "cube": { npm: ["@cubejs-client/core"], env_any: ["CUBEJS_API_URL"], external: true },
  "evidence": { npm: ["@evidence-dev/evidence"] },
  "echarts": { npm: ["echarts"] },
  "plotly": { npm: ["plotly.js", "plotly.js-basic-dist-min", "react-plotly.js"] },
  "recharts": { npm: ["recharts"] },
  "d3": { npm: ["d3"] },

  "nextjs": { npm: ["next"] },
  "react": { npm: ["react", "react-dom"] },
  "tailwindcss": { npm: ["tailwindcss"] },
  "shadcn-ui": { reference: true },
  "vitest": { npm: ["vitest"] },
  "eslint": { npm: ["eslint"] },
  "prettier": { npm: ["prettier"] },
  "tldraw": { npm: ["tldraw"] },
  "excalidraw": { npm: ["@excalidraw/excalidraw"] },
  "react-flow": { npm: ["@xyflow/react", "reactflow"] },
  "mermaid": { npm: ["mermaid"] },
  "d2": { cli: ["d2"], external: true },
  "svgjs": { npm: ["@svgdotjs/svg.js"] },
  "fabricjs": { npm: ["fabric", "fabricjs"] },
  "storybook": { npm: ["storybook", "@storybook/react"] },

  "e2b": { npm: ["e2b"], env_any: ["E2B_API_KEY"], external: true },
  "daytona": { env_any: ["DAYTONA_API_KEY"], external: true },
  "docker": { env_any: ["DOCKER_HOST"], external: true },
  "gvisor": { external: true },
  "firecracker": { external: true },
  "tree-sitter": { npm: ["tree-sitter"] },
  "esbuild": { npm: ["esbuild"] },
  "ruff": { cli: ["ruff"], external: true },
  "mypy": { python: ["mypy"], external: true },

  "ragas": { python: ["ragas"], external: true },
  "promptfoo": { npm: ["promptfoo"] },
  "deepeval": { python: ["deepeval"], external: true },
  "giskard": { python: ["giskard"], external: true },
  "phoenix": { python: ["arize-phoenix"], external: true },
  "langfuse": { npm: ["langfuse"], python: ["langfuse"], env_any: ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"], external: true },
  "openai-evals": { python: ["evals"], external: true },

  "opentelemetry-js": { npm: ["@opentelemetry/api", "@opentelemetry/sdk-node"] },
  "opentelemetry-python": { python: ["opentelemetry-api", "opentelemetry-sdk"], external: true },
  "prometheus": { env_any: ["PROMETHEUS_URL"], external: true },
  "grafana": { env_any: ["GRAFANA_URL"], external: true },
  "tempo": { env_any: ["TEMPO_URL"], external: true },
  "loki": { env_any: ["LOKI_URL"], external: true },
  "jaeger": { env_any: ["JAEGER_ENDPOINT"], external: true },
  "sentry": { npm: ["@sentry/node", "@sentry/nextjs"], env_any: ["SENTRY_DSN"], external: true },

  "kafka": { npm: ["kafkajs"], env_any: ["KAFKA_BROKERS"], external: true },
  "nats": { npm: ["nats"], env_any: ["NATS_URL"], external: true },
  "rabbitmq": { npm: ["amqplib"], env_any: ["RABBITMQ_URL", "AMQP_URL"], external: true },
  "celery": { python: ["celery"], external: true },

  "kubernetes": { npm: ["@kubernetes/client-node"], env_any: ["KUBECONFIG"], external: true },
  "helm": { cli: ["helm"], external: true },
  "kustomize": { cli: ["kustomize"], external: true },
  "terraform": { cli: ["terraform"], external: true },
  "argo-cd": { env_any: ["ARGOCD_SERVER"], external: true },
  "keda": { external: true },
  "istio": { external: true },
  "minio": { npm: ["minio"], env_any: ["MINIO_ENDPOINT"], external: true },

  "vault": { npm: ["node-vault"], env_any: ["VAULT_ADDR"], external: true },
  "opa": { cli: ["opa"], external: true },
  "casbin": { npm: ["casbin"] },
  "owasp-asvs": { reference: true },
  "semgrep": { cli: ["semgrep"], external: true },
  "codeql": { external: true },
  "trivy": { cli: ["trivy"], external: true },
  "syft": { cli: ["syft"], external: true },
  "cosign": { cli: ["cosign"], external: true },
  "zap": { external: true },

  "assistant-ui": { npm: ["@assistant-ui/react"] },
  "copilotkit": { npm: ["@copilotkit/react-core"] },
  "ws": { npm: ["ws"] },
  "sse": { built_in: true },
});

function createIntegrationStack({ providers = {}, vendors = {}, mcpAuditor = null, telemetry = null } = {}) {
  const modelGatewayCore = createLiteLLMGateway({
    providers: providers.modelProviders || providers.models || {},
    telemetry: telemetry || providers.telemetry,
  });
  const modelGateway = {
    vendor: vendors.modelGateway || "sira-internal-litellm",
    createGatewayPlan: modelGatewayCore.createGatewayPlan,
    dispatch: modelGatewayCore.dispatch,
    capabilities() {
      return {
        vendor: this.vendor,
        providers: Object.keys(PROVIDER_MANIFESTS),
        request_format: "openai_chat_completions",
        fallback_requires_explicit_authorization: true,
        cost_budgeting: true,
      };
    },
  };
  const agentSdk = createAgentSdkAdapter({ provider: providers.agentSdk, vendor: vendors.agentSdk || "stub" });
  const orchestration = createOrchestrationAdapter({ provider: providers.orchestration, vendor: vendors.orchestration || "stub" });
  const rag = createRagAdapter({ provider: providers.rag, vendor: vendors.rag || "stub" });
  const document = createDocumentAdapter({ provider: providers.document, vendor: vendors.document || "stub" });
  const browser = createBrowserAdapter({ provider: providers.browser, vendor: vendors.browser || "stub" });
  const sandbox = createSandboxAdapter({ provider: providers.sandbox, vendor: vendors.sandbox || "stub" });
  const mcp = createMcpGateway({ auditor: mcpAuditor });
  const evals = createEvalAdapter({ provider: providers.eval, vendor: vendors.eval || "stub" });
  const allAdapters = { modelGateway, agentSdk, orchestration, rag, document, browser, sandbox, mcp, evals };

  function status() {
    return {
      version: "2.0",
      generated_at: new Date().toISOString(),
      layer_count: LAYERS.length,
      library_count: LAYERS.reduce((s, l) => s + l.libraries.length, 0),
      layers: LAYERS.map((layerDef) => {
        const adapter = pickAdapter(layerDef.id, allAdapters);
        const key = adapterKey(layerDef.id);
        const providerBound = Boolean(providers[key] || (key === "modelGateway" && (providers.modelProviders || providers.models)));
        const stub = layerDef.adapter === "mcp" ? false : !providerBound && layerDef.adapter !== "modelGateway";
        return {
          id: layerDef.id,
          label: layerDef.label,
          description: layerDef.description,
          tags: [...layerDef.tags],
          capabilities: [...layerDef.capabilities],
          validation_gates: [...layerDef.validation_gates],
          security_gates: [...layerDef.security_gates],
          runtime_state: adapter ? (stub ? "stub" : "bound") : "capability_only",
          libraries: layerDef.libraries.map((library) => ({
            ...library,
            bound: Boolean(adapter && !stub && adapter.vendor === library.id),
          })),
          adapter: adapter ? {
            vendor: adapter.vendor || (layerDef.adapter === "mcp" ? "sira-mcp-gateway" : "capability-only"),
            stub,
            capabilities: typeof adapter.capabilities === "function" ? adapter.capabilities() : null,
          } : null,
        };
      }),
    };
  }

  function manifest() {
    return LAYERS.map(cloneLayer);
  }

  function integrity() {
    return validateManifest();
  }

  function resolveExecutionStack(input = {}) {
    return buildExecutionStackPlan(input, status());
  }

  function dependencyReadiness(input = {}, options = {}) {
    return buildDependencyReadiness(input, {
      ...options,
      runtimeStatus: options.runtimeStatus || status(),
    });
  }

  return {
    modelGateway, agentSdk, orchestration, rag, document, browser, sandbox, mcp, eval: evals,
    manifest, status, integrity, resolveExecutionStack, dependencyReadiness,
    LAYERS, LAYERS_BY_ID,
  };
}

function buildExecutionStackPlan(input = {}, runtimeStatus = null) {
  const normalized = normalizeExecutionInput(input);
  const selectedIds = selectLayerIds(normalized);
  const layers = selectedIds
    .map((id) => LAYERS_BY_ID[id])
    .filter(Boolean)
    .map((layerDef) => {
      const runtime = runtimeStatus?.layers?.find((item) => item.id === layerDef.id);
      return {
        id: layerDef.id,
        label: layerDef.label,
        runtime_state: runtime?.runtime_state || "unknown",
        capabilities: [...layerDef.capabilities],
        validation_gates: [...layerDef.validation_gates],
        security_gates: [...layerDef.security_gates],
        primary_libraries: layerDef.libraries.slice(0, 5).map((library) => library.id),
      };
    });

  const validationGates = unique(layers.flatMap((item) => item.validation_gates));
  const securityGates = unique(layers.flatMap((item) => item.security_gates));
  const requiredLibraries = unique(layers.flatMap((item) => item.primary_libraries));
  const capabilityOnly = layers.filter((item) => item.runtime_state === "capability_only").map((item) => item.id);
  const stubs = layers.filter((item) => item.runtime_state === "stub").map((item) => item.id);

  return {
    schema_version: "sira.integration_execution_stack.v1",
    request_id: normalized.request_id || null,
    primary_intent: normalized.primary_intent || null,
    secondary_intents: normalized.secondary_intents,
    task_family: normalized.task_family || null,
    output_formats: normalized.output_formats,
    tool_names: normalized.tool_names,
    layers,
    required_libraries: requiredLibraries,
    validation_gates: validationGates,
    security_gates: securityGates,
    missing_bindings: unique([...capabilityOnly, ...stubs]),
    release_gate: {
      require_contract_before_execution: true,
      require_tool_registry_selection: true,
      block_release_if_validation_fails: true,
      never_fake_artifacts: true,
      never_fake_citations: true,
    },
    execution_notes: buildExecutionNotes({ normalized, layers, stubs, capabilityOnly }),
  };
}

function buildDependencyReadiness(input = {}, options = {}) {
  const runtimeStatus = options.runtimeStatus || null;
  const plan = buildExecutionStackPlan(input, runtimeStatus);
  const inventory = options.inventory || loadPackageInventory({
    cwd: options.cwd || process.cwd(),
    packageManifests: options.packageManifests,
  });
  const env = options.env || process.env || {};

  const layers = plan.layers.map((planLayer) => {
    const layerDef = LAYERS_BY_ID[planLayer.id];
    const libraries = (layerDef?.libraries || []).map((library) => inspectLibraryReadiness(library, inventory, env));
    const counts = countLibraryStates(libraries);
    const operationalStatus = layerOperationalStatus(planLayer, counts);
    return {
      id: planLayer.id,
      label: planLayer.label,
      runtime_state: planLayer.runtime_state,
      operational_status: operationalStatus,
      readiness_score: libraries.length ? round2((counts.ready + counts.configured + counts.reference_only) / libraries.length) : 0,
      ready_libraries: counts.ready + counts.configured + counts.reference_only,
      missing_libraries: counts.missing,
      partial_libraries: counts.partial,
      external_required: counts.external_required,
      env_missing: unique(libraries.flatMap((item) => item.env_missing || [])),
      libraries,
      wet_run_blocked: isWetRunBlocked(planLayer, counts, operationalStatus),
    };
  });

  const allLibraries = layers.flatMap((layer) => layer.libraries);
  const summary = countReadinessSummary(layers, allLibraries, inventory);
  const blockers = layers
    .filter((layer) => layer.wet_run_blocked)
    .map((layer) => ({
      layer_id: layer.id,
      reason: layer.operational_status,
      runtime_state: layer.runtime_state,
      missing_libraries: layer.libraries
        .filter((library) => ["missing", "external_required", "partial"].includes(library.status))
        .slice(0, 8)
        .map((library) => library.id),
      env_missing: layer.env_missing,
    }));

  return {
    schema_version: "sira.integration_dependency_readiness.v1",
    generated_at: new Date().toISOString(),
    execution_stack: plan,
    package_inventory: {
      package_files: inventory.package_files,
      package_count: Object.keys(inventory.packages).length,
    },
    summary,
    layers,
    blockers,
    release_gate: {
      ready_for_dry_run: true,
      ready_for_wet_run: blockers.length === 0,
      never_claim_missing_tools: true,
      do_not_expose_secret_values: true,
    },
  };
}

function inspectLibraryReadiness(library, inventory, env) {
  const requirement = getRuntimeRequirement(library);
  const npmCandidates = requirement.npm || [];
  const installed = npmCandidates
    .filter((name) => inventory.packages[name])
    .map((name) => ({
      package: name,
      scope: inventory.packages[name].scopes,
      dependency_type: inventory.packages[name].dependency_types,
    }));
  const envMissing = missingEnv(requirement, env);

  let status = "missing";
  if (requirement.built_in) status = "ready";
  else if (requirement.reference) status = "reference_only";
  else if (installed.length > 0 && envMissing.length === 0) status = "ready";
  else if (installed.length > 0 && envMissing.length > 0) status = "partial";
  else if ((requirement.env_any || []).some((name) => hasEnv(env, name)) || (requirement.env_all || []).length > 0 && envMissing.length === 0) status = "configured";
  else if ((requirement.external || requirement.python || requirement.cli || requirement.service) && npmCandidates.length === 0) status = "external_required";

  return {
    id: library.id,
    name: library.name,
    role: library.role,
    language: library.language,
    status,
    npm_candidates: npmCandidates,
    installed_packages: installed,
    python_candidates: requirement.python || [],
    cli_candidates: requirement.cli || [],
    env_required: unique([...(requirement.env_any || []), ...(requirement.env_all || [])]),
    env_missing: envMissing,
    external_required: Boolean(requirement.external || requirement.service),
    note: readinessNote(status, requirement),
  };
}

function getRuntimeRequirement(library) {
  const explicit = LIBRARY_RUNTIME_REQUIREMENTS[library.id];
  if (explicit) return explicit;
  const language = normalizeTerm(library.language);
  if (/(type_script|typescript|javascript|js|node|react)/.test(language)) {
    return { npm: inferNpmCandidates(library) };
  }
  if (/python/.test(language)) {
    return { python: [library.id], external: true };
  }
  if (/(server|service|native|cli|postgres_extension|standard|data)/.test(language) || /server|service|native|cli|standard/.test(normalizeTerm(library.role))) {
    return { external: true };
  }
  return { reference: true };
}

function inferNpmCandidates(library) {
  const id = String(library.id || "").trim();
  const name = String(library.name || "").trim().toLowerCase().replace(/\s+/g, "-");
  return unique([id, name].filter(Boolean));
}

function loadPackageInventory({ cwd = process.cwd(), packageManifests = null } = {}) {
  const packages = {};
  const packageFiles = [];
  const manifests = packageManifests ? normalizePackageManifests(packageManifests) : readPackageManifests(cwd);

  for (const { scope, file, manifest } of manifests) {
    if (!manifest || typeof manifest !== "object") continue;
    if (file) packageFiles.push(file);
    for (const dependencyType of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, version] of Object.entries(manifest[dependencyType] || {})) {
        if (!packages[name]) {
          packages[name] = { version, scopes: [], dependency_types: [] };
        }
        if (!packages[name].scopes.includes(scope)) packages[name].scopes.push(scope);
        if (!packages[name].dependency_types.includes(dependencyType)) packages[name].dependency_types.push(dependencyType);
      }
    }
  }

  return {
    packages,
    package_files: unique(packageFiles),
  };
}

function normalizePackageManifests(packageManifests) {
  if (Array.isArray(packageManifests)) {
    return packageManifests.map((item, index) => ({
      scope: item.scope || `manifest_${index + 1}`,
      file: item.file || null,
      manifest: item.manifest || item,
    }));
  }
  return Object.entries(packageManifests || {}).map(([scope, manifest]) => ({
    scope,
    file: null,
    manifest,
  }));
}

function readPackageManifests(cwd) {
  const candidates = [
    path.join(cwd, "package.json"),
    path.join(cwd, "backend", "package.json"),
    path.join(cwd, "..", "package.json"),
    path.join(cwd, "..", "backend", "package.json"),
  ];
  const seen = new Set();
  const manifests = [];
  for (const candidate of candidates) {
    const file = path.resolve(candidate);
    if (seen.has(file)) continue;
    seen.add(file);
    const manifest = readJsonSafe(file);
    if (!manifest) continue;
    manifests.push({
      scope: file.endsWith(`${path.sep}backend${path.sep}package.json`) ? "backend" : "root",
      file,
      manifest,
    });
  }
  return manifests;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_err) {
    return null;
  }
}

function missingEnv(requirement, env) {
  const missing = [];
  const envAny = requirement.env_any || [];
  if (envAny.length > 0 && !envAny.some((name) => hasEnv(env, name))) {
    missing.push(...envAny);
  }
  for (const name of requirement.env_all || []) {
    if (!hasEnv(env, name)) missing.push(name);
  }
  return unique(missing);
}

function hasEnv(env, name) {
  return Boolean(env && Object.prototype.hasOwnProperty.call(env, name) && String(env[name] || "").trim() !== "");
}

function countLibraryStates(libraries) {
  return libraries.reduce((acc, library) => {
    acc[library.status] = (acc[library.status] || 0) + 1;
    return acc;
  }, { ready: 0, configured: 0, partial: 0, missing: 0, external_required: 0, reference_only: 0 });
}

function layerOperationalStatus(planLayer, counts) {
  if (planLayer.runtime_state === "bound") return "bound";
  if ((counts.ready + counts.configured + counts.reference_only) > 0) {
    return planLayer.runtime_state === "stub" ? "package_ready_stub_adapter" : "package_ready";
  }
  if (planLayer.runtime_state === "stub") return "stub_runtime_requires_binding";
  if (counts.external_required > 0 || counts.partial > 0) return "needs_external_binding";
  return "missing_runtime_dependency";
}

function isWetRunBlocked(planLayer, counts, operationalStatus) {
  if (planLayer.runtime_state === "stub" && (counts.ready + counts.configured) === 0) return true;
  return ["stub_runtime_requires_binding", "needs_external_binding", "missing_runtime_dependency"].includes(operationalStatus);
}

function countReadinessSummary(layers, allLibraries, inventory) {
  const states = countLibraryStates(allLibraries);
  return {
    selected_layers: layers.length,
    package_files_detected: inventory.package_files.length,
    packages_detected: Object.keys(inventory.packages).length,
    ready_libraries: states.ready + states.configured + states.reference_only,
    partial_libraries: states.partial,
    missing_libraries: states.missing,
    external_required_libraries: states.external_required,
    wet_run_blockers: layers.filter((layer) => layer.wet_run_blocked).length,
    env_missing: unique(allLibraries.flatMap((library) => library.env_missing || [])),
  };
}

function readinessNote(status, requirement) {
  if (status === "ready") return "runtime dependency detected";
  if (status === "configured") return "external runtime configured through environment";
  if (status === "partial") return "package detected but required environment binding is missing";
  if (status === "external_required") return "requires external service, Python package, native binary, or production binding";
  if (status === "reference_only") return "architecture reference or built-in capability; no package binding required";
  if ((requirement.npm || []).length > 0) return "npm package not detected in project manifests";
  return "runtime binding not detected";
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function normalizeExecutionInput(input = {}) {
  const envelope = input.envelope || input.taskEnvelope || input.contract || null;
  const intentAnalysis = envelope?.intent_analysis || {};
  const primaryRaw = input.primaryIntent || input.primary_intent || input.intent || intentAnalysis.primary_intent || null;
  const primaryIntent = normalizeIntentValue(primaryRaw);
  const secondary = [
    ...(input.secondaryIntents || input.secondary_intents || []),
    ...(intentAnalysis.secondary_intents || []),
  ].map(normalizeIntentValue).filter(Boolean);

  return {
    request_id: input.requestId || input.request_id || envelope?.request_id || null,
    primary_intent: primaryIntent,
    secondary_intents: unique(secondary),
    task_family: normalizeTerm(input.taskFamily || input.task_family || intentAnalysis.task_family || envelope?.task_classification?.output_category || ""),
    task_type: normalizeTerm(input.taskType || input.task_type || envelope?.task_classification?.task_type || ""),
    task_domain: normalizeTerm(input.taskDomain || input.task_domain || intentAnalysis.task_domain || ""),
    output_formats: collectOutputFormats(input, envelope),
    tool_names: collectToolNames(input, envelope),
    attachment_types: collectAttachmentTypes(input, envelope),
    flags: {
      requiresResearch: Boolean(input.requiresResearch || input.requires_research || envelope?.context_requirements?.needs_web_search || envelope?.task_classification?.requires_external_research),
      requiresDatabase: Boolean(input.requiresDatabase || input.requires_database || envelope?.context_requirements?.needs_database_access),
      requiresBrowser: Boolean(input.requiresBrowser || input.requires_browser || envelope?.context_requirements?.needs_browser_automation),
      requiresCode: Boolean(input.requiresCode || input.requires_code || envelope?.task_classification?.requires_code_execution),
      requiresFileProcessing: Boolean(input.requiresFileProcessing || input.requires_file_processing || envelope?.task_classification?.requires_file_processing),
      requiresVisual: Boolean(input.requiresVisual || input.requires_visual || envelope?.task_classification?.requires_visual_generation),
      highRisk: Boolean(input.highRisk || input.high_risk || envelope?.safety_and_permissions?.overall_risk_level === "high" || envelope?.safety_and_permissions?.overall_risk_level === "critical"),
    },
  };
}

function selectLayerIds(normalized) {
  const ids = new Set(CORE_LAYER_IDS);
  add(ids, "orchestration");
  add(ids, "chat-runtime");

  for (const key of [normalized.primary_intent, ...normalized.secondary_intents]) {
    addMany(ids, INTENT_LAYER_MAP[key]);
  }
  for (const key of [normalized.task_family, normalized.task_type, normalized.task_domain]) {
    addMany(ids, FAMILY_LAYER_MAP[key]);
    for (const [family, layers] of Object.entries(FAMILY_LAYER_MAP)) {
      if (key && key.includes(family)) addMany(ids, layers);
    }
  }
  for (const format of normalized.output_formats) {
    addMany(ids, FORMAT_LAYER_MAP[format]);
  }
  for (const type of normalized.attachment_types) {
    addMany(ids, FORMAT_LAYER_MAP[type]);
    if (["pdf", "docx", "pptx", "xlsx", "csv"].includes(type)) add(ids, "document");
  }
  for (const toolName of normalized.tool_names) {
    for (const [pattern, layers] of TOOL_LAYER_RULES) {
      if (pattern.test(toolName)) addMany(ids, layers);
    }
  }

  if (normalized.flags.requiresResearch) addMany(ids, ["rag", "browser", "eval"]);
  if (normalized.flags.requiresDatabase) addMany(ids, ["database", "security-governance"]);
  if (normalized.flags.requiresBrowser) addMany(ids, ["browser", "security-governance"]);
  if (normalized.flags.requiresCode) addMany(ids, ["sandbox", "security-governance"]);
  if (normalized.flags.requiresFileProcessing) addMany(ids, ["document", "render-preview"]);
  if (normalized.flags.requiresVisual) addMany(ids, ["design-canvas", "render-preview"]);
  if (normalized.flags.highRisk) addMany(ids, ["security-governance", "eval"]);

  return stableLayerOrder([...ids]);
}

function buildExecutionNotes({ normalized, layers, stubs, capabilityOnly }) {
  const notes = [];
  if (normalized.output_formats.length > 0) {
    notes.push(`Resolved output formats: ${normalized.output_formats.join(", ")}`);
  }
  if (normalized.tool_names.length > 0) {
    notes.push(`Resolved tool families from ${normalized.tool_names.length} tool(s).`);
  }
  if (stubs.length > 0) {
    notes.push(`Runtime adapters currently stubbed: ${stubs.join(", ")}.`);
  }
  if (capabilityOnly.length > 0) {
    notes.push(`Capability-only layers require production bindings before wet-run execution: ${capabilityOnly.join(", ")}.`);
  }
  notes.push(`Execution stack contains ${layers.length} layer(s) and must pass all release gates before delivery.`);
  return notes;
}

function collectOutputFormats(input, envelope) {
  const explicit = [
    ...(input.outputFormats || input.output_formats || []),
    input.outputFormat || input.output_format || null,
    envelope?.output_contract?.primary_output?.format || null,
    ...(envelope?.output_contract?.secondary_outputs || []).map((item) => item.format),
  ];
  return unique(explicit.map(normalizeFormat).filter(Boolean));
}

function collectToolNames(input, envelope) {
  const tools = [
    ...(input.requiredTools || input.required_tools || input.toolNames || input.tool_names || []),
    ...(envelope?.tool_plan?.required_tools || []).map((item) => item.tool_name),
    ...(envelope?.workflow_graph?.nodes || []).flatMap((node) => node.tools || []),
  ];
  return unique(tools.map(normalizeTerm).filter(Boolean));
}

function collectAttachmentTypes(input, envelope) {
  const attachments = [
    ...(input.attachments || []),
    ...(envelope?.raw_input?.attachments || []),
  ];
  return unique(attachments.map((item) => (
    normalizeFormat(item.detected_type || item.format || extensionFromName(item.filename || item.name || "") || item.mime_type || item.mimeType || "")
  )).filter(Boolean));
}

function validateManifest() {
  const issues = [];
  const ids = new Set();
  for (const layerDef of LAYERS) {
    if (!layerDef.id || !layerDef.label) issues.push(`layer missing id/label: ${JSON.stringify(layerDef).slice(0, 80)}`);
    if (ids.has(layerDef.id)) issues.push(`duplicate layer id "${layerDef.id}"`);
    ids.add(layerDef.id);
    if (!Array.isArray(layerDef.libraries) || layerDef.libraries.length === 0) issues.push(`${layerDef.id} has no libraries`);
    if (!Array.isArray(layerDef.capabilities) || layerDef.capabilities.length === 0) issues.push(`${layerDef.id} has no capabilities`);
    const libs = new Set();
    for (const library of layerDef.libraries || []) {
      if (!library.id || !library.name || !library.role) issues.push(`${layerDef.id}: malformed library`);
      if (libs.has(library.id)) issues.push(`${layerDef.id}: duplicate library id "${library.id}"`);
      libs.add(library.id);
    }
  }
  const referenced = new Set([
    ...CORE_LAYER_IDS,
    ...Object.values(INTENT_LAYER_MAP).flat(),
    ...Object.values(FAMILY_LAYER_MAP).flat(),
    ...Object.values(FORMAT_LAYER_MAP).flat(),
    ...TOOL_LAYER_RULES.flatMap(([, layers]) => layers),
  ]);
  for (const id of referenced) {
    if (!LAYERS_BY_ID[id]) issues.push(`mapping references unknown layer "${id}"`);
  }
  return {
    ok: issues.length === 0,
    issues,
    layer_count: LAYERS.length,
    library_count: LAYERS.reduce((sum, layerDef) => sum + layerDef.libraries.length, 0),
    capability_count: LAYERS.reduce((sum, layerDef) => sum + layerDef.capabilities.length, 0),
  };
}

function pickAdapter(layerId, all) {
  const key = adapterKey(layerId);
  if (key === "mcp") return all.mcp;
  if (key === "eval") return all.evals;
  return all[key] || null;
}

function adapterKey(layerId) {
  const layerDef = LAYERS_BY_ID[layerId];
  if (layerDef?.adapter) return layerDef.adapter;
  if (layerId === "agent-sdk") return "agentSdk";
  if (layerId === "eval") return "eval";
  if (layerId === "model-gateway") return "modelGateway";
  return layerId;
}

function layer(definition) {
  const tags = definition.tags || inferTags(definition);
  return Object.freeze({
    id: definition.id,
    label: definition.label,
    description: definition.description,
    adapter: definition.adapter || null,
    libraries: Object.freeze((definition.libraries || []).map((library) => Object.freeze(library))),
    capabilities: Object.freeze([...(definition.capabilities || [])]),
    validation_gates: Object.freeze([...(definition.validation_gates || [])]),
    security_gates: Object.freeze([...(definition.security_gates || [])]),
    tags: Object.freeze([...tags]),
  });
}

function lib(id, name, language, role) {
  return { id, name, language, role };
}

function inferTags(definition) {
  const tags = new Set(["backend"]);
  for (const capability of definition.capabilities || []) {
    const head = String(capability).split("_")[0];
    if (head) tags.add(head);
  }
  return [...tags];
}

function cloneLayer(layerDef) {
  return {
    id: layerDef.id,
    label: layerDef.label,
    description: layerDef.description,
    adapter: layerDef.adapter,
    tags: [...layerDef.tags],
    capabilities: [...layerDef.capabilities],
    validation_gates: [...layerDef.validation_gates],
    security_gates: [...layerDef.security_gates],
    libraries: layerDef.libraries.map((library) => ({ ...library })),
  };
}

function normalizeIntentValue(value) {
  if (!value) return "";
  if (typeof value === "object") return normalizeTerm(value.id || value.intent || value.label || "");
  return normalizeTerm(value);
}

function normalizeFormat(value) {
  const raw = normalizeTerm(value);
  if (!raw) return "";
  if (raw.includes("wordprocessingml") || raw === "word" || raw === "document") return "docx";
  if (raw.includes("presentationml") || raw === "powerpoint" || raw === "slides") return "pptx";
  if (raw.includes("spreadsheetml") || raw === "excel" || raw === "spreadsheet") return "xlsx";
  if (raw.includes("pdf")) return "pdf";
  if (raw.includes("svg")) return "svg";
  if (raw.includes("png")) return "png";
  if (raw.includes("csv")) return "csv";
  if (raw.includes("html")) return "html";
  if (raw.includes("zip")) return "zip";
  return raw.replace(/^\./, "");
}

function extensionFromName(name) {
  const m = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

function normalizeTerm(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function add(set, id) {
  if (id && LAYERS_BY_ID[id]) set.add(id);
}

function addMany(set, ids) {
  for (const id of ids || []) add(set, id);
}

function stableLayerOrder(ids) {
  const order = new Map(LAYERS.map((layerDef, index) => [layerDef.id, index]));
  return unique(ids).sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999));
}

function unique(values) {
  return [...new Set((values || []).filter((value) => value !== null && value !== undefined && value !== ""))];
}

module.exports = {
  createIntegrationStack,
  buildExecutionStackPlan,
  buildDependencyReadiness,
  normalizeExecutionInput,
  LAYERS,
  LAYERS_BY_ID,
  INTENT_LAYER_MAP,
  FAMILY_LAYER_MAP,
  FORMAT_LAYER_MAP,
  LIBRARY_RUNTIME_REQUIREMENTS,
};

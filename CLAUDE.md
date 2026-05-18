# CLAUDE.md — SiraGPT Agent Workspace

## Project Overview
SiraGPT es una plataforma AI full-stack (Next.js 14 + Express.js) con sistema multi-agente, generación de contenido visual, documentos, y orquestación tipo OpenClaw.

## Arquitectura
- **Frontend:** Next.js 14 (React), app/ directory, shadcn/ui, TailwindCSS, Zustand stores
- **Backend:** Express.js en `backend/`, Prisma ORM, PostgreSQL, Redis
- **Agentes:** Sistema multi-agente en `backend/src/services/agents/`
  - `agent-core.js` — núcleo del agente
  - `agent-task-runner.js` — ejecutor de tareas, error classifier, dynamic tool list from manifest
  - `agent-tools.js` — registro de herramientas + static checks (weak_crypto, unsafe_html, etc.)
  - `visual-media-tools.js` — 11+ tools: generate_image, create_chart, create_organigram, create_mermaid_diagram, create_infographic_svg, create_dashboard_html, generate_video, create_comparison_table, create_process_flow, create_timeline, create_kanban_board. Chart subtypes: funnel, gauge, waterfall, heatmap, treemap. Infographic section types: stat/list/quote/progress
  - `tool-manifest.js` — declarative tool registry with manifests, budgets, output format validation
  - `agentic-langgraph.js` — orquestación LangGraph
  - `task-tools.js` — artifact system with atomic save, MIME mappings
  - `task-store.js` — SQLite-based task store with fast user index, snapshot compression
  - `code-sandbox.js` — sandboxed code execution with size limits
- **Document Pipeline:** `backend/src/services/sira/document-pipeline-registry.js` — declarative registry with 20+ parsers/generators, contentQualityScore, formatAdvice
- **CI:** `.github/workflows/ci.yml` (frontend + backend + security + docker)

## Comandos importantes
```bash
npm run dev            # Next.js dev server (puerto 3000)
npm run build          # Next.js build
npm test               # Tests backend (Node --test) - ~2900 tests
npm run lint           # ESLint (ratchet: max-warnings 97)
npx tsc --noEmit --skipLibCheck   # TypeScript check
npm run type-check     # TSC completo
```

## Reglas para Claude
1. **No modificar la UI/componentes visuales** — solo funcionalidad interna
2. **Trabajar en:** agentes, herramientas de generación, pipelines, sistema de archivos, backend
3. **Push directo a main** en `https://github.com/SiraGPT-ORg/siraGPT`
4. **Cada cambio debe mantener CI verde** — correr `npm test` y `npm run lint` antes de push
5. **Hacer `git pull --rebase` antes de push** para evitar conflictos
6. **Priorizar:** estabilidad, rendimiento, cobertura de errores, calidad de código

## Visual Tools Inventory (33 tools)
| Tool | File | Description |
|------|------|-------------|
| generate_image | visual-media-tools.js | SVG/PNG image generation |
| create_chart | visual-media-tools.js | 8 chart types + funnel/gauge/waterfall/heatmap/treemap |
| create_organigram | visual-media-tools.js | Org chart with SVG |
| create_mermaid_diagram | visual-media-tools.js | Mermaid diagram → HTML |
| create_infographic_svg | visual-media-tools.js | Infographic with stat/list/quote/progress sections |
| create_dashboard_html | visual-media-tools.js | HTML dashboard with KPIs |
| generate_video | visual-media-tools.js | Storyboard fallback SVG |
| create_comparison_table | visual-media-tools.js | Feature comparison table |
| create_process_flow | visual-media-tools.js | Process flow SVG (themes, icons, arrows/chevrons/circles) |
| create_timeline | visual-media-tools.js | Timeline visualization |
| create_kanban_board | visual-media-tools.js | Kanban board SVG |
| create_swot_analysis | visual-media-tools.js | SWOT 2x2 matrix SVG (Strengths/Weaknesses/Opportunities/Threats, 4 themes) |
| create_eisenhower_matrix | visual-media-tools.js | Eisenhower urgency×importance 2x2 SVG (Do/Schedule/Delegate/Eliminate, 4 themes, axis labels) |
| create_raci_matrix | visual-media-tools.js | RACI responsibility assignment matrix SVG (tasks × roles grid, R/A/C/I pills, legend, 4 themes) |
| create_business_model_canvas | visual-media-tools.js | Osterwalder 9-block BMC SVG (KP/KA/KR/VP/CR/Ch/CS top + Cost/Revenue bottom, 4 themes) |
| create_pyramid_diagram | visual-media-tools.js | Hierarchical pyramid SVG (2-8 levels, optional inverted, per-level descriptions + side labels, 4 themes) |
| create_porters_five_forces | visual-media-tools.js | Porter's Five Forces SVG (Rivalry centre + 4 surrounding forces, optional intensity pills, 4 themes) |
| create_risk_matrix | visual-media-tools.js | Probability × impact risk matrix SVG (3/4/5 grid, heatmap cells, plotted risk markers, side legend, 4 themes) |
| create_funnel_diagram | visual-media-tools.js | Conversion funnel SVG (2-8 stages, auto conversion %, drop-off arrows, per-stage colors, 4 themes) |
| create_value_proposition_canvas | visual-media-tools.js | Strategyzer VPC SVG (Customer Profile + Value Map halves, 6 sub-sections, FIT bridge, 4 themes) |
| create_pestel_analysis | visual-media-tools.js | PESTEL macro-environmental SVG (6 dimensions in 3×2 grid, letter badges, color-coded per axis, 4 themes) |
| create_radar_chart | visual-media-tools.js | Radar/spider chart SVG (3-8 axes, 1-4 polygon series, configurable rings, axis tick labels, 4 themes) |
| create_user_journey_map | visual-media-tools.js | UX customer journey map SVG (stages × 5 lanes, top emotion curve with emojis, 4 themes) |
| create_okr_dashboard | visual-media-tools.js | OKR dashboard SVG (objective cards with KR progress bars, red/amber/green status, 4 themes) |
| create_empathy_map | visual-media-tools.js | Design-thinking empathy map SVG (persona centre + Says/Thinks/Does/Feels quadrants + optional Pains/Gains strips, 4 themes) |
| create_lean_canvas | visual-media-tools.js | Ash Maurya Lean Canvas SVG (9 startup-focused blocks — Problem/UVP/UnfairAdvantage/Solution/Channels/Segments/Cost/Revenue/Metrics, 4 themes) |
| create_balanced_scorecard | visual-media-tools.js | Kaplan-Norton Balanced Scorecard SVG (4 perspective bands Financial/Customer/Internal/L&G + cause-effect arrow + status pills, 4 themes) |
| create_ansoff_matrix | visual-media-tools.js | Ansoff growth-strategy 2x2 SVG (Market × Product → Penetration/Development/Development/Diversification with risk pills, 4 themes) |
| create_bcg_matrix | visual-media-tools.js | BCG portfolio matrix SVG (Market Share × Growth with revenue-sized bubbles, Stars/Cash Cows/Question Marks/Dogs quadrants, 4 themes) |
| create_moscow_chart | visual-media-tools.js | MoSCoW prioritization SVG (4 columns Must/Should/Could/Won't Have with feature cards, 4 themes) |
| create_decision_tree | visual-media-tools.js | Decision tree SVG (top-down branching with up to 4 levels × 4 branches, decision/outcome nodes, labelled edges, 4 themes) |
| create_concept_map | visual-media-tools.js | Concept map SVG (2-12 nodes in radial layout + labelled edges + category color groups, 4 themes) |
| create_mindmap_radial | visual-media-tools.js | Radial hierarchical mindmap SVG (central topic + 2-8 main branches with 0-5 sub-topics fanned, 4 themes) |

## Backend Reliability Utilities

### `src/utils/async-guard.js`
**AsyncGuard** — Resource management with timeout, cleanup, and FinalizationRegistry.
- `guard.run(promise, opts)` — wraps a promise with timeout + abort signal
- `guard.route(fn, opts)` — Express middleware wrapper with per-route labels
- `GuardError` — thrown on timeout, enriched with `guardId`, `guardElapsedMs`
- `FinalizationRegistry` — GC safety net for abandoned guards
- `raceWithSignal(promise, signal)` — exported helper for AbortSignal integration
- Tests: 42/42 passing

### `src/utils/fetch-instrument.js`
**FetchInstrument** — Global fetch patching with OTel tracing, header sanitization, timeout.
- `install()` / `uninstall()` — replace `globalThis.fetch` with traced version
- `sanitizeFetchInit(init)` — strips forbidden headers (Connection, Keep-Alive, etc.)
- OTel spans per request with method, URL, status, duration attributes
- Request/response body size metrics (bytes read/written)
- Tests: 38/38 passing

### `src/utils/circuit-breaker.js`
**CircuitBreaker** — State machine (CLOSED/OPEN/HALF_OPEN) for external service resilience.
- Rolling-window failure counting with configurable threshold
- `call(fn, opts)` — guarded invocation with timeout (CircuitTimeoutError)
- External AbortSignal integration (not counted as failures)
- `CircuitOpenError` — fast-fail when breaker is OPEN
- `forceState()` / `reset()` — manual intervention
- `toJSON()` — metrics snapshot for monitoring
- Tests: 33/33 passing

### `src/utils/async-handler.js`
**enhanced asyncHandler** — Express async route wrapper with guard integration.
- Backward-compatible microtask-level error forwarding
- Optional per-route timeout (`{ timeoutMs: 30_000 }`) via AsyncGuard
- Headers-sent detection (`res.headersSent` / `res.writableEnded`) — no double-send
- Sync-throw propagation from non-async handlers preserved
- Tests: 12/12 passing

## Test Files (~2900 tests)
- `backend/tests/visual-media-tools.test.js` — 23+ tests for all visual tools
- `backend/tests/agent-task-store.test.js` — 13+ tests for task-store
- `backend/tests/agent-task-runner-classify.test.js` — 10 tests for error classifier
- `backend/tests/code-sandbox-extras.test.js` — code sandbox tests
- `backend/tests/document-pipeline-registry-formats.test.js` — format tests
- `backend/tests/agent-task-route-contract.test.js` — contract tests
- `backend/tests/tool-manifest-helpers.test.js` — budget + output format tests
- `backend/tests/agent-task-durable-events.test.js` — durable event tests
- `tests/agent-tools-improvements.test.ts` — agent tools hardening tests
- `backend/tests/async-guard.test.js` — 42 tests for AsyncGuard
- `backend/tests/fetch-instrument.test.js` — 38 tests for FetchInstrument
- `backend/tests/circuit-breaker.test.js` — 33 tests for CircuitBreaker
- `backend/tests/async-handler.test.js` — 12 tests for enhanced asyncHandler

## Tool Manifest Functions
- `authorizeToolCall()` — clearance-based authorization
- `checkToolUsageBudget()` — per-task call budget enforcement
- `checkOutputFormat()` — file format validation against manifest
- `validateManifest()` — schema validation
- `listManifests()` — get all registered tool manifests

## Backend Reliability Modules (completed ✅)
- `async-guard.js` — Guarded async execution with timeout, cleanup, GC safety
- `fetch-instrument.js` — OTel-instrumented fetch with header sanitization
- `circuit-breaker.js` — Circuit breaker for external service resilience
- `async-handler.js` — Enhanced Express error wrapper with guard integration
- `retry-with-backoff.js` — Retry wrapper with exponential backoff, jitter, circuit breaker delegation
- `error-telemetry.js` — Structured error reporter factory bridging to OTel spans
- `agent-collaboration.js` — Multi-agent coordination (fork-join, chain, vote, review) with guard, retry, circuit breaker
- `progress-stream.js` — Unified SSE progress reporter with stage transitions, heartbeat, elapsed tracking
- `document-intent-analyzer.js` — Multi-document intent analysis with heuristic and LLM-based detection

## Document Pipeline Improvements (completed ✅)
### Batch upload
- **Upload limit**: 10 → 50 files per batch (`upload.array('files', 50)`)
- **Default MAX_UPLOAD_FILES**: 10 → 50 (env `MAX_UPLOAD_FILES`, capped at 100)
- **Parallel processing**: files processed in batches of `MAX_CONCURRENT` (env `SIRAGPT_UPLOAD_CONCURRENCY`, default 5)
- **Cross-document context**: batch context stored, intent analysis auto-triggered for 2+ files

### Document size caps
- **MAX_DOC_CHARS**: 300KB → 1MB (env `SIRAGPT_RAG_MAX_DOC_CHARS`)
- **MAX_COLLECTION_CHUNKS**: 2000 → 10000 (env `SIRAGPT_RAG_MAX_CHUNKS`)
- **MAX_DATA_ROWS_PER_SHEET**: 50 → 5000 (spreadsheet extraction)

### Large file safety
- **Memory-safe PDF sampling**: files > 150MB skip to sampled mode (first/middle/last sections, each capped at 300KB)
- **MEMORY_SAFE_MAX_BYTES**: env `SIRAGPT_MEMORY_SAFE_MAX_BYTES`, default 150MB

### Files modified
- `backend/src/services/upload-security-policy.js` — default limits increased
- `backend/src/routes/files.js` — parallel batch processing + cross-doc analysis
- `backend/src/services/fileProcessor.js` — memory-safe PDF path + higher spreadsheet limit
- `backend/src/services/rag/operational-runtime.js` — MAX_DOC_CHARS 300K → 1M
- `backend/src/services/rag-service.js` — MAX_COLLECTION_CHUNKS 2000 → 10000 (env-configurable)
- `backend/src/services/document-intent-analyzer.js` — **NEW**: per-doc + cross-doc intent analysis
- `backend/tests/document-intent-analyzer.test.js` — **NEW**: 29 tests for intent analysis

## Cowork System (completed ✅)
### Auto-File Bridge
- **File**: `backend/src/services/auto-file-bridge.js`
- Auto-converts pasted/dropped content (≥200 chars) into analyzable document objects
- Detects format: JSON, CSV, XML, HTML, YAML, Markdown, SQL, Python, JS/TS, Shell, Log
- Ingests into Prisma DB + Document Intelligence + RAG indexing pipeline
- Cross-document intent analysis auto-triggered for batch uploads
- **API**: `POST /api/cowork/auto-file`, `POST /api/cowork/auto-file/batch`, `GET /api/cowork/auto-files`

### Deep Document Analyzer
- **File**: `backend/src/services/deep-document-analyzer.js`
- Domain detection: legal, financial, academic, medical, technical, business (keyword scoring)
- Entity extraction: email, phone, URL, date, money, percentage, IP, SSN, credit card, DOI, IBAN
- PII sensitivity levels: critical, high, medium, low (auto-redaction for critical)
- Structure extraction: markdown + numbered headings, TOC detection
- Risk assessment: domain-specific (data exposure, PII density, legal clauses, financial amounts, infrastructure exposure)
- Quality metrics: readability, completeness, coherence, domain relevance, risk score, information density → letter grade (A-F)
- Auto-tagging: domain + entity types + key phrases
- **API**: `POST /api/cowork/analyze-deep`, `POST /api/cowork/analyze-deep/file/:fileId`

### Active Memory
- **File**: `backend/src/services/active-memory.js`
- Two-tier memory: short-term + long-term
- Auto-promotion: short-term → long-term after 3+ accesses or strength ≥ 0.8
- Auto-demotion: long-term → short-term when access count = 0 and strength < 0.3
- Content-hash deduplication
- Semantic recall with weighted scoring (relevance, recency, strength, access, tier)
- Memory prompt builder for system prompt injection
- TTL-based expiration with stale entry cleanup
- **API**: `POST /api/cowork/memory`, `POST /api/cowork/memory/recall`, `GET /api/cowork/memory`, `DELETE /api/cowork/memory`, `POST /api/cowork/memory/promote/:entryId`

### Session Manager
- **File**: `backend/src/services/session-manager.js`
- In-memory multi-session management per user
- Session CRUD: create, get, list, archive, reset
- Message history with cursor-based pagination
- Session spawning (child inherits recent context from parent)
- Cross-session message forwarding
- Session compaction (keep head + tail, drop middle)
- Auto-cleanup of expired sessions (TTL 24h default)
- **API**: `POST /api/cowork/sessions`, `GET /api/cowork/sessions`, `GET /api/cowork/sessions/:id`, `POST /api/cowork/sessions/:id/messages`, `GET /api/cowork/sessions/:id/history`, `POST /api/cowork/sessions/:id/spawn`, `POST /api/cowork/sessions/:id/compact`, `POST /api/cowork/sessions/:id/reset`, `POST /api/cowork/sessions/:id/send`

### Skills Registry
- **File**: `backend/src/services/skills-registry.js`
- 14 built-in skills across 7 categories (information, document, generation, code, data, agentic, conversational)
- Declarative skill descriptors: tools, prerequisites, side effects, idempotency, acceptance, cost, clearance
- Intent-based skill recommendation with weighted scoring
- Prerequisite verification against runtime context
- Category + tag indexing with query search
- Dynamic registration/unregistration
- **API**: `GET /api/cowork/skills`, `GET /api/cowork/skills/recommend`

### Cowork Engine
- **File**: `backend/src/services/cowork-engine.js`
- Orchestrates all cowork subsystems into a unified experience
- Builds cowork system prompt with: auto-file instructions, deep analysis directives, active memory, skills catalog
- Processes incoming messages: auto-file detection, memory fact extraction, auto-promotion
- Enriches AI requests: auto-file ingestion + deep analysis + memory prompt injection
- **API**: `POST /api/cowork/enrich`
- **Integration**: Auto-injected into `/api/ai/generate` system prompt

### Integration in AI Generate Route
- `backend/src/routes/ai.js` — cowork system prompt + auto-file + deep analysis injected into every chat turn
- Structured content ≥200 chars without attached files auto-filed as virtual documents
- Deep analysis results (domain, quality, risk, PII) injected into system prompt
- Active memory facts included in every turn

### Test Files
- `backend/tests/cowork-system.test.js` — 83 tests for all cowork modules

## Next Improvement Areas
1. **Document pipeline** — add more generator formats (EPUB, RTF, ODT)
2. **Service health probes** — endpoint health monitoring
3. **Rate limiting** — Redis-backed rate limiter for API endpoints

## Conexiones externas
- Repo: https://github.com/SiraGPT-ORg/siraGPT
- Remoto: `sira-org`
- Branch: main (push directo)
- CI: GitHub Actions (automatic cancel on newer commit)

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
npm run lint           # ESLint (ratchet: max-warnings 50)
npx tsc --noEmit --skipLibCheck   # TypeScript check
npm run type-check     # TSC completo
```

## Reglas para Claude
1. **No modificar la UI/componentes visuales** — solo funcionalidad interna. El UI lock
   (`scripts/verify-ui-lock.sh`, 270 archivos) lo verifica en CI; levantarlo es decisión de Luis.
2. **Trabajar en:** agentes, herramientas de generación, pipelines, sistema de archivos, backend
3. **Nunca push a `main`.** Todo cambio = rama + PR a `production-main` en
   `https://github.com/infosiragpt-ops/SiraGPT-APP`, esperar el check
   "CI · required checks passed", squash-merge (`gh pr merge <n> --squash`). Desde
   2026-09-26 la protección ya **no** exige la rama al día (el merge queue de GitHub no
   existe para repos de cuenta personal): no hace falta `gh pr update-branch` tras cada
   fusión ajena. La integración la valida el CI del push a `production-main`, que la
   publicación espera; si el PR estaba al día, la publicación reutiliza el CI del PR
   (árbol git idéntico) y arranca sin esperar. Un PR con cambios que dependan de otro
   recién fusionado sí conviene actualizarlo antes. No usar `--admin` con CI rojo.
4. **Cada cambio debe mantener CI verde** — correr los tests afectados (`node --test`),
   `git diff --check` y `bash scripts/verify-ui-lock.sh` antes de abrir el PR.
5. **Priorizar:** estabilidad, rendimiento, cobertura de errores, calidad de código.
6. **Producción es la Lenovo de oficina** (túnel Cloudflare → siragpt.com), no Hostinger ni
   un VPS nuevo. **Desde 2026-09-12 la publicación es automática**: cada squash-merge a
   `production-main` dispara el workflow "Publish production (Lenovo)"
   (`.github/workflows/publish-production.yml`) en el runner self-hosted de la Lenovo
   (`deploy/lenovo-runner`, contenedor `siragpt-github-runner`), que espera el CI del push
   y ejecuta el mismo `publish.sh` con todas sus barreras (fast-forward, sin diffs de
   schema, rollback). Cambios de schema/migraciones siguen siendo release manual por SSH.
   Nunca `compose down -v`, nunca `git reset --hard`, nunca mover DNS ni crear otro `.env`.
7. **Secretos:** jamás en el chat, en commits ni en docs. Viven en Replit Secrets y en el único
   `.env` de producción. Un secreto nuevo se pide a Luis por canal enmascarado.
8. **Producto:** `/agentes` es la superficie canónica (`/chat` y `/code` redirigen; no revivir
   `/code`). DeepSeek V4 Flash/Pro se muestran con sus nombres originales "DeepSeek V4 Flash" /
   "DeepSeek V4 Pro" (decisión de Luis, 2026-09-26; los alias "Sira Rápido" / "Sira Pro" solo se
   aceptan como entrada); nunca el model_id crudo; nada de OpenRouter en la UI. Una app cuenta como
   "Conectada" solo con token válido + health, nunca por abrir un navegador o un catálogo.

## Visual Tools Inventory (34 tools)
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
| create_swimlane_diagram | visual-media-tools.js | BPM swimlane SVG (lanes × stages grid, tasks in cells, optional handoff arrows, 4 themes) |

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

## Scientific Search + Research Agent (Manus-like) — added 2026-05-18

### `src/services/scientific-search.js`
Unified search over 7 open scientific-paper APIs. arXiv / OpenAlex / CrossRef / Europe PMC work key-less; Semantic Scholar / PubMed (NCBI) / CORE accept optional free keys for higher rate limits. Each provider returns a canonical Paper shape `{ source, doi, title, abstract, authors, year, venue, citations, openAccess, pdfUrl, htmlUrl }`. The unified `search(query, opts)` fans out in parallel with per-provider timeouts, dedupes by DOI/title, and returns ranked papers + a `providers` list + per-provider `errors`. Polite User-Agent uses `SIRAGPT_RESEARCH_EMAIL` env var when set.
- Route: `POST /api/scientific-search` + `GET /api/scientific-search/providers`
- 24 unit tests with mocked fetch.

### `src/services/research-agent.js`
Autonomous "Manus-like" loop: given a topic, runs planner → searcher (scientific-search) → browser (Playwright headless) → vision (OpenAI gpt-4o-mini reading screenshots) → decision (continue/refine/finalise) → synthesiser cycle. Degrades to text-only when Playwright/chromium isn't installed. Emits SSE events `phase` / `paper` / `page` / `finding` / `decision` / `report` so the UI can stream progress in real time.
- Route: `POST /api/research-agent/run` (one-shot) + `POST /api/research-agent/stream` (SSE)
- Depth config: `quick` (3 steps, 2 pages) / `standard` (6 steps, 4 pages) / `deep` (9 steps, 6 pages)
- 15 unit tests.

### Free API keys (optional — `.env.local`)
- `SIRAGPT_RESEARCH_EMAIL` — any email; sets polite UA for OpenAlex/CrossRef/PubMed
- `SEMANTIC_SCHOLAR_API_KEY` — free at https://www.semanticscholar.org/product/api
- `NCBI_API_KEY` — free at https://www.ncbi.nlm.nih.gov/account/ → API Key Management
- `CORE_API_KEY` — free at https://core.ac.uk/services/api
- `RESEARCH_VISION_MODEL` — override the vision model (default `gpt-4o-mini`)

### Slash command `/goal` in chat
The chat composer (`components/chat-interface-enhanced.tsx`) detects a leading `/` and shows a `SlashCommandMenu` listing `/goal` (chain research-agent until findings converge), `/research` (one-shot scientific search), `/summarize` (placeholder). Typing the slash + Enter routes the message to the corresponding backend endpoint via SSE, with toast progress; the final report is copied to clipboard so the user can paste it back into the conversation.

## Context Intelligence System (completed ✅) — added 2026-05-25

Attribution-based context understanding inspired by Anthropic's *On the Biology of a Large Language Model* / attribution graphs research (transformer-circuits.pub/2025/attribution-graphs/biology.html). Six heuristic subsystems plus an orchestrator that explain WHICH user-context signals drove the system's interpretation, what is grounded vs invented, and what the user is likely to ask next.

### `src/services/context-attribution-graph.js`
Builds a 3-layer DAG (surface signals → mid-level abstractions → inferred intents) per turn. Each edge carries a contribution weight in [0,1]. 14 signal types (imperative, named entity, temporal cue, quantity, emotional cue, coreference, document ref, memory fact, history…), 13 intent kinds (analyze, generate, code, search, summarize, translate, compare, extract, explain, plan, visualize, review, converse). Bilingual EN/ES imperative recognition. Exports: `buildGraph(query, context)`, `topContributors(graph, limit)`, `buildAttributionPrompt(graph)`.

### `src/services/multi-hop-intent-reasoner.js`
Decomposes requests into ordered hops: literal → subject → constraint → prerequisite → output_kind → tool_mapping → user_goal. Surfaces missing prerequisites (e.g. "summarize this document" with no docs attached) and flips `needsClarification`. Maps output kinds (chart/table/code/document/etc.) to tool suggestions. Detects 6 constraint patterns (date_range, count_limit, language, format, audience, tone) and 5 user-goal inferences (troubleshoot, learn, decide, produce_deliverable, explore). Exports: `reason(query, context)`, `buildMultiHopPrompt(result)`.

### `src/services/lookahead-planner.js`
Predicts the next 1-3 user requests using 10 workflow archetypes (analyze→visualize, code→test, visualize→explain, search→synthesize, summarize→extract, translate→localize, compare→decide, plan→break_down, draft→review, troubleshoot→fix). Each next-step has a confidence score and an optional tool hint. History-aware scoring boosts steps that fit the recent direction. Exports: `planNextSteps(query, context)`, `buildLookaheadPrompt(plan)`.

### `src/services/knowledge-boundary-detector.js`
Classifies every claim (numbers, dates, named entities, URLs, quotations) in a query or draft answer as grounded / hedged_uncertain / ungrounded_assertion / low_confidence_mention by checking whether the value appears in the available context (docs, memory, history, system prompt). Returns a per-claim verdict, a `riskScore` and a `severity` (low/medium/high). Bilingual EN/ES assertion-verb dictionary. Exports: `extractClaims(text)`, `detectBoundaries(text, context)`, `buildKnowledgeBoundaryPrompt(result)`.

### `src/services/reasoning-faithfulness-check.js`
Compares a stated reasoning trace (list of steps with optional cited evidence) against the actual evidence pool (documents, memory, history, tool results, web results, user input). Each step gets a verdict (supported / weak_evidence / unsupported_claim / evidence_mismatch / unverifiable_opinion) and a faithfulness score. High severity when stated reasoning does not match available evidence. Exports: `normaliseEvidencePool(context)`, `checkFaithfulness(trace, context)`, `buildFaithfulnessPrompt(result)`.

### `src/services/entity-grounding-tracker.js`
Extracts 11 entity kinds (URL, email, phone, money, percent, date, year, proper_noun, acronym, hashtag, mention) and tags each as strongly_grounded / memory_grounded / history_grounded / newly_introduced based on where it appears in context. `groundingRate` and `severity` summarise the picture. Confabulation-suspect entities (newly_introduced) get a verify_before_asserting action. Exports: `extractEntities(text)`, `trackEntities(text, context)`, `buildEntityGroundingPrompt(result)`.

### `src/services/context-intelligence-engine.js`
Orchestrator that runs all six subsystems with isolated try/catch, computes an overall confidence in [0,1], and produces a recommendations list (severity-tagged: high/medium/low/info). Builds a single composite system-prompt block capped at `SIRAGPT_CONTEXT_INTELLIGENCE_BLOCK_MAX` chars (default 3500). Compact telemetry payload via `summariseForLog(report)`. Exports: `analyzeContext(userId, query, context)`, `buildSystemPromptBlock(report, opts)`, `summariseForLog(report)`.

### Integration in cowork-engine + AI generate route
- `backend/src/services/cowork-engine.js` — `enrichAIRequest` now runs `contextIntelligence.analyzeContext` after auto-file/deep-analysis/skills, then appends a Context Intelligence prompt block to `systemPromptAdditions`. Returns `contextIntelligence` field on the response for caller logging.
- Auto-injected into every `/api/ai/generate` turn via the existing cowork enrichment pipeline.

### API routes
Mounted at `/api/context-intelligence/*` in `backend/index.js` (CSRF-protected, optional auth, rate-limited):
- `POST /analyze` — full multi-module report for a query
- `POST /prompt-block` — same, returns the formatted system-prompt block + telemetry summary
- `POST /attribution` — attribution graph only
- `POST /multi-hop` — multi-hop reasoner only
- `POST /lookahead` — lookahead planner only
- `POST /knowledge-boundary` — claim grounding analysis
- `POST /faithfulness` — reasoning trace audit
- `POST /entity-grounding` — entity grounding analysis
- `GET /health` — module list and config

### Tests
- `backend/tests/context-intelligence.test.js` — 65 tests covering all 7 modules (signals, abstractions, hops, lookahead patterns, claim classification, faithfulness verdicts, entity grounding, orchestrator integration). Registered in `backend/package.json` test script.

### Env config
- `SIRAGPT_CONTEXT_INTELLIGENCE_BLOCK_MAX` — system-prompt block size cap (default 3500 chars)

## Context Intelligence — Round 2 (completed ✅)

Four additional attribution-graph-inspired subsystems extending the pipeline to multi-turn conversation analysis, hidden objectives, prompt provenance, and counterfactual robustness probing.

### `src/services/cross-turn-attribution-chain.js`
Sliding-window analysis over up to 20 prior turns. Computes per-turn fingerprints (entities, topic tokens, domain, references) and scores how much each prior turn influences the current request — combining Jaccard entity overlap, topic-token overlap, reference cues, domain continuity, and recency decay. Detects unresolved coreferences, topic-drift, and domain shifts across 7 domain dictionaries (code, finance, legal, product, data, research, writing). Exports: `buildChain(history, currentQuery, opts)`, `buildTurnFingerprint`, `buildCrossTurnPrompt`.

### `src/services/hidden-goal-extractor.js`
12 hidden-goal patterns (decide_whether_to_read, spot_risks, compare_against_peers, make_a_decision, understand_a_concept, troubleshoot_a_problem, persuade_or_pitch, extract_actionables, validate_a_belief, produce_deliverable, plan_a_workflow, learn_to_do_it_myself). Each has a surface regex, supporting signals, weight, and a bilingual clarifying question. 16 context-signal detectors (decision_pressure, audience_mention, deadline_pressure, beginner_phrasing, emotion_urgent, etc.). Flags `needsClarification` when top two candidates are within 0.15. Exports: `extractHiddenGoals(query, context)`, `buildHiddenGoalPrompt`.

### `src/services/prompt-provenance-tracker.js`
Per-turn tracker recording the origin of every block in the final system prompt (14 source kinds incl. system_base, cowork, memory, rag, deep_analysis, context_intelligence, cross_turn, hidden_goal, user_query). Builds concatenated prompt + a sidecar `map` of {offset, length, source, weight, summary}. `attributeText(needle)` returns which block introduced a substring; `summarize()` returns share-of-prompt per source; auto-trims lowest-weight blocks when over maxChars. Exports: `createTracker(opts)`, `ProvenanceTracker` class, `SOURCE_KINDS`, `DEFAULT_WEIGHTS`, `buildProvenancePrompt`.

### `src/services/counterfactual-query-rewriter.js`
Generates 3-12 small perturbations of a query (synonym swaps, formality shifts, scope tighteners/looseners, hedges; bilingual EN/ES). Runs each through a pluggable intent function and produces a `robustnessScore` in [0,1] plus verdict (highly_robust / mostly_robust / brittle / unstable). Used by the engine to flag brittle interpretations before the agent commits to an answer. Exports: `generateRewrites(query, opts)`, `probeRobustness(query, intentFn, opts)`, `buildCounterfactualPrompt`.

### Engine + API integration (Round 2)
- `context-intelligence-engine.analyzeContext` now runs all 10 subsystems and adds `crossTurn`, `hiddenGoal`, `counterfactual` to the report.
- Overall confidence factors in cross-turn continuity (coref-aware penalty) and counterfactual robustness.
- 4 new recommendation categories: `coreference`, `domain_shift`, `hidden_goal`, `robustness`.
- `buildSystemPromptBlock` appends the 4 new prompt sections.
- New routes: `POST /api/context-intelligence/cross-turn`, `POST /api/context-intelligence/hidden-goal`, `POST /api/context-intelligence/counterfactual`, `POST /api/context-intelligence/provenance`.

### Tests
- `backend/tests/context-intelligence-r2.test.js` — 37 tests covering the 4 new modules + engine integration. Combined with round-1, the context-intelligence subsystem has 102 tests, all green.

## Intent Attribution Graph (completed ✅ — 2026-05-25)
Inspirado en el paper de Anthropic [On the Biology of a Large Language Model](https://transformer-circuits.pub/2025/attribution-graphs/biology.html). Aplica los conceptos de attribution-graphs (decomposición en features atómicas, supernodes, circuits multi-hop, planning hacia adelante, intent oculto, calibración de confianza) al **entendimiento de la intención del usuario**.

### Módulos (`backend/src/services/intent-attribution-graph/`)
- `feature-extractor.js` — ~30 categorías de features atómicas (action/object/modifier/constraint/temporal/condition/persona/tone/language/reference/negation/emotion/implicit). Bilingüe ES/EN. Detecta features implícitas (`expect-tests`, `fetch-and-summarize-url`, `resume-prior-task`).
- `attribution-graph.js` — grafo dirigido con 9 tipos de arista (action-on / modifies / constrains / negates / gates / refers-to / implies / styles / targets). Nodo sintético `root` para anclar el grafo.
- `supernode-builder.js` — 15 themes (`build-software`, `fix-defect`, `analyze-document`, `generate-visual`, `deploy-or-run`, etc.) — análogo a los supernodes del paper.
- `circuit-tracer.js` — enumera reasoning circuits multi-hop `root → action → object → implicit/supernode` (análogo al Dallas→Texas→Austin del paper).
- `intent-planner.js` — forward planning con 8 reglas de pre-requisitos y 10 reglas de next-steps anticipados (análogo al "rabbit poetry planning").
- `hidden-intent-detector.js` — 11 patrones de surface-vs-true-goal divergence: frustración, dissatisfaction, time-pressure, open-ended-delegation, decision-help, implementation-not-discussion, etc.
- `confidence-calibrator.js` — score 0–1 + band (`high`/`medium-high`/`medium`/`medium-low`/`low`) + ambigüedades específicas con clarifying questions. Análogo al "known answer vs unknown name" del paper.
- `prompt-formatter.js` — renderiza el reporte en un bloque markdown listo para inyectar al system prompt (cap por defecto 3500 chars, env `SIRAGPT_INTENT_ATTR_BLOCK_MAX_CHARS`).
- `index.js` — orquestador `analyzeIntent(prompt, opts)` → `IntentReport`.

### Integración
- **Chat path**: inyectado automáticamente en `backend/src/routes/ai.js` después del `circuitAttributionBlock`. Disable via `SIRAGPT_INTENT_ATTRIBUTION_GRAPH_DISABLED=1`. Telemetría en log: `[intent-attr-graph] feats=N themes=N circuits=N conf=0.X lang=es dur=Nms`.
- **HTTP**: `POST /api/cowork/intent-attribution-graph` (body: `{ prompt, attachments?, includeBlock?, includeFeatures?, maxBlockChars? }`) → reporte completo + bloque inyectable.

### Tests
- `backend/tests/intent-attribution-graph.test.js` — 70 tests (10 suites) cubriendo cada módulo y 4 escenarios de integración. Registrado en `backend/package.json`.

### Trade-offs
- Pura local, sin llamadas LLM — ~5 ms por turno.
- Complementa (no reemplaza) los módulos previos `context-attribution-engine` y `intent-attribution.js` (que es más conservador). El reporte de IAG agrega supernodes + hidden intents + forward planning + confidence band que esos no proveen.

## Attribution Stack — added 2026-05-25 (round 3)

Comprehensive context-attribution + interpretability layer inspired by
Anthropic's "On the Biology of a Large Language Model"
(https://transformer-circuits.pub/2025/attribution-graphs/biology.html).

### Services
| Module | Purpose |
|---|---|
| `attribution-graph.js` | Causal graph (input → context → feature → intent → action) with weighted edges, ablation, path-finding |
| `intent-attribution-graph/` | Submodule: feature-extractor, supernode-builder, circuit-tracer, hidden-intent-detector, intent-planner, response-validator, multilingual-lexicon, counterfactual-analyzer, confidence-calibrator, prompt-formatter |
| `context-attribution-engine.js` | Meta-orchestrator over concept/graph/multi-hop/plan/suppression/faithfulness |
| `attribution-suite.js` | Higher-level runner that adds belief-state + refusal-safety + entity unifier |
| `concept-extractor.js` | Domain concepts + entity / property / goal extraction (multi-lang) |
| `attribution-supernode-merger.js` | Cluster similar features into themes (Jaccard + cosine) |
| `feature-decay-policy.js` | Per-kind half-lives (constraint=7d, urgency=5min, …) |
| `saliency-decay-tracker.js` | Live/fading/dead bucketing per chat |
| `attribution-anomaly-detector.js` | Per-user baseline + z-score outlier flagging |
| `attribution-rollup-aggregator.js` | Sliding-window telemetry rollup for dashboards |
| `conversational-momentum-tracker.js` | High/medium/low momentum classification |
| `attribution-cache.js` | Content-addressable LRU + memoize |
| `prompt-budget-allocator.js` | Tier-aware systemBlocks trimming |
| `ambiguity-flagger.js` | Borderline-intent detection + clarifying questions |
| `adversarial-prompt-detector.js` | 6 categories: instruction_override / role_swap / system_prompt_exfil / etc |
| `self-reflection-loop.js` | Post-gen faithfulness verdict + retry instructions |
| `attribution-graph-visualizer.js` | Mermaid / Cytoscape / JSON renderers |
| `attribution-graph-comparator.js` | A/B diff with topology + intent shift + centroid drift |
| `token-attribution-tracer.js` | Output-token → input-token mapping |
| `cross-modal-attribution.js` | Per-sentence file-region citations (pdf:p4 / xlsx:Sheet!Range / code:L42-50) |
| `domain-calibration.js` | Legal/medical/financial/code/creative/marketing per-domain thresholds |
| `attribution-natural-language-explainer.js` | Human-readable explanation strings (es/en) |
| `attribution-snapshot-store.js` | JSONL persistence + in-memory mirror |
| `attribution-debug-report.js` | Single-call markdown bundle for support tickets |
| `attribution-replay-engine.js` | Re-run snapshot, diff against today's pipeline |
| `attribution-config-validator.js` | 20+ env coherence checks |
| `attribution-performance-profiler.js` | Per-stage rolling p50/p95 latency aggregates |
| `attribution-prompt-fuzzer.js` | Variant generation + graph-stability probe |
| `attribution-metrics.js` | Per-turn telemetry counters |
| `concept-drift-monitor.js` | Topic-shift detection per chat |
| `cross-turn-entity-tracker.js` | Stable entity registry across turns |
| `cross-turn-attribution-chain.js` | Anaphora / reference resolution |
| `cross-language-entity-unifier.js` | Cluster en/es entity variants |
| `hidden-goal-extractor.js` | Implied-goal detection from soft phrasing |
| `counterfactual-query-rewriter.js` | Generate query variants to expose ambiguity |
| `faithfulness-postprocessor.js` | Score + auto-repair instruction |
| `refusal-safety-router.js` | allow / caution / route_to_human / refuse |
| `belief-state-tracker.js` | What the user thinks is fixed vs pending |

### Routes
- `/api/circuit-attribution/{analyze,concepts,multi-hop,plan,suppression,faithfulness,postprocess,drift,entities,metrics,health}`
- `/api/attribution-explainer/{explain,supernodes,budget,cache-stats,saliency/:chatId,health}`
- `/api/attribution-toolkit/{anomaly/*, rollup/*, fuzzer/*, cross-modal/*, domain/*, reflection, visualize/*, compare/*, perf/*, health}`

### Integration in `ai.js`
The chat route stacks these blocks into the system prompt (env-flag gated):
`circuitAttributionBlock`, `intentAttributionGraphBlock`, `saliencyBlock`,
`adversarialBlock` (gated by `SIRAGPT_ADVERSARIAL_DISABLED`; empty unless the
user text trips an injection/role-swap/exfil pattern). `ambiguityBlock` is
NOT stacked on the default chat path — the chat path's intent report
(intent-attribution-graph) has no `subIntents`, which `ambiguity-flagger`
requires; it is produced via the `attribution-stack-runner` path instead.
`prompt-budget-allocator` runs after assembly to trim overflow without
dropping tier-0 (master prompt, safety alerts, contract).

### Tests
~40 dedicated test files in `backend/tests/attribution-*.test.js` + companions.
End-to-end smoke test at `backend/tests/attribution-end-to-end.test.js`
exercises 20+ modules in 4 scenarios.

### Eval harness
`node backend/scripts/run-attribution-quality-eval.js [--dataset=path.json] [--baseline=snapshot.json --strict]`
runs a 20-case labeled corpus and reports intent precision/recall, topic
coverage, language accuracy, multi-hop accuracy, latency p50/p95. Designed
to gate CI on > 5 % regression vs a baseline snapshot.

### Key env flags
- Block gates: `SIRAGPT_CIRCUIT_ATTRIBUTION_DISABLED`, `SIRAGPT_INTENT_ATTRIBUTION_GRAPH_DISABLED`, `SIRAGPT_SALIENCY_DISABLED`, `SIRAGPT_AMBIGUITY_DISABLED`, `SIRAGPT_ADVERSARIAL_DISABLED`, `SIRAGPT_PROMPT_BUDGET_DISABLED`
- Budget: `SIRAGPT_PROMPT_BUDGET_TOKENS` (default 12000)
- Persistence: `SIRAGPT_ATTRIBUTION_PERSIST=1`
- Cache: `SIRAGPT_ATTR_CACHE_DISABLED`, `SIRAGPT_ATTR_CACHE_TTL_MS`, `SIRAGPT_ATTR_CACHE_MAX`
- Saliency: `SIRAGPT_SALIENCY_HALFLIFE_MS`, `_LIVE_THRESHOLD`, `_FADING_THRESHOLD`
- Anomaly: `SIRAGPT_ANOMALY_BUFFER_SIZE`, `_Z_THRESHOLD`, `_MIN_SAMPLES`
- Momentum: `SIRAGPT_MOMENTUM_BUFFER_SIZE`, `_HIGH_THRESHOLD`, `_LOW_THRESHOLD`
- Reflection: `SIRAGPT_REFLECTION_ACCEPT_THRESHOLD`, `_SOFT_THRESHOLD`, `_MAX_RETRIES`
- Run `attribution-config-validator.validate()` on boot to catch incoherent combinations.

## Document professionalism + Claude-style skills — added 2026-07-03

Calidad profesional de documentos generados y edición quirúrgica que preserva
formato, inspirado en la arquitectura de Agent Skills de Anthropic (docx/pptx
skills con contrato de preservación OOXML).

### PPTX design system (`backend/src/services/document-pipeline/pptx-design-system.js`)
- **5 temas profesionales** con tokens completos (palette 17 claves, fonts
  display/body, chartColors ramp, coverStyle, eyebrow): `aurora` (default
  slate/blue), `boardroom` (ejecutivo oscuro navy+ámbar), `minimal` (blanco,
  tinta casi negra, un acento vivo), `editorial` (crema+verde/terracota,
  Georgia display), `consulting` (blanco+navy estructurado).
- `pickPptxTheme({template, prompt, themeId})` — keywords del prompt del
  usuario ("oscuro/elegante"→boardroom, "minimalista"→minimal, "cálido/
  educativo"→editorial, "estrategia/corporativo"→consulting) ganan sobre el
  mapping por template (business→consulting, legal/premium→boardroom,
  education→editorial, academic→minimal).
- `pickChartType({labels, values})` — series temporales (meses/años/Q1-4)→
  line, partes-de-un-todo (≤6 categorías, suma≈100)→doughnut, default→bar.
- `buildPptx` consume el tema completo (portada, agenda, section dividers,
  bullets, stat, quote, charts con `addDataChart`, footer, takeaway) y
  `buildCoverAccentPng(theme)` cachea el PNG de acento por tema.

### DOCX professional cleanup (`advanced-document-pipeline.js`)
- **Eliminados de TODOS los entregables**: tabla QA "Criterio/Validación/
  Estado", imagen marcador TINY_PNG ("validation mark"), línea de branding
  "Documento generado por el pipeline documental multiagente", y el stub APA
  ("American Psychological Association (2020)…"). Ambos caminos: pandoc
  (`buildDocxMarkdown`) y docx-js (`buildDocx`).
- Referencias reales: sección "Referencias" solo cuando template académico Y
  hay `referenceBriefs` (adjuntos con excerpt) — lista los adjuntos reales.
- `expectedFor` docx: `requiresImage` solo si hay imágenes adjuntas
  (`referenceFiles.some(isImage)`), `minTables: 0` default (blueprint sigue
  en 4 — sus 6 tablas son contenido real). `validateDocx`: check `table`
  honra `minTables: 0` (`Number.isFinite`, no `|| 1`), quality `structured`
  ya no exige `<w:tbl>`.

### Surgical list preservation (`source-preserving-document-edit.js`)
- `sanitizeCapturedParagraphProperties(pPr, {keepNumbering})` — modo lista
  conserva `<w:numPr>` (sectPr siempre se elimina).
- `pickRepresentativeListParagraph(paragraphs)` — captura el primer item real
  de lista del documento; `buildFormattingTemplate` gana `listPPr`/`listRPr`.
- `paragraphXml` soporta `kind: 'bullet'`: con lista fuente clona su numPr
  (marcador real de Word, misma numeración/indentación); sin lista fuente cae
  a párrafo con sangría francesa + "• " visible heredando el rPr del cuerpo.
  Prefijos markdown (`- `, `• `) se deduplican del texto.
- `generateTargetSectionBlocks` emite `block('bullet', …)` en vez de texto
  plano "• …".

### Claude-style skills
- **NUEVO** `backend/src/services/sandbox/skills/pptx.md` (servida vía
  `GET /api/sandbox/skills/pptx`): contrato quirúrgico pptx (runs, layouts
  del propio deck, minimal diff) + reglas de diseño profesional.
- `sandbox/skills/docx.md` reforzada: contrato de preservación (nunca
  rebuild, minimal diff, analizar antes de editar, clonar formato vecino,
  numPr para list items, no tocar sectPr, needle split entre runs).
- `doc-agent/skills.js` (bloques inline del sandbox agent): mismos contratos
  añadidos a los skills docx y pptx + reglas de diseño para decks nuevos.

### Tests (registrados en backend/package.json)
- `backend/tests/pptx-design-system.test.js` — 9 tests (tokens completos por
  tema, pickTheme keywords/template/default, pickChartType, contraste).
- `backend/tests/document-pipeline-docx-professional.test.js` — 3 tests (sin
  artefactos internos + validación pasa; referencias reales solo con
  adjuntos; blueprint conserva minTables 4).
- `backend/tests/docx-list-preserving-edit.test.js` — 6 tests (numPr
  keep/strip, captura de lista, clonado con fuente del doc, fallback "• "
  con sangría, dedupe de marcadores, cuerpo nunca hereda numeración).
- Nota: `document-pipeline-100.test.js` NO está registrado en la suite y está
  roto desde antes (hace `fs.access(artifact.path)` pero el pipeline borra el
  working copy tras persistir en el artifact store — cleanup deliberado).

## Next Improvement Areas
1. **Document pipeline** — add more generator formats (EPUB, RTF, ODT)
2. **Service health probes** — endpoint health monitoring
3. **Rate limiting** — Redis-backed rate limiter for API endpoints
4. **Intent attribution learning** — feed back actual response-success signals into the lexicon/rule weights to self-improve over time.
5. **Front-end attribution panel** — UI that consumes /api/attribution-toolkit/visualize + /attribution-explainer/explain to render an explainability sidebar (UI work is out of scope for this branch per CLAUDE.md rules).
6. **PPTX theme gallery UI** — exponer `listPptxThemes()` para que el usuario elija tema; branding por usuario (logo/colores corporativos) en `pptx-design-system`.
7. **OMML math** — fórmulas Word nativas (hoy texto Cambria Math en el camino docx-js).

## Billing helpers — added 2026-05-26 (feature-cost-estimator.js)

Single source of truth for credit costs + USD labels + plan
recommendations, used by `/api/free-ia/info`, `/api/free-ia/digest`,
`/api/free-ia/plans`, `/api/free-ia/estimate`:

- `estimateCost(feature, {textLength})` — per-call credit cost + breakdown
- `estimateCostBatch(items)` — fan-out preview with usdLabel per item
- `estimateMonthlyCost(usage)` — monthly projection with totalMonthlyUsd
- `getRecommendedPlan(usage)` — cheapest plan fitting projected spend
- `getCostDelta(currentPlan, recommendedPlan)` — $ delta for upsell
- `formatCreditsAsUsd(credits)` — "≈ $0.05" label format
- `creditsToUsdCents(credits)` — integer-cent for financial reports
- `creditsForUsd(usd)` — inverse of creditsToUsdCents (top-up flows)
- `enrichPlanWithPricing(plan)` — full plan-card data + popular flag
- `validatePlanName(plan)` — cheap pre-Zod validator (case-insensitive)
- `pricingTable()` — all enriched plans sorted by price (UI grid + dropdowns)
- `quickEstimate(features[])` — minCost-only fan-out for marketing tables
- `monthlyBreakdownAsCsv(projection)` — RFC-4180 CSV export for Excel/Sheets
- `monthlyBreakdownAsMarkdown(projection)` — GFM table for chat answers
- `comparePlans(from, to)` — structured plan-vs-plan diff for upsell UI
- `recommendUpgradeFromUsage(usage, currentPlan)` — one-call upsell helper
- `findCheapestPlanForBudget(maxUsd)` — best plan within $/month budget
- `affordsFeature(plan, feature, usage)` — pre-flight budget check
- `explainBudgetVerdict(plan, feature, usage)` — human-readable banner text
- `pricingFAQEntries()` — chat-AI knowledge base (7 q/a pairs)

Pricing constants:
- `USD_PER_CREDIT = 5/100_000` (PRO ratio)
- `PLAN_PRICES_USD = { FREE:0, PRO:5, PRO_MAX:10, ENTERPRISE:2 }`
- `PLAN_BUDGETS    = { FREE:0, PRO:100k, PRO_MAX:300k, ENTERPRISE:null }`
- `POPULAR_PLAN    = 'PRO'`

Public endpoints exposing the helpers:
- `GET  /api/free-ia/plans`     — pricingTable
- `GET  /api/free-ia/budget`    — findCheapestPlanForBudget
- `GET  /api/free-ia/compare`   — comparePlans (?from=&to=)
- `GET  /api/free-ia/affords`   — affordsFeature + explainBudgetVerdict
- `GET  /api/free-ia/faq`       — pricingFAQEntries
- `POST /api/free-ia/estimate`  — estimateCostBatch + recommendUpgradeFromUsage (?format=csv|markdown supported)
- `GET  /api/free-ia/digest`    — userQuotaDigest with inlined planInfo + nextTier

100+ unit tests in `feature-cost-estimator.test.js`.

## Paraphrase route — public preview endpoints (no auth, no credits)

Local-compute endpoints the frontend uses to give users a
"try before you pay" experience:

- `POST /api/paraphrase/score`       — estimateAIScoreDetailed → score + components + verdict (likely_ai/mixed/likely_human) + topTells
- `POST /api/paraphrase/score/batch` — multi-text scorer with aggregate ({total, likely_ai, mixed, likely_human, avgScore})
- `POST /api/paraphrase/humanize`    — humanizeText / humanizeChunked (large inputs); no LLM call, just the AI-tell-pattern cleaner
- `GET  /api/paraphrase/surface`     — surfaceVersion + ENDPOINT_INVENTORY + FNV-1a apiFingerprint for cache invalidation

## ⚡ FlashGPT (Cerebras Llama 3.1 8B) — added 2026-05-25, rebranded to FlashGPT

Per the product brief (`/Users/luis/Downloads/SIraGPT.docx`) the free
tier and the cross-plan fallback model is Llama 3.1 8B via Cerebras.
Originally shipped under the brand name "Free IA", later rebranded to
"⚡ FlashGPT" (commit `89fa7f9b feat(free): make FlashGPT unlimited`).
The display name can be tuned per deployment via `FREE_IA_DISPLAY_NAME`.
Wiring:

- **Adapter**: `backend/src/services/ai/cerebras-client.js` — OpenAI-
  compatible wrapper for `api.cerebras.ai/v1`. Exports
  `getCerebrasConfig`, `isFreeIaConfigured`, `createCerebrasClient`,
  `buildFreeIaModelDescriptor`.
- **Env vars**: `CEREBRAS_API_KEY` (required in `.env.local`),
  `CEREBRAS_BASE_URL`, `FREE_IA_MODEL_ID`, `FREE_IA_DISPLAY_NAME`. Legacy
  `GEMA4_*` aliases still override (back-compat).
- **Catalog defaults** moved from `OpenAI/Gema4-31B` →
  `Cerebras/llama-3.1-8b/"Free IA"` in `model-quota-router.js`.
- **Auto-fallback** in `chargeCredits` middleware: on INSUFFICIENT
  balance, when Cerebras is configured, marks `req._fallbackToFreeIA`
  + sets response header `x-sira-fallback: free-ia` (with
  `x-sira-fallback-feature` + `x-sira-fallback-cost`) instead of
  returning 402. Routes opt out via `allowFreeIaFallback: false` (e.g.
  `images.js` — Free IA is text-only).
- **HTTP surface** (`/api/free-ia/*`):
    - `GET  /status`           — config + brand
    - `GET  /configured`       — boolean
    - `GET  /brand`            — brand constants (no Cerebras dep)
    - `GET  /health`           — k8s liveness/readiness (503 when degraded)
    - `GET  /metrics`          — redacted public JSON summary
    - `GET  /metrics/summary`  — one-line digest (`?format=text` for plain)
    - `GET  /metrics.prom`     — protected alias of the unified Prometheus exposition
    - `GET  /info`             — single-call aggregator for picker first paint
    - `POST /metrics/reset`    — admin-only counter reset
  Read endpoints are public except `/metrics.prom`, which uses the shared
  operational metrics policy (`METRICS_TOKEN`, validated super-admin session,
  or explicitly enabled direct loopback). API keys are NEVER leaked.
- **Provider routing** in `ai.js` `createProviderClient('Cerebras')` and
  helper `inferProviderFromModelId` so a `llama-3.1-*` model id always
  routes to Cerebras.
- **Tests** (107+ tests covering the feature, all deterministic):
  `cerebras-client.test.js` (19), `charge-credits-middleware.test.js` (15),
  `plan-credits-catalog.test.js` (8), `free-ia-route.test.js` (14),
  `free-ia-metrics.test.js` (22), `provider-inference.test.js` (11),
  `paraphrase-humanizer.test.js` (21), `paraphrase-engine.test.js` (9),
  `paraphrase-route.test.js` (14).
- **Observability**: `backend/src/services/free-ia-metrics.js` — tiny
  in-memory counter for fallback events (`recordFallback`, `snapshot`,
  `toPrometheusText`). Business attempt/success/error counters are emitted
  by the validated paraphrase handler; instrumented Cerebras calls keep
  provider outcomes separate. Per-feature labels are normalized and capped
  with `__other__`. Exposed via
  `GET /api/free-ia/metrics` (JSON); `GET /api/free-ia/metrics.prom` delegates
  to the protected unified Prometheus handler.
- **Provider routing helper**: `backend/src/services/ai/provider-inference.js`
  — extracted out of `routes/ai.js` for proper coverage. Adds bare-id
  mappings for Anthropic (`claude-*`), Groq (`-versatile`), Mistral
  (`mistral-*`, `codestral-*`); recognises more OpenRouter slug
  prefixes (`qwen/`, `mistralai/`, `cohere/`, `nousresearch/`).

## Paraphrase Humanizer (anti-AI-detection) — added 2026-05-25

Per the spec ("que no jale ia en turnitin"), the paraphrase route now
ships with a rule-based humanizer that runs after the LLM pass to
reduce AI-detector flagging.

- **Module**: `backend/src/services/paraphrase-humanizer.js` — zero-dep,
  deterministic. Replaces 30+ LLM-favourite tells in EN + ES
  ("furthermore", "moreover", "delve", "cabe destacar que",
  "sin embargo", "en conclusión", ...), collapses em-dash overuse,
  boosts burstiness by splitting long sentences. Exports `humanizeText`,
  `estimateAIScore`, `listAITellPatterns`.
- **Wiring**: `/api/paraphrase` applies it automatically for
  `mode === 'humanize'`; other modes opt in with `?humanize=1`. The
  response carries `stealth: { aiScoreBefore, aiScoreAfter, deltaScore,
  transformations, intensity }`.
- **Tunable text cap**: `PARAPHRASE_MAX_TEXT_LENGTH` env var caps
  per-request input length (default 20_000 chars, hard upper 100_000).
- **Per-mode similarity ceilings** (`paraphrase-engine.js`
  `MODE_SIMILARITY_CEILINGS`): humanize/creative 0.55, academic 0.60,
  formal 0.70, shorten 0.78, others 0.72. Caller-supplied
  `maxSimilarity` still wins.
- **Tests**: `paraphrase-humanizer.test.js` (18), `paraphrase-engine.test.js`
  (+6 new for per-mode ceilings).

## GitHub + worldwide research search agents — added 2026-06-04

Discovery layer that lets the chat agent mine open-source projects and
peer-reviewed literature on demand. No new npm deps — stdlib `fetch` + the
existing in-repo reliability utilities.

### `src/services/github-search.js`
Unified search over the GitHub REST API: repositories / code / issues+PRs /
users+orgs / topics, plus `getRepo` / `getReadme` (base64-decoded) and a
`rateLimit` snapshot. Canonical normalised shapes, deterministic star-ranking,
TTL+LRU cache (`github-search-cache.js`), polite User-Agent, optional
`SIRAGPT_GITHUB_TOKEN || GITHUB_TOKEN` (lifts rate limit 10→30/min and unlocks
the token-only code corpus). GitHub 403/429 surfaced as captured errors; degrades
gracefully (e.g. `searchAll` silently drops code search when unauthenticated).
- **Resilience**: outbound calls wrapped in `withRetry` (retry-with-backoff) —
  bounded retry on transient failures only (5xx / 429 / network / timeout),
  never on 4xx incl. 403 quota. Env: `GITHUB_SEARCH_MAX_RETRIES` (default 1),
  `GITHUB_SEARCH_RETRY_BASE_MS` (default 250), `GITHUB_SEARCH_RETRY_DISABLED`,
  `GITHUB_SEARCH_CACHE_TTL_MS` / `_MAX`.
- **Route**: `POST /api/github-search`, `POST /api/github-search/all`,
  `GET /api/github-search/readme`, `GET /api/github-search/health` (authenticated).
- **Tests**: `tests/github-search.test.js` — 22 offline tests (mocked fetch).

### Scientific search — worldwide sources
`scientific-search.js` extended from 7 → 10 providers, adding DOAJ (open-access
journals from ~130 countries), DBLP (global computer-science bibliography) and
DataCite (worldwide datasets/software/theses). All key-less + query-based.
- **Tests**: `tests/scientific-search.test.js` — 30 (was 24).

### Agentic chat tools
Both searches are now first-class tools the chat agent can invoke:
`github_search` and `scientific_search` (registered in `agents/agent-tools.js`
`ALL_TOOLS`; `scientific_search` powered by `scientific-search.js`).

## Academic providers — SciELO / Redalyc / Scopus / Web of Science — added 2026-06-07

`scientific-search.js` extended from 10 → **14 providers** so the chat agent's
`scientific_search` tool reaches Latin-American/Iberian + commercial indices.
No new npm deps (stdlib `fetch` + existing `safeJson`/`clampLimit` helpers).
Two shared mappers were factored to avoid duplication: `mapCrossrefWork`
(CrossRef + SciELO) and `mapOpenAlexWork` (OpenAlex + Redalyc) — both preserve
the exact prior CrossRef/OpenAlex output (existing tests unchanged & green).

- **SciELO** (`searchSciELO`, key-free) — queried via **Crossref member 530**
  (FapUNIFESP, the SciELO DOI agency), NOT `search.scielo.org` whose JSON
  endpoint is now behind a Bunny-Shield JS proof-of-work anti-bot gate (403s
  server-side `fetch`). `openAccess:true` by definition.
- **Redalyc** (`searchRedalyc`, key-free) — via **OpenAlex pinned to the Redalyc
  source** `primary_location.source.id:S4377196100` (works whose *primary* host
  is Redalyc; the looser `locations.source.id` over-matches co-hosted works).
  `htmlUrl` points at the real `redalyc.org/articulo.oa` page; `venue:'Redalyc'`.
  Redalyc-native records often lack DOIs and OpenAlex reports `is_oa:false`.
- **Scopus** (`searchScopus`, key-gated) — Elsevier Scopus Search API
  (`X-ELS-APIKey` header, optional `X-ELS-Insttoken`). `SCOPUS_API_KEY` /
  `SCOPUS_INSTTOKEN`. STANDARD view → no abstract/PDF, first author only,
  `count≤25`. Returns `[]` (no network call) when the key is absent.
- **Web of Science** (`searchWebOfScience`, key-gated) — Clarivate **Starter
  API** (`X-ApiKey` header, `q=TS=(…)` topic search, `db=WOS`, `limit≤50`).
  `WOS_API_KEY` / `CLARIVATE_API_KEY`. Metadata only: no abstract (surfaces
  `authorKeywords` as a snippet), no PDF, no OA flag. Returns `[]` without a key.

DuckDuckGo, Brave (cached, key-gated) and Browser Automation
(`browser_navigate`/`click`/`type`/`scroll`) were already wired (see the
`web_search` adapter and `agent-tools.js` browser tools) — this change only
filled the academic-DB gap requested.
- **Route**: `GET /api/scientific-search/providers` now reports `scopus`/`wos`
  in `keysConfigured`. `scientific_search` tool description lists the new sources.
- **Tests**: `tests/scientific-search.test.js` — +7 (SciELO, Redalyc, Scopus
  no-key/with-key/empty-entry, WoS no-key/with-key); 64 total, all offline.

## Scientific-search — diversity + preprints + OA backfill — added 2026-06-13

Three upgrades to `scientific-search.js` so results actually reflect the
"diverse sources" promise and surface free PDFs. All offline-tested, lint-clean.

- **Source diversification** (`diversifyBySource`, default-on): a soft,
  relevance-preserving post-rank interleave so the top of the list isn't
  monopolised by one provider (Semantic Scholar's precise title matches used to
  fill the whole first screenful). `maxRun=2` keeps the top-2 most-relevant
  hits, then breaks runs of 3+ from one source. Opt out with `diversify:false`
  (also on `POST /api/scientific-search`). No paper dropped/duplicated; no
  starvation when only one source remains. Verified live: top-10 went 1→3 sources.
- **bioRxiv + medRxiv** (14 → **16 providers**): Cold Spring Harbor preprint
  servers as distinct sources (`source: biorxiv`/`medrxiv`), queried like
  SciELO/Redalyc via OpenAlex pinned to each server's canonical
  `primary_location.source.id` (bioRxiv `S4306402567`, medRxiv `S3005729997` —
  the alternate medRxiv `S4306400573` holds 0 works). Key-free, abstracts via
  the OpenAlex inverted index, htmlUrl → the preprint landing page. Shared
  `searchPinnedOpenAlexSource` helper. They feed the diversification pass too.
- **Unpaywall OA PDF backfill** (`enrichWithUnpaywall`, opt-in via
  `opts.unpaywall`): closed-index hits (Scopus/WoS/CrossRef/PubMed/DBLP) often
  carry a DOI but no PDF; Unpaywall (key-free, REQUIRES a contact email) maps
  DOI → best legal OA copy. Bounded + best-effort: skipped without
  `SIRAGPT_RESEARCH_EMAIL`, capped at `maxEnrich` (default 8) parallel lookups
  with a tight timeout, never throws. Opt-in so default search latency is
  unchanged. Exposed on the route + the `scientific_search` agent tool.
- **Wiring**: `research-agent.js` inherits all three automatically (it calls
  `scientificSearch.search`). `scientific_search` tool description + provider
  hints updated. `tests/scientific-search.test.js` — 53 total (+12: diversify,
  biorxiv/medrxiv, unpaywall), all offline.

## Brave Search + X (Twitter) search — added 2026-06-07 (production-hardened)

Two more discovery providers/tools, both key-gated and degrading gracefully
to the existing free, key-less path when unconfigured. No new npm deps. Both
mirror the `github-search` resilience conventions (transient-only `withRetry`).

### Brave Search (web_search provider)
- **File**: `src/services/agents/web-search/providers/brave.js` — added to the
  `web_search` adapter chain (`web-search/index.js`) at **priority 8** (head of
  the general-web tier, before DuckDuckGo=10). Gated on `BRAVE_SEARCH_API_KEY`
  (alias `BRAVE_API_KEY`): the provider's `enabled` getter returns false with no
  key, so `sortProviders` skips it and the chain falls through to the free
  **DuckDuckGo → Wikipedia → SearXNG** providers. Header auth
  (`X-Subscription-Token`), locale → `search_lang`/`country`, HTML-tag stripping,
  dedupe. Returns `[]` (not a throw) on empty results.
- **Hardening**: transient-only `withRetry` (429/5xx/network/timeout retried,
  other 4xx never — `classifyBraveError` + `BraveHttpError`); env
  `BRAVE_SEARCH_RETRY_DISABLED` / `_MAX_RETRIES` / `_RETRY_BASE_MS` /
  `_TIMEOUT_MS`. `freshness` time filter (`pd|pw|pm|py` or `day|week|month|year`,
  bilingual, or an ISO date range) **threaded end-to-end** from the `web_search`
  tool → adapter → provider (cache bucket keeps fresh/non-fresh distinct).
  `extra_snippets` merged into snippets; optional `news` results folded in
  (`source:'brave-news'`, `age` field) when freshness/news requested. Internal
  abort timeout for direct (non-adapter) callers.
- **searchBrain**: the universal catalog's `brave-search` entry
  (`searchBrain/universal/providers/catalog.js`) flipped from `disabled(...)` to
  a real key-gated provider (reads `keys.brave` or env).
- **Tests**: `tests/web-search-brave.test.js` (19), `tests/web-search-adapter.test.js`,
  + 2 cases in `tests/searchbrain-economic-providers.test.js`.

### X (Twitter) search — `x_search` tool + `/api/x-search` route
- **File**: `src/services/x-search.js` — xAI **Live Search** wrapper. Forces
  `search_parameters: { mode:'on', sources:[{type:'x'}], return_citations:true }`
  on the OpenAI-compatible `/chat/completions` endpoint so Grok retrieves recent
  X posts; parses the summary + top-level `citations[]` into `{ url, source }`
  (host-aware `x` vs `web` tagging). Key-gated on `XAI_API_KEY` (base
  `https://api.x.ai/v1`, model `X_SEARCH_MODEL || XAI_GROK_MODEL || grok-4.3`).
  With no key `isConfigured()` is false and `search()` returns
  `{ configured:false, note }` WITHOUT any network call. Injectable `fetchImpl`;
  query-free errors.
- **Hardening**: transient-only `withRetry` (`classifyXSearchError` +
  `XSearchHttpError`; env `X_SEARCH_RETRY_DISABLED` / `_MAX_RETRIES` /
  `_RETRY_BASE_MS`); optional extra `sources` (web/news) alongside X + `mode`
  override; in-memory metrics (`x-search-metrics.js`: searches/posts/errors/
  unconfigured + Prometheus text).
- **Tool**: registered in `agents/agent-tools.js` (`x_search`, args
  `query`/`maxResults`/`handles`/`fromDate`/`toDate`), wired into
  `agentic-chat-stream.js` `baseWebTools`.
- **Route**: `src/routes/x-search.js` mounted `/api/x-search` (parity with
  github/scientific-search): `POST /` (auth + express-validator), `GET /health`,
  `GET /metrics`, `GET /metrics.prom`. API key never leaked in any payload.
- **Tests**: `tests/x-search.test.js` (25), `tests/x-search-metrics.test.js` (8),
  `tests/x-search-route.test.js` (5) — all offline.

## siraGPT Builder — constructor full-stack tipo Replit (added 2026-06-05)

Constructor de apps estilo Replit/Lovable/bolt dentro de SiraGPT: el usuario
describe una idea → un agente hace **seguimiento con preguntas** hasta tener
contexto total → genera plan + archivos → el usuario **ve el código** y una
**vista previa**. Roadmap completo (epics E1–E6 + desktop) en Notion:
"siraGPT Builder · Roadmap". **Excepción a la regla #1**: para esta feature el
usuario autorizó que Claude construya también la UI.

### Backend (`backend/src/services/builder/`)
- `contracts.js` — `COVERAGE_DIMENSIONS` (purpose/platform/coreFeatures/
  dataEntities/style/audience), `QuestionCardSchema`, `ProjectBriefSchema`.
  **`platform` ∈ web | mobile | landing | desktop** (desktop añadido 2026-06-05).
- `intake-engine.js` — entrevista pura/stateless: `coverage`, `nextQuestion`,
  `buildBrief`, `normalisePlatform` (detecta desktop *antes* que mobile para que
  "Electron app"/"escritorio" no caigan en la regla de "app").
- `questions.js` — banco estático de QuestionCards (chip `desktop` incluido).
- `blueprint.js` (E2) — plan determinista; `STACK_BY_PLATFORM.desktop` =
  Electron + React / Node main / SQLite·PostgreSQL / GitHub Releases.
- `scaffold.js` (E3) — archivos starter (preview.html, README, .env.example,
  prisma/schema.prisma).
- `preview.js` (semilla E5) — `buildPreviewHtml(brief)`: HTML autocontenido,
  determinista, **escapado anti-inyección**, temado (oscuro/minimalista/
  corporativo/colorido/moderno) y con marco por plataforma (teléfono / ventana
  desktop / web). Seguro para `<iframe srcdoc>` sandbox (sin JS).
- `llm.js` — adapter LLM por tiers sobre `ai/cerebras-client.js` (FlashGPT/
  Cerebras gratis). **Fail-open a determinismo**: devuelve `null` si no hay key/
  error/timeout/JSON inválido → el caller usa el banco estático. Inyectable
  (`createClient`, `env`) para tests sin red. `extractJson` tolera fences/prosa.
- `question-generator.js` — `generateNextQuestion(session, dimension)`: pide al
  LLM una QuestionCard **contextual** (seguimiento), la valida contra el schema
  y **fuerza la dimensión**; cualquier fallo → fallback al banco estático.
- `codegen.js` (E3+) — **codegen real**: `codegenFromBrief(brief, blueprint?)`
  genera un proyecto **Next.js 14 ejecutable** (App Router, TS) — no solo docs.
  Corre con `npm install && npm run dev` **sin DB**: cada entidad obtiene una
  API route CRUD en memoria (`lib/store.ts`) + página lista/alta. Emite
  `package.json`/`tsconfig.json`/`next.config.mjs`/`app/layout.tsx`/
  `app/page.tsx` (hero+features) /`components/site-nav.tsx` y, por entidad,
  `app/api/<slug>/route.ts` + `app/<slug>/page.tsx`. Slice vertical: solo
  plataformas Next.js (**web/landing**); mobile/desktop → `generated:false` y
  el caller conserva los starters. Puro/determinista, **escapado anti-inyección**
  (jsStr/jsxText) en todo texto del brief. Cableado aditivamente en
  `scaffold.js` (sin colisión de paths).

### Rutas (`backend/src/routes/builder.js`, montado `/api/builder`)
- `GET /intake/questions` — catálogo de cards.
- `POST /intake/step` — `{ session?, answer?, integrations?, constraints?,
  dynamic? }` → `{ session, coverage, nextQuestion, complete, dynamic }`.
  Con `dynamic:true` la próxima pregunta se genera con LLM (auto-fallback).
- `POST /intake/brief` → `{ brief }` (cuando la cobertura está completa).
- `POST /blueprint` → `{ blueprint }` (E2). `POST /scaffold` → `{ blueprint, files }` (E3).

### Frontend (UI — regla #1 levantada para esta feature)
- `lib/builder/intake-service.ts` — cliente tipado (patrón `projects-service`:
  `localStorage "auth-token"` Bearer, `credentials:include`).
- `lib/builder/useIntake.ts` — hook dueño del `session` (round-trip), orquesta
  entrevista → `generate()` (brief → scaffold). `lib/builder/dimensions.ts` —
  meta (label/ícono) por dimensión.
- `components/builder/` — `QuestionCard` (chips/select/multiselect/text),
  `CoverageRail` (stepper %), `ResultPanel` (tabs **Preview** [iframe] / Plan /
  Código con visor + copiar), `BuilderIntake` (shell del chat).
- `app/builder/page.tsx` — página "build studio" oscura, acento violeta
  (`--accent-violet`), Geist Sans/Mono.

### Tests (registrados en `backend/package.json`)
`builder-contracts` · `builder-intake` · `builder-route` · `builder-preview` (7)
· `builder-llm` (7) · `builder-question-generator` (8). Todos verdes; el banco
estático mantiene el camino sin red.

### Env
- `CEREBRAS_API_KEY` — activa el intake dinámico (sin ella, todo cae al banco
  estático). Modelo/baseURL via `FREE_IA_MODEL_ID` / `CEREBRAS_BASE_URL`.

### Pendiente
Codegen real para mobile/desktop (hoy solo web/landing) · ejecutar el proyecto
generado en vivo / WebContainers (E5) · persistencia de builds (T2 schema + T8
repo) · brief-synthesizer LLM (T6) · orquestación multi-agente con
ProjectContext compartido (E6). **Hecho:** intake agéntico (LLM + dynamic) ·
codegen real Next.js web/landing (E3+, `codegen.js`).

## /code · Generador de Landing Pages Vite 7 + React 18 + TS — added 2026-06-11

El generador del módulo `/code` (http://localhost:3000/code, modo App) emite un
**proyecto Vite 7 + React 18 + TypeScript real** para AMBOS goals (`landing` y
`app`), ejecutable con ▶ Ejecutar (runner Bun, `bun install` + `bunx vite
--port 5173`). Spec: `docs/code/landing-generator-prompt.md` · plan + decisiones:
`docs/code/plan.md`.

- **Contrato** (`VITE_LANDING_CONTRACT_PATHS` en `lib/code-agent/vite-scaffold.ts`,
  única fuente de verdad, importada por `prompts.ts`): package.json ·
  vite.config.ts · tsconfig.json · index.html · src/main.tsx · src/index.css ·
  src/App.tsx. Stack: Tailwind **v4 vía `@tailwindcss/vite`** (sin
  tailwind.config.js/postcss.config.js — `@import "tailwindcss"` + paleta CSS
  vars en :root + `@theme inline`), framer-motion ^11 (`useInView`, once),
  lucide-react, Syne + Space Grotesk. Componente OBLIGATORIO «Invitar al
  proyecto» (enlace privado readOnly + subtexto exacto «Cualquier persona con el
  enlace tendrá acceso de edición» + Copiar con «¡Copiado!» + invitar por email).
- **Tiers de generación** (`dispatch` en `components/code/ai-code-chat-panel.tsx`):
  motor OpenCode (write/edit, `engineTransportInstructions()`) → streaming LLM
  (bloques fenced `streamOutputFormat()`: un bloque por archivo, ruta SOLO en el
  encabezado ` ```json package.json ` — NUNCA `// path:` dentro del contenido,
  rompe package.json) → determinista.
- **Fallback determinista sin LLM/red**: `lib/code-agent/vite-scaffold.ts` +
  `vite-app-template.ts` + `escape.ts` (jsStr/jsxText/escapeHtml/pickAccentHex,
  anti-inyección con whitelist de paleta/iconos; mismo ctx → bytes idénticos).
  Goal `app` determinista sigue usando `/api/builder/generate` (Next.js CRUD)
  con fallback offline a la landing local.
- **Preview**: `lib/code-preview-build.ts` detecta proyectos Vite/Next
  (package.json con vite/next) y muestra el placeholder «pulsa ▶ Ejecutar» en
  vez de un srcdoc en blanco; `preview-pane.tsx` espera ~3 min (instalación
  fría); el runner (scripts/code-runner.js) mata el dev server zombie al agotar
  los 90s y docker-compose monta `runner_bun_cache` para reinstalaciones tibias.
- **Tests**: `tests/code-agent-vite-scaffold.test.ts` (contrato, determinismo,
  strings de Invitar, resistencia a inyección con parse TSX vía
  `ts.createSourceFile`, theming) + casos Vite en `tests/code-preview-build.test.ts`.
  Tier node --test del root (`npm test`); `tests/lib/` es solo-vitest.

## Agent-first chat + prompted tool-calling — added 2026-06-09

Todo chat nuevo ES un agente (SWE-agent ACI, arXiv:2405.15793 + harness
engineering 2025-26: fallback ladder de tool-calling, budgets en código,
capability gating). Tres cambios:

### 1. Agent-first routing (`agentic-chat-stream.js shouldUseAgenticChat`)
Default invertido: TODA conversación entra al loop agéntico (web_search,
artefactos, documentos, media) excepto smalltalk trivial (`SIMPLE_CHAT_PROMPT`)
y Q&A simple sobre documento adjunto (texto ya inyectado; stream plano es
mejor). La ruta sigue cayendo al stream plano en cualquier run degradado, así
que agent-first nunca cuesta una respuesta. `SIRAGPT_AGENT_FIRST=0` restaura
el routing heurístico legacy.

### 2. Prompted tool-calling (`agents/prompted-tool-calling.js`)
Escalera de fallback para que CUALQUIER modelo maneje el loop:
- `resolveToolCallMode(provider, model)` → `native` (allowlist OpenAI-style) |
  `prompted` (el resto) | `none` (solo si `SIRAGPT_PROMPTED_TOOLS=0`).
- En modo prompted, react-agent (`toolCallMode: 'prompted'`): describe el
  registry en el system prompt (protocolo de bloque ```tool_call JSON +
  worked example), convierte la traza canónica a transcript provider-safe
  (sin `tools`/`tool_choice`/`role:"tool"` — observaciones como mensajes user
  `[TOOL_RESULT <tool>]`), parsea los bloques fenced (o JSON bare con clave
  `tool`, validado contra el registry) de vuelta a `tool_calls`. tool_choice
  forzado (finalize/initial) se emula con instrucción explícita.
- Budgets en código para modelos débiles: cap de herramientas ordenado
  (`capToolsForPrompted`, `SIRAGPT_PROMPTED_MAX_TOOLS` default 10, pinnea
  intent media + RAG) y `SIRAGPT_PROMPTED_MAX_STEPS` (default 10).
- El gate duro `modelSupportsFunctionCalling` en `ai.js` fue reemplazado por
  `resolveToolCallMode`; el modo viaja a `runAgenticChat` y queda en
  `state.meta.runtime.toolCallMode`.

### 3. Creation tools siempre disponibles (`buildDefaultTools`)
Las herramientas de creación (generate_image/video/speech/music + las 30+
diagram/chart tools) se cargan en CADA turno agéntico (un "ahora hazme un
diagrama de eso" a mitad de conversación funciona sin intent inicial). El
tool-selector per-turn mantiene el set efectivo pequeño.
`SIRAGPT_MEDIA_TOOLS_ALWAYS=0` restaura la carga intent-gated.

### Tests
`tests/prompted-tool-calling.test.js` (13) · `tests/react-agent-prompted.test.js`
(5, e2e con cliente fake que verifica payload provider-safe) ·
`tests/agentic-chat-stream.test.js` actualizado (agent-first default + env-off
legacy + resolveToolCallMode + media-always). Registrados en `backend/package.json`.

## Agent harness multi-modelo — Fase 1 (added 2026-06-09)

Convierte cada turno agéntico del chat en un agente estilo Claude con eventos
tipados, gate de permisos y MCP externo, sobre el loop existente
(react-agent + agentic-chat-stream) y el protocolo SSE de razonamiento.

### Backend (`backend/src/services/agent-harness/`)
- `model-capabilities.js` — registry de capacidades por modelo (familias
  OpenRouter: Claude/GPT/Gemini/DeepSeek/Llama/Qwen/Mistral/Kimi/Grok/gpt-oss):
  supportsNativeTools/ParallelToolCalls/Reasoning(+estilo)/contextWindow/
  maxOutputTokens/supportsImages/supportsPromptCaching; defaults conservadores;
  overrides por env `SIRAGPT_MODEL_CAPS_OVERRIDES` (JSON) o settings, AUTORITATIVOS
  en ambos sentidos. `supportsNativeToolTransport` distingue capacidad del modelo
  vs transporte del provider (Anthropic/Mistral directos → prompted).
  `resolveToolCallMode` delega aquí (legacy allowlist solo como fallback de carga).
- `tool-registry.js` — tools declarativas {name, description con cuándo-usar/
  cuándo-no, inputSchema Zod, permissionTier auto|confirm, humanDescription(args),
  execute}; proyección a formato OpenAI (zod-to-json-schema) y a react-agent;
  overlay de metadata (tier/labels) para las ~80 tools existentes y MCP.
- `tools/` — `web_fetch` (open-world con denylist: IP privadas/loopback/metadata
  bloqueadas en URL+DNS anti-rebinding, redirects manuales re-validados ≤5,
  Readability→Turndown→cheerio, cap 50k con marcador), `run_javascript`
  (quickjs-emscripten WASM: 5s interrupt, 64MB, sin require/fs/net/timers,
  console capturada, promesas pump-eadas), `create_artifact` (integra
  task-tools saveArtifact + evento file_artifact existente), `web_search`
  (solo si el toolset no trae uno; delega en agents/web-search).
- `event-stream.js` — eventos SSE tipados con blockIndex+seq monotónicos:
  tool_call_start/tool_executing/tool_result/permission_request/
  permission_resolved/agent_done(steps,toolCalls,durationMs,tokensEstimate);
  graba steps para persistencia (result cap 30k con marcador); wrapTools()
  envuelve cada execute (errores → is_error sin abortar loop).
- `permission-manager.js` — tier 'confirm' pausa el loop (promesa pendiente,
  TTL 2min → deny); POST `/api/agent/permission` {permissionId, decision:
  allow|always_allow_in_chat|deny} (mismo usuario); always_allow cachea por chat.
- `mcp-client.js` — servidores MCP EXTERNOS por usuario (tabla `mcp_servers`,
  headers AES-256 via utils/encryption): discovery por turno (timeout 8s),
  namespacing `mcp__<srv>__<tool>`, tier confirm, llamadas con timeout 30s,
  caché de conexión con TTL, fallos por servidor NUNCA tumban el chat;
  transportes Streamable HTTP → SSE fallback. CRUD `/api/agent/mcp-servers`.
- `run-agent-turn.js` — `attachHarness` (merge + wrap + events) llamado por
  `runAgenticChat` (exportado también como `runAgentTurn`); kill switch
  `SIRAGPT_AGENT_HARNESS=0`; en prompted no se cargan MCP y aplica el cap.
- `agent-steps-store.js` + migración `20260609190000`: tabla `agent_steps`
  (FK message_id CASCADE, full fidelity) + `messages.agent_metadata` JSONB
  (proyección compacta para hidratar historia sin join).

### Frontend
- `components/agent-trace.tsx` — AgentTrace: evolución de ThinkingTrace (mismo
  shimmer/markdown) + timeline de tools (rail conector, iconos por familia,
  spinner dotm-circular-15 en ejecución, check/error, chip args/result con
  CustomCodeBlock y tinte rojo en error), tarjeta de permiso inline (Permitir /
  Permitir siempre en este chat / Denegar), colapso automático en agent_done a
  "Pensó Xs · usó N herramientas". Mensajes históricos hidratan desde
  `agentMetadata` (extractAgentTrace en message-component).
- `lib/api.ts` — tipos AgentStreamEvent + dispatch onAgentEvent +
  `apiClient.resolveAgentPermission`. `lib/chat-context-integrated.tsx` —
  createAgentTraceHandlers (orden blockIndex/seq, dedupe por seq ante
  reconexión). `agentic-steps.tsx` acepta `hideSteps` (cuando AgentTrace está
  activo el sentinel solo aporta artifacts — una sola timeline).
- i18n: namespace `agent` en los 59 locales (16 traducciones a mano + EN
  fallback) vía `scripts/add-agent-locale-keys.js`.

### Tests
`tests/agent-harness-core.test.js` (capacidades+paridad legacy, registry,
eventos, permisos) · `tests/agent-harness-tools.test.js` (SSRF matrix,
redirects, sandbox límites/aislamiento, create_artifact e2e) ·
`tests/agent-harness-mcp.test.js`. Registrados en `backend/package.json`.

### Gotchas
- El cliente directo Anthropic/Mistral NO habla tool_calls OpenAI → prompted
  (los slugs `anthropic/...`/`mistralai/...` vía OpenRouter sí son native).
- `OPENROUTER_API_KEY` está VACÍA en el .env local — los modelos OpenRouter
  caen al failover local; probar OpenRouter real solo en prod.
- E2E local: JWT debe tener fila en `sessions`; backend de pruebas:
  `PORT=5151 node index.js` con la BD localhost.

### Fase 1b (added 2026-06-09, mismo día)
- **UI de ajustes para MCP**: `components/settings/McpServersCard.tsx`
  (patrón MemorySettingsCard, montada al inicio de la sección Apps de
  `app/settings/page.tsx`): lista con toggle enabled + borrar, alta con
  nombre/URL/transporte/headers key-value (se cifran y NUNCA se vuelven a
  mostrar — la lista solo trae `hasHeaders`). Métodos en `lib/api.ts`:
  `listMcpServers/createMcpServer/updateMcpServer/deleteMcpServer` + tipo
  `McpServerInfo`.
- **`parallel_tool_calls` por capacidad**: `react-agent.run` acepta
  `parallelToolCalls` y lo incluye en el payload nativo SOLO cuando es true
  (omitido en negativo — la o-series y varios hosts OSS rechazan el
  parámetro); `runAgenticChat` lo resuelve del capability registry y la ruta
  pasa `provider: actualProvider`.
- **`costUsdEstimate` real** en `agent_done`/`agent_metadata`:
  `estimateCostUsd(provider, tokens)` en event-stream.js con los precios del
  litellm-gateway (blend 75/25 input-heavy); null si el proveedor no tiene
  tarifa (Cerebras). Fix de higiene: los separadores de `plannedKey` en event-stream.js
  llevaban bytes NUL literales (grep trataba el archivo como binario);
  reemplazados por la secuencia escapada backslash-u0000 en el fuente.

## Codex Agent V2 — experiencia agéntica tipo Replit en `/code` (added 2026-06-13)

Subsistema server-driven detrás del flag `CODEX_AGENT_V2` (off ⇒ `/api/codex/*`
→ 404 salvo `/health`; worker no registrado; `/code` idéntico a hoy). Spec:
`docs/codex-agent-ux.md`. Features trazables: `plans/codex-agent-v2/`.

### Backend (`backend/src/services/codex/`)
- `flags.js` — `isCodexV2Enabled(env)` (1/true/on).
- Modelos Prisma `codex_*` (schema.prisma): CodexProject/Run/Event/Action/Checkpoint/RunMetric
  + `CodexRun.prompt`. Migraciones `20260612120000_add_codex_tables`, `20260613100000_add_codex_run_prompt`.
- `runner-client.js` — cliente HTTP del runner (init/write/read/exec/dev); `starter-files.js`
  starter Vite determinista; `workspace.js` provisioning + `gitCommitAll`.
- `project-service.js` — CRUD de proyectos scoped por userId; enriquece el error de provisioning con remediación.
- `event-types.js` — catálogo SSE §5 + `isValidEvent`; `event-store.js` — append-only seq monotónico
  (serializado por run + retry de colisión) + `listEvents` + `createSeqGate`; `redis-pubsub.js` pub/sub
  `codex:run:<id>` best-effort; `run-access.js` ownership.
- `run-queue.js` — cola `codex-runs` + worker flag-gated; `run-processor.js` lifecycle del job
  (run_status, hard timeout, cancel cooperativo, transición terminal status-guarded); `run-service.js`
  createRun/cancelRun/get/list (gates mode/ownership/planRunId/single-active-409); `boot-recovery.js`.
- `agent-loop.js` — loop LLM↔herramientas (narrative/reasoning/action_* por groupId, budgets, cancelación,
  closeBuild = checkpoint→diffstat→métrica→run_summary); `plan-mode.js`; `build-tools.js` (5 tools);
  `llm-turn.js` (Cerebras + prompted-tool-calling); `action-store.js`.
- `checkpoint-service.js` — commit/rollback/diff git real; `run-metrics.js` + `cost-resolver.js`
  (provider_exact/openrouter_generation/estimated) + `pricing-policy.js` (multiplicador por plan);
  `error-patterns.js` clasificador (bloqueante→action_required, benigno→anotación); `config-validator.js`.

### Rutas (`backend/src/routes/codex.js`, montado `/api/codex` tras codex-runs legacy)
`GET /health` (público) · `POST/GET /projects` · `GET /projects/:id` · `*/preview/{start,status,stop}` ·
`POST/GET /projects/:id/runs` · `GET /projects/:id/runs/:runId` · `POST /runs/:id/cancel` ·
`GET /runs/:id/stream` (SSE replay+live) · `POST /checkpoints/:id/rollback` · `GET /checkpoints/:id/diff` ·
`GET /projects/:id/checkpoints`. Creación/lectura de runs scoped por proyecto para no sombrear el codex-runs legacy.

### Frontend (`lib/codex/`, `components/codex/`)
- `timeline-reducer.ts` (puro, dedup por seq, IDs idempotentes) · `run-stream.ts` (SSE fetch, reconexión
  con backoff, corta en 4xx) · `use-codex-run.ts` · `use-stick-to-bottom.ts` · `codex-api.ts` ·
  `use-codex-health.ts` · `model-tiers.ts` · `format.ts` · `workspace-tabs.ts`.
- `run-timeline.tsx` + action-chips-row/reasoning-block · cards plan/checkpoint/run-summary/action-required ·
  `composer.tsx` (+ plan-toggle/power-selector/dictation-button) · bottom-tab-bar/web-tab/checklist-tab ·
  `codex-agent-panel.tsx`. Montado en `app/code/page.tsx` solo si `health.enabled`.

### Tests
~30 archivos `backend/tests/codex-*.test.js` (node --test) + `tests/lib/codex/*` y
`tests/components/codex-*` (vitest, **`--pool=threads`** — el pool forks cuelga en esta máquina).
E2E con git real en tmpdir: `codex-e2e-flow.test.js`. Golden replay: `tests/lib/codex/golden-replay.test.ts`.

### Envs
`CODEX_AGENT_V2` · `CODE_RUNNER_URL`/`CODE_RUNNER_DEV_URL` · `REDIS_URL` (cola+pubsub) ·
`CODEX_WORKER_CONCURRENCY` (2) · `CODEX_RUN_TIMEOUT_MS` (15min) · `CODEX_MAX_STEPS` (24) ·
`CODEX_MAX_TOOLS_PER_TURN` (4) · `CODEX_COST_PROMO_MULTIPLIER` · `CEREBRAS_API_KEY` (LLM).
`logCodexConfig()` valida coherencia al boot.
Autoscaling en caliente del worker: `CODEX_WORKER_MAX_CONCURRENCY` (8; techo, si ≤ floor
desactiva) · `CODEX_AUTOSCALE_QUEUE_DEPTH` (3) · `CODEX_AUTOSCALE_STEP` (2) ·
`CODEX_AUTOSCALE_SCALE_DOWN_MS` (120s) · `CODEX_AUTOSCALE_INTERVAL_MS` (15s).

### Gotchas
- vitest forks pool cuelga aquí → usar `--pool=threads`.
- Tests e2e/integración deben `delete process.env.REDIS_URL` o el publish abre una conexión ioredis
  que mantiene vivo el proceso (cuelga node --test).
- git-real tests: `git config core.autocrlf false` en el repo temporal (Windows CRLF rompe la comparación byte-a-byte).

## Paridad con Claude Code web — etapas publicadas (2026-09-11)

Diagnóstico completo (14 dimensiones, brechas P0/P1/P2 con evidencia) en la página
"Paridad con Claude Code" del 11-sep-2026. Cinco etapas backend, sin UI, ya en `production-main`:

| PR | Etapa | Qué cambia |
|---|---|---|
| #690 | Base segura + modelo | `codex/deepseek-turn.js`: DeepSeek V4 con tool-calling NATIVO para todos los tiers (power → v4-pro, resto → v4-flash); ladder `deepseek → anthropic → openrouter → cerebras` con `exclude`. Runner heredado `github/workspace-runner.service.js` OFF en producción (`SIRAGPT_WORKSPACE_RUN_ENABLED=1` opt-in). |
| #691 | Sesión = repo | `POST /api/codex/projects/clone` clona repos PRIVADOS con el OAuth GitHub del usuario (`-c http.<github>.extraheader`, remote limpio), rama por defecto real, 404 sin acceso; `github/plan` y `github/publish` usan el OAuth guardado si no llega `githubToken`. |
| #692 | Aviso al terminar | `agents/task-store` publica `agent.task.{completed\|failed\|cancelled}` una vez por tarea; `user-notifications` crea la fila de bandeja con `metadata.actionUrl → /agentes/<chatId>`. `SIRAGPT_AGENT_TASK_NOTIFY`. |
| #693 | CI del PR | Tool `github_checks` (`codex/github-checks.js`): checks de la rama `run/<id>`, una `ref` o un `pr`, pasos fallidos de Actions, con la cuenta del usuario. |
| #694 | Memoria y Biblioteca | `codex/user-memory.js` inyecta la memoria Hermes del usuario en el system prompt de codex (`CODEX_USER_MEMORY*`); `use_skill` alcanza los skills de la Biblioteca del usuario. |
| #697 | Repo vinculado al chat | `POST /api/codex/projects/clone` acepta `chatId` (brief.chatId, 409 `chat_already_bound`); `GET /api/github/repos/:owner/:repo/branches`; `publicProject` expone `sourceControl` + `chatId`. UI: `components/agentes/coding-repo-picker.tsx` («Vincular repositorio» → repo + rama → «Abrir en este chat», chip `owner/repo · rama`) montado en `coding-ide-shell.tsx`. Primer levantamiento parcial del UI lock para `/agentes` (re-baseline solo de los archivos tocados). Visible con `AGENTES_CODING_V2=1`. |
| #700 | Cambios y Crear PR | `codex/workspace-changes.js` (cambios del workspace vs rama base, untracked inline, cap; `prepareWorkspaceBranch` → `run/agentes-<proyecto>-<fecha>` + commit). `GET /api/codex/projects/:id/changes` y `POST /api/codex/projects/:id/github/publish-workspace` (428 plan → `confirm` → PR con el OAuth del usuario; repo/base del brief; exige allowlist `CODEX_SELF_HOST_GIT_HOSTS`). UI: pestaña «Cambios» (`components/agentes/coding-changes-pane.tsx`) en el shell: lista de archivos, diff por archivo, «Crear PR» → «Confirmar y abrir PR». |

Pendiente que requiere a Luis: GitHub App (claves en `.env` prod + Replit), cierre del catálogo
de modelos por código, runner aislado gVisor en la Lenovo, `MCP_ALLOWED_HOSTS`, encender
`AGENTES_CODING_V2=1` en producción para exponer el shell de IDE. El UI lock se levanta por
etapas para `/agentes` (Luis lo autorizó el 2026-09-12): cada PR re-baselinea solo los archivos
que toca. Siguiente etapa: montar el flujo de codex (selector de repo, Cambios, PR) en el chat cuando codex esté encendido, no solo bajo `AGENTES_CODING_V2`; sesiones paralelas visibles. Envs nuevas documentadas en
`docs/ENV_VARIABLES.md`.

## Codex Agent — Claude Code parity + Agent SDK (added 2026-07-02)

El loop de APPS (/code) ahora se comporta como Claude Code: modelo fuerte con
failover, verificación real y subagentes especializados. Todo backend (cero
cambios de UI — el timeline ya tolera los kinds nuevos).

### `codex/llm-provider.js` — escalera multi-proveedor
`chatComplete()` provider-agnóstico: **Anthropic (Claude) → OpenRouter →
Cerebras**, primero configurado gana; override con `CODEX_LLM_PROVIDER`.
Modelos: `CODEX_ANTHROPIC_MODEL` (default `claude-sonnet-4-6`),
`CODEX_OPENROUTER_MODEL` (default `anthropic/claude-sonnet-4.6`). Un proveedor
que lanza se pone en cuarentena 5 min y se intenta el siguiente peldaño (la
cuarentena solo re-ordena, nunca descarta). El protocolo prompted de tools es
model-agnóstico, así que subir el modelo sube todo el agente. Claude recibe
maxTokens 8192 (Cerebras conserva 2048). `llm-turn.js` usa la escalera cuando
NO se inyecta `createClient` (los tests conservan el camino legacy Cerebras).

### Tools nuevas en `build-tools.js` (10 total)
- `list_files` — `git ls-files --cached --others --exclude-standard`.
- `type_check` — `bunx tsc --noEmit` vía runner; devuelve los diagnósticos
  REALES al modelo (runner caído = informacional, no error).
- `dev_server_check` — arranca/consulta el dev server y devuelve ready/error +
  tail de logs en vivo (module not found, overlay de Vite…).
- `run_subagent` — delegación al Agent SDK (kind `agent`; `database` y `agent`
  añadidos a `ACTION_KINDS` en event-types.js — `database` faltaba).

### `codex/agent-sdk/` — subagentes especializados
Registro declarativo + mini-loop propio (presupuesto `CODEX_SUBAGENT_MAX_STEPS`,
default 8; sin delegación recursiva; solo su set de tools): `planner`,
`frontend_builder`, `backend_engineer`, `db_architect`, `qa_reviewer` y
`enterprise_analyst` (pedido de negocio → módulos, entidades, roles, flujos,
KPIs — CRM/ERP/inventario/facturación/RRHH/POS). El system prompt del loop
instruye delegar PRIMERO en enterprise_analyst para software de empresa.
Catálogo por HTTP: `GET /api/codex/agents` (auth, flag-gated) → agents + LLM
activo (`describeActiveProvider`).

### `codex/verify-loop.js` — auto-verificación al cierre del build
En `closeBuild`, ANTES del checkpoint (los fixes quedan dentro): `tsc --noEmit`
→ si hay errores, mini-loop reparador (tools read/write/edit/list, prompt de
fixer, `CODEX_VERIFY_FIX_STEPS`=4) → re-check (`CODEX_VERIFY_ROUNDS`=2).
Best-effort por contrato: nunca convierte un build exitoso en error. Se salta
workspaces sin package.json/tsconfig.json. Off con `CODEX_AUTO_VERIFY=0`.

### Tests
`codex-llm-provider.test.js` (13) · `codex-agent-sdk.test.js` (12) ·
`codex-verify-loop.test.js` (8) · `codex-build-tools-v3.test.js` (12) —
registrados en backend/package.json. Los tests del agent-loop fijan
`CODEX_AUTO_VERIFY:'0'` en su env fake para seguir enfocados al loop.

### Envs nuevos (todos opcionales)
`ANTHROPIC_API_KEY` (activa Claude en el loop) · `CODEX_LLM_PROVIDER` ·
`CODEX_ANTHROPIC_MODEL` · `CODEX_OPENROUTER_MODEL` · `CODEX_AUTO_VERIFY` ·
`CODEX_VERIFY_ROUNDS` · `CODEX_VERIFY_FIX_STEPS` · `CODEX_SUBAGENT_MAX_STEPS`.
En prod: pasar `ANTHROPIC_API_KEY`/`OPENROUTER_API_KEY` al contenedor backend
vía el override (allowlist `environment:`).

### Agent SDK v2 (added 2026-07-02, misma noche)
- **Visibilidad en vivo**: cada tool call de un subagente emite action_start/
  action_end reales en el timeline (`↳ <agente> · <cmd>`, mismo groupId que la
  delegación) vía el callback `emitAction` que agent-loop inyecta en el ctx y
  el SDK invoca alrededor de cada ejecución. Crash del callback nunca rompe la
  delegación.
- **Delegación paralela**: un turno compuesto SOLO de run_subagent (≥2) corre
  los especialistas con Promise.all (turnos mixtos siguen secuenciales para
  preservar read-after-write). El system prompt lo anuncia. El seq-gate del
  event-store hace seguros los appends concurrentes.
- **Agentes custom por proyecto**: `.sira/agents.json` en el workspace define
  especialistas propios `[{ name, description, prompt, tools?, maxSteps? }]` —
  validación estricta (nombre ^[a-z][a-z0-9_-]{1,29}$, sin colisión builtin,
  tools ⊆ TOOLS sin run_subagent, maxSteps ≤ 12, prompt ≤ 4000 chars, máx 10).
  run_subagent los carga best-effort en cada delegación; `GET /api/codex/agents`
  expone `custom.{supported,path,allowedTools}`.
- **Contexto automático**: el subagente recibe el árbol de archivos fresco
  (git ls-files) en su primer mensaje — no gasta un paso en orientarse.
- **Nuevo especialista `debugger`** (diagnóstico de causa raíz + fix mínimo,
  con grep_search/type_check/dev_server_check) — 7 builtin en total.
- **Informe con métricas**: durationMs + tokens acumulados en el outcome y en
  el encabezado del reporte.
- Tests: codex-agent-sdk (23) + caso de paralelismo con barrera en
  codex-agent-loop (si el loop fuera secuencial, el primer subagente esperaría
  para siempre → timeout).

## Deployments / Publishing — clon del tab de Replit (flag DEPLOYMENTS_V2, added 2026-06-18)

Clon **de gestión** (no provisiona VMs reales) del tab "Deployments/Publishing" de
Replit: lifecycle de estados, historial de versiones inmutables con hash corto,
dominios propios (registros A+TXT) y un security scan sintético. Patrón
server-driven calcado de Codex V2. Flag off ⇒ `/api/deployments/*` responde 404
salvo `/health`; el módulo `/deployments` muestra empty-state. Opcionalmente
ligado a un `Project` (`webapp`) vía `projectId`.

### Backend (`backend/src/services/deployments/` + `routes/deployments.js`)
- `flags.js` — `isDeploymentsEnabled(env)` (`DEPLOYMENTS_V2` = 1/true/on).
- `pipeline.js` — PURO/determinista (sin reloj ni random): pipeline de 5 fases
  (provision→security_scan→build→bundle→promote), `generateShortHash` (FNV-1a,
  8 hex), `slugifySubdomain`, `machineSpec` (tiers Reserved VM 0.5/2GB…4/16GB con
  USD/mes), `dnsRecordsFor` (A + TXT `sira-verify=`), `securityScanReport`.
- `deployment-service.js` — Prisma **inyectable** (default: cliente compartido),
  todo scoped por `userId`: create/list/get(+versions+domains)/update(geography
  inmutable)/publish (versión inmutable + demote de la previa live)/rollback
  (re-promociona una versión previa como build `isRollback`)/pause·resume·shutdown
  (soft-delete)/securityScan/addDomain·removeDomain/getLogs. `DeploymentError{status,code}`.
- `routes/deployments.js` — montado `/api/deployments` en `index.js` (sin CSRF,
  Bearer como codex). `GET /health` público SIEMPRE 200; resto flag-gated 404.
  CRUD + `/publish` + `/rollback` + `/pause|resume|shutdown` + `/security-scan` +
  `/domains` + `GET /:id/logs` + `GET /:id/logs/stream` (SSE replay + heartbeat,
  `?token=` fallback).
- Prisma: modelos `Deployment` / `DeploymentVersion` / `DeploymentDomain`
  (`@@map deployments|deployment_versions|deployment_domains`) + relación en
  `User`. Migración `20260618200000_add_deployment_tables` (aditiva).

### Frontend (`app/deployments/page.tsx` + `components/deployments/*`)
- `lib/deployments/deployments-api.ts` — cliente tipado (clon de codex-api):
  Bearer `localStorage("auth-token")` + `credentials:include`; el contrato.
- `page.tsx` — auth-gated, `health()` → empty-state si `enabled:false`, si no
  lazy-load `DeploymentsModule` (`ssr:false`).
- `components/deployments/`: `deployments-module` (selector + detalle),
  `deployment-detail` (banner suspended + Reanudar/Ajustar/Escaneo + tabs
  Overview/Logs/Dominios/Gestionar), `overview-tab` (card Production estilo
  Replit + Publicar + timeline), `publish-pipeline` (5 pasos animados),
  `version-timeline`, `logs-tab` (EventSource sobre `logsStreamUrl`),
  `domains-tab` (A+TXT + verificación/TLS), `manage-tab` (settings + Apagar),
  `create-deployment-dialog`, `shared.tsx` (helpers visuales + `timeAgo`).

### Tests
`backend/tests/deployment-pipeline.test.js` (8) + `deployment-service.test.js`
(10, Prisma falso en memoria) — registrados en `backend/package.json`. Verificado
e2e real (servicio+BD y HTTP+auth) + UI en navegador (create→publish→running).

### Gotchas
- El backend ignora `backend/.env PORT=5050` y liga a **5000** (gana `PORT=5000`
  del `.env.local` raíz); el proxy de Next apunta ahí, así que coinciden.
- Un seeder de arranque reescribe la password de `admin@example.com` a `password`
  en cada reinicio del backend (credencial local estable: `admin@example.com` / `password`).

## Planes y pagos — solo dos planes (added 2026-09-12)

Decisión de producto de Luis: la página de planes es **`/planes`** (pantalla
completa, botón «Atrás» arriba a la izquierda, estilo Claude) y ofrece SOLO dos
planes. No revivir tiers ni el plan de $5 en la UI.

| Plan | Precio | Código backend | Acción |
|---|---|---|---|
| **Pro** | $10 USD/mes | `PRO_MAX` (ya costaba $10 en stripe.js / payments.js / proration / feature-cost-estimator; `PRO` $5 queda como tier legado para suscriptores existentes) | `POST /api/payments/stripe` → Stripe Checkout → `/payment/success` (`verify-session` activa el plan aunque no haya webhook) |
| **Hablemos** | a medida | `ENTERPRISE` | Abre WhatsApp con mensaje prellenado (`wa.me/<SIRAGPT_WHATSAPP_NUMBER>`), fallback `/support` |

- **Fuente única de verdad**: `lib/plans-catalog.ts` (copy, precios, `PLAN_DISPLAY_NAMES`
  —`PRO_MAX` se muestra como «Pro»—, `buildWhatsAppHref`, `describeCheckoutError`).
  La consumen `app/planes/page.tsx`, `components/landing/PricingSection.tsx`,
  `components/subscription-manager.tsx` (billing) y `components/UpgradeModal.tsx`,
  que ahora es un shim: cualquier `open=true` (sidebar, error de cuota en el chat,
  evento `open-upgrade-modal`) navega a `/planes`.
- **Backend**: `GET /api/payments/config` (público) → `{ stripeConfigured,
  checkoutAvailable, whatsappNumber, paidPlan, contactPlan }`; la página lo lee en
  runtime, así que habilitar ventas en prod solo requiere el `.env` del backend.
  `stripe-setup.getPriceIdForPlan` **auto-provisiona** producto + precio en Stripe
  (`stripeService.ensurePriceForPlan`, idempotente por `metadata.plan`) cuando solo
  hay `STRIPE_SECRET_KEY`, y lo cachea en `systemSettings`. Sin clave, `POST /stripe`
  responde 503 en español con `code: STRIPE_NOT_CONFIGURED` + número de WhatsApp.
- **Env de producción (Luis)**: `STRIPE_SECRET_KEY` (obligatoria para cobrar),
  `STRIPE_WEBHOOK_SECRET` (renovaciones/cancelaciones; endpoint
  `/api/payments/stripe/webhook`), `SIRAGPT_WHATSAPP_NUMBER` (dígitos con código de
  país), opcional `NEXT_PUBLIC_WHATSAPP_NUMBER` en el build del frontend, y
  `FRONTEND_URL=https://siragpt.com`. Detalle en `docs/ENV_VARIABLES.md`.
- **Tests**: `backend/tests/payments-public-config.test.js`,
  `backend/tests/stripe-setup.test.js` (auto-provisión), `tests/plans-catalog.test.ts`.

## Jev tier steering — escalación flash↔pro (added 2026-09-18)

Consumidor del veredicto `model_family` del juez de turno RLCD × Jev
(PR #744 lo calculaba — incl. el bit `actions.modelFamily.steer` — pero nadie
lo aplicaba). Jev sigue sin ir al picker como modelo de conversación; aquí
dirige el tier del turno.

- **Módulo**: `backend/src/services/ai/jev-router.js` — PURO y síncrono, cero
  llamadas de red (reusa el fan-out único por turno de
  `rlcd/jev-turn-judge.js`). `refineRoutingWithJevJudgement(routing, judged,
  ctx)`: familia `reasoning`/`coding` ⇒ escala flash→pro (preservando la forma
  del id: `deepseek-v4-flash`→`deepseek-v4-pro`, slug openrouter ídem);
  `fast_cheap` ⇒ veta una escalación heurística al tier pro; `balanced`/
  `vision` ⇒ sin opinión. Nunca toca escalaciones a modelos ajenos a los
  tiers Sira. Fail-open por forma (judgement ausente/deforme ⇒ no-op).
- **Cableado**: `routes/ai.js`, tras el juez RLCD y justo antes del bloque que
  aplica el re-ruteo inteligente. Las guardas existentes no cambian: el picker
  siempre gana, plan gate y provider inference deciden el modelo final.
  Telemetría: `routing.jev_tier_steering {family, applied, reasonCode, steer,
  probability}`.
- **Activación**: el bit `steer` ya gobierna todo — requiere el juez RLCD
  activo (`TYPESAFE_API_KEY` + `SIRAGPT_RLCD_JEV`) y
  `SIRAGPT_RLCD_JEV_MODEL_STEERING=1` con confianza ≥
  `SIRAGPT_RLCD_JEV_MODEL_CONFIDENCE` (0.7) y usuario sin modelo elegido.
  Con steering apagado el veredicto se loguea como advisory (shadow natural).
  Override opcional del target: `SIRAGPT_JEV_PRO_TARGET`.
- **Tests**: `backend/tests/jev-router.test.js` — 16 tests offline (tiers,
  mapeo de familias, escalación/veto/advisory/guardas/no-op ante judgement
  deforme). Registrado en `backend/package.json`.

## Skills en el compositor (claude.ai style) — added 2026-09-29

Pedido de Luis: «+ → Skills» justo bajo «Subir documento» y sin «Modo de voz» en ese menú.
- **Catálogo** (`backend/src/services/chat-skills.js`): skills integradas de documentos
  (`services/sandbox/skills/*.md` → Word/docx, PowerPoint/pptx, Excel/xlsx, PDF, CSV) + las
  del usuario en su Biblioteca (`skills-persist`, SKILL.md por usuario). Una del usuario nunca
  sombrea una integrada. `GET /api/skills` (catálogo sin cuerpos) y `GET /api/skills/:name`.
- **Explícita**: la skill elegida viaja como `skills: [name]` (máx. 3) en `/api/ai/generate`,
  `/api/doc/generate` (→ agent-runner `systemAppend`, también por la cola) y `/api/agent/task`
  (→ runner). El cuerpo entra como bloque `selected-skills` (nunca podado por el kernel, tier 0
  del allocator; tope 8k/skill, 16k total). Las chips se limpian al enviar.
- **Automática**: herramienta de harness `use_skill` (catálogo sin nombre, cuerpo con nombre)
  + línea de política en el prompt del loop agéntico — progressive disclosure como Claude.
- **UI**: `components/chat/skills-menu.tsx` (submenú desktop / panel móvil, buscador >6),
  `components/chat/skill-chips.tsx`, `lib/chat/use-composer-skills.ts` (carga perezosa).
- **Tests**: `backend/tests/chat-skills.test.js`, `tests/lib/composer-skills.test.ts`,
  `tests/chat-skills-composer-source.test.ts`, `e2e/chat-skills-menu.spec.ts` (menú, chat, doc).

### Ajustes → Skills, «Descubrir», «/» y memoria (added 2026-09-30)
Paridad con claude.ai (pedido de Luis con capturas):
- **Menú «+ → Skills»**: lista plana alfabética (ícono de pergamino + nombre) de las skills
  ACTIVAS, y abajo «Gestionar habilidades» (Ajustes → Skills · Tuyos) y «Explorar habilidades»
  (Descubrir). `openSettingsSection("skills", { skillsTab })` en `lib/chat/open-settings.ts`.
- **«/» en el compositor**: `SlashCommandMenu` lista primero las skills («Skills») y luego los
  comandos; elegir una la pone como chip. Escribir `/nombre ` también la convierte en chip.
- **Ajustes → Skills** (`components/settings/skills-settings.tsx`, sección `skills` del panel):
  pestañas **Tuyos** («Creado por ti» + «De SiraGPT»: integradas e instaladas; menú ⋮ con
  Probar en un chat / Ver instrucciones / Editar / Desactivar / Eliminar o Quitar) y
  **Descubrir** (destacada, «Para ti», «Nuevas habilidades», categorías con conteos reales).
  «Añadir»: Crear con SiraGPT (chat nuevo con `skill-creator`), Escribir instrucciones,
  Subir una skill (.md / .zip / .skill con SKILL.md, vía JSZip).
- **Catálogo**: `backend/src/services/skills-catalog/*.md` (21 skills en español con
  frontmatter name/title/description/category/added/featured) cargado por
  `services/skills-catalog.js`. `skill-creator` viene instalada por defecto.
- **Estado por usuario**: `.skills-state.json` junto a los SKILL.md del usuario
  (`skills-persist` `readSkillState`/`writeSkillState`, escritura atómica): instaladas,
  desactivadas y quitadas. Las desactivadas salen del menú, de «/» y de `use_skill`.
- **API** (`routes/chat-skills.js`, CSRF): `GET /library`, `GET /discover`, `POST /`
  (crear o subir), `GET|PUT|PATCH|DELETE /:name`, `POST /:name/install`, `GET /:name/download`.
- **Memoria**: «Para ti» ordena el catálogo con lo que el usuario tiene en Ajustes → Memoria
  (`memory/vault`); la herramienta `save_skill` (tier confirm) guarda skills creadas en el
  chat (memoria procedimental) y la skill `importar-memoria` importa memorias de otro
  asistente con `memory_search`/`memory_write`.
- **Probar**: `startChatWithSkill` (`lib/chat/skills-events.ts`) cierra Ajustes, abre un chat
  nuevo y deja la skill como chip (sessionStorage + evento en vivo).
- **Tests**: `backend/tests/chat-skills-library.test.js`, `tests/components/skills-settings.test.tsx`,
  `tests/components/slash-skills-menu.test.tsx`, casos nuevos en `e2e/chat-skills-menu.spec.ts`.

## Imágenes con el modelo elegido (added 2026-09-29)

Pedido de Luis: un turno con imagen usa SOLO el modelo que el usuario eligió.
- `ai/vision-runtime.js` `modelSupportsVision` reconoce GPT-6 Sol/Luna (`gpt-[5-9]`,
  directo y vía OpenRouter); antes caían como «no ve imágenes» y la imagen se
  desviaba a Gemini → Meta Muse Spark → xAI (fallos «sin saldo»/«no responde»).
- `agent-harness/model-capabilities.js`: familia `openai-gpt6` (`supportsImages`,
  contexto 200k; transporte de tools y razonamiento siguen conservadores).
- `ai-service.generateStream`: un modelo elegido que ve imágenes no recorre otros
  runtimes de visión, ni siquiera ante un rechazo del formato de imagen; el turno
  termina con su error transparente. Solo un modelo elegido que NO ve imágenes
  (p. ej. DeepSeek V4) usa un runtime de visión para leerlas.
- Modelo elegido sin visión + imagen: los runtimes de visión con memo «sin saldo»/clave
  rechazada se saltan (antes se re-llamaban en cada turno, ~40 s de fallos); el log y el
  reporte nombran el proveedor que falló de verdad (`siraProvider`/`siraModel`), y el
  cierre dice «No pude leer la imagen…» en vez de culpar al modelo elegido.
- Tests: `ai-service-provider-failure` (GPT-6 Sol lee la imagen sin cambio de
  modelo; rechazo de imagen no llama a otro runtime), `ai-service-vision-runtime`,
  `agent-harness-core`.

## Sistema visual monocromo + copia en Logs (added 2026-09-29)

Pedido de Luis: interfaz solo en blanco y negro, con acabados más finos, y una
selección/copia de registros consistente en los cuatro tabs de Admin → Logs.

### Monocromo (UI lock re-baselineado para los archivos tocados)
- **Tokens** (`app/globals.css`): `:root`, `.dark` y `.dark.midnight` en grises
  puros (hue 0, sat 0%). Tinta `--foreground` #0A0A0A / #F5F5F5; `--brand`,
  `--accent-violet` (nombre histórico, ahora tinta), `--sidebar-*`, `--chart-*`
  y `--ring` neutros. **El color queda reservado a un solo significado:**
  `--destructive` (errores y acciones irreversibles) — `red`/`rose` no se
  remapean. `--radius` 0.625rem. Escala de sombras en capas `--shadow-{xs,sm,
  md,lg,xl,hairline}` por tema (en oscuro, hairline claro en vez de sombra).
- **Tailwind** (`tailwind.config.js`): `MONOCHROME_PALETTES` remapea
  emerald/green/lime/teal/cyan/sky/blue/indigo/violet/purple/fuchsia/pink/
  amber/yellow/orange/slate/gray/zinc/stone a `neutral` tono a tono → las ~2.400
  clases cromáticas fijas siguen el sistema sin editar cada componente.
  `fontFamily.sans/mono` apuntan a Geist (`var(--font-sans|mono)`); antes
  `font-sans` caía en la fuente del sistema y `font-mono` en JetBrains Mono.
  `boxShadow` usa los tokens de sombra.
- **Acabado global**: selección de texto invertida, anillo de foco nítido,
  scrollbars finas neutras, cifras tabulares en tablas (bloque «Monochrome
  finish» al final de globals.css). Primitivos refinados: button (sombra sm,
  press 0.985), card (rounded-xl), tabs, input, badge, overlays de dialog/
  sheet/alert/drawer (negro 55% + blur 3px).
- **Literales**: los hex/rgb/hsl cromáticos de globals.css y de las clases
  arbitrarias `-[#hex]` de app/ y components/ se convirtieron a su gris de igual
  luminancia; el verde trébol del login/logo/marca pasó a tinta. **No** se
  tocaron colores de contenido o funcionales: plantillas HTML generadas
  (message-component), celdas de Excel, gráficos de datos, logos de terceros
  (Google, fal), ni el icono PWA/manifest/emails/documentos (siguen trébol).
- **Excepción:** los logos de modelos del selector (`.model-logo-chip[data-model-brand]`)
  conservan sus colores de marca (pedido de Luis, 2026-09-29); sin filtro de grises.
- `lib/settings-context.tsx` ya no inyecta `--primary` inline (pisaba `.dark` y
  pintaba botones casi negros sobre el lienzo negro); el selector «Color de
  acento» se quitó de Ajustes.
- Tests fijados actualizados: `brand-clover-source`, `claude-thinking-surface-
  source`, `chat-composer-professional-surface-source` (grises puros, botón de
  parar y rayo «rápido» en tinta). El e2e del compositor (fondo blanco, radio
  20px) sigue intacto.

### Admin → Logs: selección y copia comunes
- `lib/admin/log-copy.ts` (puro): `formatRecords(records, formato)` con
  formatos **Texto · Solo mensaje · Markdown · JSON · Tabla (Excel/TSV)** sobre
  un `CopyRecord` común; `toggleSelection` (Mayús+clic = rango);
  `copyText` con respaldo `execCommand("copy")` si el Clipboard API falla;
  `hasTextSelection` (resaltar texto con el mouse ya no abre el detalle).
- `lib/admin/use-log-selection.ts`: hook por tab — poda la selección cuando las
  filas salen (filtros, en vivo, paginación), **Ctrl/⌘+C** copia la selección
  (salvo que haya texto resaltado o se esté escribiendo), **Esc** la quita, el
  formato se recuerda por navegador.
- `components/admin/log-selection-bar.tsx`: barra + casillas nativas
  compartidas, usadas por «Fallos de respuesta», «Errores del sistema»,
  «Registros en vivo» (conserva sus testids y su formato de texto exacto) y
  «Auditoría». Los diálogos de detalle usan `copyText`.
- Tests: `tests/lib/admin-log-copy.test.ts` (formatos, rango, respaldo) +
  casos nuevos en los tests de componente de los paneles +
  `tests/admin-live-logs-source.test.ts` (los 4 tabs usan la barra común).

## Pulido del chat /agentes — 107 hallazgos auditados (added 2026-09-30)

Auditoría en 10 dimensiones (render, markdown en streaming, a11y, acabado visual,
compositor, estados, móvil, lógica, superficies, carga) con verificación adversarial;
107 hallazgos confirmados (≈91 distintos) aplicados y re-baselineados en el UI lock.
- **Lista de mensajes**: la respuesta en vivo vive en la misma lista con key (sin remontar
  al terminar); auto-seguimiento con intención (rueda/toque/PageUp lo sueltan); el foco no
  sale del compositor al terminar una respuesta; el efecto de foco de imagen corre una vez.
- **Streaming**: `lib/markdown/repair-streaming-tail.ts` repara la cola viva (`**` sin
  cerrar, enlaces a medias, tablas sin fila delimitadora); `$10 y $20` ya no es KaTeX; el
  caret no aparece en cada celda/ítem.
- **Compositor**: borrador por chat sin fugas, ↑ con compositor vacío recupera el último
  mensaje (o el de la cola), Enter del menú «/» no envía «/», quitar un adjunto en subida
  aborta el XHR, autosize sin saltos, pegar desde Excel ya no adjunta una imagen.
- **Detener**: no marca el chat como fallido ni añade texto en inglés.
- **Carga**: WordConnector, ArtifactPanel/Sources/Voz/DocumentPreview perezosos; `docx`
  perezoso en descargas; sin destello blanco en tema oscuro; la lista de chats no espera a
  los modelos.
- Tests: `tests/*-source.test.ts` nuevos (continuidad del stream, robustez del compositor,
  resiliencia del contexto, popovers a11y, sidebar/ajustes, pulido del shell, estabilidad
  del render), `tests/markdown-repair-streaming-tail.test.ts`, `tests/lib/markdown-block-split.test.ts`,
  `tests/components/message-markdown-render.test.tsx`.

## Acabado premium de /agentes — título, visor, memoria y Apps (added 2026-09-30)

Pedido de Luis con capturas de claude.ai. UI lock re-baselineado para los archivos tocados.
- **Título del chat** (`components/chat/chat-title-menu.tsx`): clic en el TÍTULO → renombrado
  en línea con borde celeste fino (`.chat-title-input--celeste`); clic en la FLECHA → menú
  claude.ai: Programar · Convertir en habilidad · Copiar ID de sesión · Fijar (P) · Cambiar
  nombre (R) · Añadir al proyecto › (carpetas del sidebar) · Archivar (A) · Eliminar (D).
  «Compartir» queda en la píldora del header. Carpetas/archivar/programar viven en el sidebar:
  el menú los pide por evento (`lib/chat/chat-actions.ts` `requestChatAction`); «Convertir en
  habilidad» abre un chat nuevo con `skill-creator` y un brief prellenado
  (`setComposerPrefill` → `COMPOSER_PREFILL_EVENT`, consumido en `chat-interface-enhanced`).
  `requestNavigation(href)` navega vía el router del sidebar (`NAVIGATE_EVENT`).
- **Imágenes**: una imagen clicada en la conversación abre un lightbox plano (fondo oscuro,
  cerrar/zoom/descargar/compartir) — `ImageWorkspace viewOnly` → `ImageModal viewOnly`. La
  barra Anotar/Comentar/Quitar fondo/Borrar/Tamaño y «Describir ediciones» solo aparecen con la
  herramienta Imágenes activa (`viewOnly={!isImageGenerationActive}`).
- **Acabado**: «Ir al final» es una píldora *liquid glass* (`.liquid-pill`, acento al hacer
  streaming); la barra de acciones (copiar, regenerar, me gusta…) respira bajo la respuesta
  (`mt-3`, `gap-1`; acciones del usuario `mt-2`).
- **Memoria**: `lib/chat/use-memory-status.ts` (una carga por página, `setMemoryStatusCount`
  tras editar) → check celeste «Activa · N recuerdos» en «+ → Memoria» y píldora «Memoria
  activa» en Ajustes → Memoria.
- **Apps**: al pie de la lista de apps del «+» hay «Más apps · Conecta las aplicaciones que
  SiraGPT puede usar» → `/conexiones`; en Apps, una app conectada muestra «Conectada» en VERDE
  en su propio botón (`.sira-connected-btn`; clic = reconectar).
- **Excepciones al monocromo (decisión de Luis)**: tokens `--celeste` (borde de edición y
  check de memoria) y `--success-green` (app conectada) en `globals.css`; son CSS propio,
  fuera del remapeo de paletas de Tailwind.
- Tests: `tests/agentes-premium-finish-source.test.ts`, `tests/chat-header-title-menu-source.test.ts`.

## Errores de Admin → Logs — cuarto volcado (added 2026-09-30)

Del volcado del 27–30 sep, la mayoría ya tenía corrección en `production-main`
posterior a la línea de log (#835 watchdog, #836 goal-events, #838 claves ilegibles,
#842 slug DeepSeek, #875 abortos y P2034, #884 `[models-dbg]`, #915/#916/#924/#925
saldo, transcripción, visión y atribución). Lo que seguía abierto:
- **Sin saldo ≠ clave rechazada**: xAI responde 403 «used all available credits / monthly
  spending limit», OpenAI 429 «no credits remaining», Anthropic 400 «credit balance is too
  low», Meta 402. `litellm-gateway.classifyProviderError` mira ese texto ANTES del estado
  (antes 403 ⇒ `auth`), y `task-error-classifier` lo clasifica `quota-exhausted` sin
  reintentos antes de la regla de rate-limit (antes 429 ⇒ `rate-limited` reintentable).
- **Telemetría vacía**: `POST /api/telemetry/error` sin mensaje/acción/stack/turno
  (sondas, beacons sin cuerpo) responde 202 y no alerta, audita ni agrupa
  (`isEmptyClientEvent`). Era el issue «client event · unknown» de Errores del sistema.
- **Copia del timeout del chat**: «El modelo cortó la respuesta después de pensar…» —
  sin la frase «no es un fallo de GitHub» heredada de codex.
- **coworkRun.create**: pausa con jitter entre reintentos de P2034 (antes reintentaba en
  el mismo tick y volvía a chocar).
- Solo Luis: saldo/claves de OpenAI (incl. 401 en Files), xAI, Anthropic, Meta; volver a
  guardar en Admin → Conexiones las claves marcadas «ilegible».
- Test: `backend/tests/provider-credit-classification.test.js`.

## Word con la gráfica anterior + burbuja del pedido (added 2026-09-30)

Reporte de Luis: «crea un word con esta información e incorpora esta gráfica en un word en
una página» desapareció del chat mientras «Agente de documentos trabajando» y terminó en «el
agente agotó sus pasos sin producir un archivo verificado».
- **Contexto del turno anterior** (`backend/src/services/previous-turn-document-context.js`,
  `collectPreviousTurnContext`): cuando el pedido apunta al turno previo (deícticos «esta/esa/
  anterior/que generaste» + información/gráfica, o formas pronominales «ponlo/insértala/
  expórtalo»), el runner recibe (1) la respuesta anterior y la descripción de la última
  visualización (título, explicación, tabla de datos) dentro de `<SIRAGPT_SOURCE_CONTENT>`
  (`buildPreviousContentDocumentPrompt`), y (2) la gráfica como PNG real: matplotlib (data URL),
  `type:'chart'` (upload local) o recharts/chartjs/plotly dibujados en servidor
  (`document-visual-embed.buildChartSvg` + `sharp`; líneas multi-serie con `buildMultiLineSvg`),
  guardada como `File` del usuario en `uploads/images` y añadida a los `fileIds` del turno →
  aparece en `/workspace/uploads` y la instrucción ordena insertarla. Sin gráfica renderizable
  (d3/mermaid) viaja la tabla/código y se pide recrearla. Nunca lanza; sin referencia al turno
  previo devuelve `applied:false`.
- **Cableado**: `agents/agent-task-runner.js` (`resolveAgentRunnerTurnContext`, una vez por
  claim, paso visible «Recuperando el contenido y la gráfica del mensaje anterior») y
  `routes/doc.js` (stage + `routingPrompt`). El ruteo (claim/runner-only) sigue clasificando las
  palabras originales; solo el runner ve la instrucción enriquecida
  (`runAgentRunnerForDocRoute({ prompt, routingPrompt })`). Funciona también por la cola async.
- **Burbuja**: `handleAgentTask` (`chat-interface-enhanced.tsx`) solo omitía la burbuja del
  usuario si el chat ya tenía *cualquier* turno del usuario, así que en un chat con historial el
  pedido no se veía hasta que el servidor lo persistía. Ahora `hasUserTurnForGoal`
  (`lib/chat/agent-task-turn.ts`) comprueba que ESE texto sea el último turno del usuario.
- **«Ir al final»**: el viewport del ScrollArea se re-resuelve tras cada render (antes solo al
  cambiar de chat; un remontaje de la lista dejaba el elemento obsoleto sin eventos de scroll y la
  píldora nunca aparecía).
- Tests: `backend/tests/previous-turn-document-context.test.js` (11), `tests/lib/agent-task-turn.test.ts`,
  `tests/chat-agent-task-user-bubble-source.test.ts`.
- Gotcha de entorno: `next dev` con una caché `.next/cache/webpack` vieja sirvió `globals.css`
  SIN el bloque «Premium chat finish» (borde celeste, memoria, liquid-pill) aunque el archivo lo
  tenía; `rm -rf .next/cache/webpack` lo arregla. Producción compila desde cero en Docker.

## Marca: nudo de cinco bucles + «SiraGPT» en el sidebar (added 2026-10-01)

Pedido de Luis con el logo (nudo celta de cinco bucles). UI lock re-baselineado para los
archivos tocados.
- **`components/brand/knot-mark.tsx` (`KnotMark`)**: la marca es geometría vectorial generada
  (nudo tórico T(3,5): 5 bucles exteriores + pentagrama, 10 cruces entrelazados), NO un raster
  calcado. Tubo con bordes en `currentColor` e interior/huecos en `--knot-gap` (blanco /
  `#0d0d0d` por tema en `globals.css`; prop `gap` para paneles tintados, p. ej. el sidebar usa
  `hsl(var(--sidebar-background))`). El entrelazado se dibuja con «parches» del tramo superior
  sobre el trazo completo (mismos vértices → sin muescas). Mismo dibujo en `public/brand/knot.svg`.
  `CloverMark` sigue existiendo para el icono PWA, correos y documentos.
- **Sidebar** (`app-sidebar.tsx`): la cabecera abre con el lockup `data-testid="sidebar-brand"`
  (nudo 22 px + wordmark «SiraGPT» `.sidebar-brand__wordmark`) y el botón de contraer al lado;
  y, en el extremo derecho, SOLO el botón de contraer (`HEADER_TOGGLE_BTN`: 32 px, glifo 20 px).
  Segundo pedido de Luis el mismo día: la campanita (`NotificationCenter`) y el disco
  «Nuevo agente» salieron de la cabecera; «Nuevo agente» sigue como primera fila del nav y ⌘N
  funciona. La bandeja de notificaciones ya no tiene entrada en `/agentes` (queda solo en
  `components/code/workspace-top-bar.tsx`). Los botones Atrás/Adelante salieron antes de la
  tira (el rail de 16 rem no daba para el wordmark; el navegador ya los tiene). El rail
  colapsado muestra el nudo.
- Todos los renders in-app de la marca (BrandLogo, login/registro/recuperación, PWA prompt,
  BrandCycle) usan `KnotMark`.
- Tests: `tests/brand-clover-source.test.ts` (actualizado), `tests/sidebar-brand-header-source.test.ts`,
  `tests/app-sidebar-chat-groups-source.test.ts` (actualizado).

## Video que «desaparece» al enviarlo + guardia de gráficas (added 2026-10-01)

Reporte de Luis: al subir un video, su mensaje desaparecía durante «pensando» y
volvía a aparecer con la respuesta; el día anterior «no podía graficar».
- **Causa del video**: un envío solo con archivo usa el texto automático del compositor
  («Analiza los archivos adjuntos y responde según el contexto del hilo»). El paso B de
  `dedupeMessages` (`lib/message-preservation.ts`) tomaba la burbuja optimista nueva
  (`msg-user-…`) como gemela de CUALQUIER fila estable del mismo rol y texto, aunque fuera
  del turno anterior con otro video, y la descartaba (injertando el video nuevo en el
  mensaje viejo) hasta que el servidor persistía el turno (en la cola, al reclamar la tarea).
  Ahora una gemela por contenido exige adjuntos compatibles (mismo id de subida, o un lado
  sin archivos) y que no haya una respuesta ya terminada entre ambas (texto plano o
  `agent-task-state` con `done`). Las gemelas por `idempotencyKey` no cambian.
  Invariante **I16** en AGENTS.md; tests nuevos en `tests/message-dedupe.test.ts`
  (fallan en pre-fix).
- **Gráficas**: el fallo de ayer era `sira_charts.py` no importable desde `execute_python`
  (helpers en `/workspace/tmp`, scripts en `/workspace`); Luis lo corrigió en #953
  (bootstrap con `sys.path.insert(0, '/workspace/tmp')`). Guardia sin Python ni sandbox:
  `backend/tests/agent-runner-python-helper-staging.test.js` (staging del helper en
  `agent-runner/index.js`, bootstrap del wrapper, instrucción de import en el prompt).
  Invariante **I17** en AGENTS.md.

## Densidad compacta del chat en móvil — paridad claude.ai (added 2026-10-02)

Pedido de Luis con capturas de siragpt.com y claude.ai en iPhone («todo se ve más compacto,
más profesional»). UI lock re-baselineado para los archivos tocados.
- **Causa**: la regla global #78 de `globals.css` (`@media (pointer: coarse)` → `min-height/
  min-width: 2.75rem` en todo botón) inflaba a 44 px cada control del chat en teléfonos:
  cabecera, fila copiar/editar bajo la burbuja, barra de acciones de la respuesta y los
  botones del compositor (su lista de excepciones `pre button, .composer-toolbar button…`
  nunca ganaba por especificidad). Eso separaba y agrandaba todo frente a claude.ai.
- **Fix** (bloque «Compact chat density on phones» al FINAL de `globals.css`): `:is(.chat-
  mobile-header, .composer-input-row, .msg--user, .chat-assistant-message) button:not(…)`
  recupera su geometría propia; el pseudo `::after` de 44 px (≤767px, botones con aria-label
  h-7/h-8/h-9) conserva el área táctil. En ≤767px: cabecera con menos aire arriba, `+`/mic/
  enviar/parar a 36 px, pill del modelo y chips (escudo, anillo, ⚡) a 36 px, fila del
  compositor 3rem, presupuesto del pill 14.9rem (antes 16.1), disclaimer 11px.
- **Mensajes**: la fila bajo la burbuja del usuario es `msg-user-actions` (`mt-1.5`, tiles
  `h-7 w-7` con glifo 14 px) y abre con «hace N min» (`formatRelativeTimeEs` de
  `MessageActionRail`), como claude.ai. El rail de la respuesta no cambia (ya era 28 px).
- Escritorio intacto salvo esa fila (28 px en vez de 24). Verificado en navegador (390×844
  claro/oscuro, 1280 escritorio) y con `e2e/chat-composer-stable-size.spec.ts` (8/8).
- Tests: `tests/chat-mobile-compact-density-source.test.ts` (nuevo),
  `tests/agentes-premium-finish-source.test.ts` (clase de la fila actualizada).
- Gotcha repetido: `next dev` sirvió `globals.css` viejo hasta `rm -rf .next/cache/webpack`.

## Marca: átomo de tres órbitas + «Pensando» como átomo en movimiento (added 2026-10-02)

Pedido de Luis con el SVG del logo («logo de Sira de átomo») y el símbolo de pensar de la
plataforma (canvas «ia-estelas»: «tres puntos de color giran con estela alrededor del punto
central»). Sustituye al nudo de cinco bucles del día anterior. UI lock re-baselineado.
- **`components/brand/atom-mark.tsx` (`AtomMark`)**: la marca es el SVG de Luis tal cual
  (viewBox 400, tres órbitas elípticas 170×62 rotadas −90°/30°/150°, un electrón r=13 en el
  ápice de cada una, núcleo r=24, trazo 9), todo en `currentColor` («tinta»); cada anillo
  lleva el hueco centrado en su electrón (`stroke-dasharray`/`dashoffset`). A ≤32 px aplica
  un tamaño óptico (trazo 16, electrón 19, núcleo 32; prop `weight`) para que el sidebar
  (20–22 px) y las tarjetas de auth (28 px) no queden en hilos de 0,5 px. Mismo dibujo en
  `public/brand/atom.svg`. **`KnotMark`, `public/brand/knot.svg` y `--knot-gap` se eliminaron**
  (sin prop `gap`). `CloverMark` sigue para el icono PWA, correos y documentos.
- **Todos los renders in-app** (sidebar abierto y rail colapsado, BrandLogo, login/registro/
  recuperación/reset, PWA prompt, BrandCycle) usan `AtomMark`.
- **`components/brand/thinking-core.tsx` (`ThinkingCore`, el único glifo «Pensando»)**: ahora es
  el mismo átomo en movimiento. Órbitas y núcleo en la tinta (`--think-accent`); los tres
  electrones recorren su elipse exacta con SMIL `animateMotion` (velocidad constante, fases con
  `begin` negativo, 2.6/3.1/3.6 s) y dejan estela: dos dashes (16 % y 7 % de la órbita) sobre una
  copia del anillo con `pathLength="100"` cuyo `stroke-dashoffset` se anima en sincronía, así la
  cola se curva con la elipse a cualquier tamaño (12 px rail → 48 px). Idle = el logo estático
  (electrón en el ápice, sin estela). CSS (`.claude-asterisk*`, históricos): latido del núcleo
  (`thinking-core-pulse`), y con `prefers-reduced-motion` se ocultan electrones móviles y
  estelas, se muestran los estáticos y el núcleo solo pulsa en opacidad. Sin ripple.
- **Excepción al monocromo (decisión de Luis)**: los electrones son los únicos puntos de color
  de una superficie de pensamiento: tokens `--think-electron-a|b|c` en `globals.css` (celeste
  #38BDF8 / violeta #A78BFA / ámbar #FBBF24; variantes más claras en `.dark`). Los valores son
  una propuesta ajustable en un solo sitio; el canvas original no viajó con sus colores.
- Tests actualizados: `tests/brand-clover-source.test.ts` (átomo, sin nudo, tokens),
  `tests/sidebar-brand-header-source.test.ts`, `tests/claude-thinking-surface-source.test.ts`
  (SMIL + reduced motion), `tests/claude-trace-rail-source.test.ts`.
- **Segunda pasada (mismo día)**: «solo quiero los puntitos sin las líneas» → ThinkingCore no
  dibuja los anillos de órbita (solo electrones + estela + núcleo; idle = tres puntos + núcleo).
  **Favicon y PWA en átomo**: `public/icon.svg`, `favicon.ico` (16/32/48 PNG-in-ICO con trazo
  grueso), `sira-gpt-{180,192,512}.png`, `sira-gpt.png`, `apple-touch-icon.png` y
  `brand/atom-maskable-512.png` se generan con sharp desde el átomo en tinta sobre tile blanco
  (script de sesión, no está en el repo); los `brand/clover-*.png` y `clover-mono.svg` se
  eliminaron (`clover.svg` + `CloverMark` siguen para correos y documentos). Manifest
  `theme_color` #ffffff y maskable al átomo; `layout.tsx` añade `?v=atom` a los iconos para
  que el navegador suelte el favicon trébol cacheado; `sw.js` precachea `/brand/atom.svg`.

## Chats largos: por qué se volvía lento y qué se hizo (added 2026-10-02)

Reporte de Luis: «cuando ya llevo un buen rato hablando se empieza a hacer lento».
Diagnóstico en dos frentes, con las mitigaciones ya existentes respetadas (buffer rAF,
memo de `ChatMessageList`/`MessageComponent`, Virtuoso >40, compactación de contexto).
- **Navegador (por frame mientras llega la respuesta)**: `dedupeMessages` corría dos veces
  por flush (~60 Hz) sobre TODO el chat y el paso B hacía `JSON.parse` de la metadata y una
  regex de normalización sobre cada respuesta histórica por comparación; `shouldRenderChatMessage`
  parseaba `files` de cada mensaje por frame; el efecto de recuperación de tareas del agente
  (`findRecoverableAgentTaskMessage`) recorría todo el historial por frame; y el comparador
  `areMessagePropsEqual` reconstruía firmas/`JSON.stringify(files)` sin atajo cuando el objeto
  era el mismo, y re-renderizaba cada burbuja de agente tras cada turno porque el merge
  recrea `agentMetadata`. Fix: memos por objeto (`WeakMap`, invalidadas por referencia de
  `metadata`/`content`/`files`) en `lib/message-preservation.ts` y
  `lib/chat/message-rendering.ts`; atajo `a === b` y `agentMetadata` por valor en el
  comparador; el efecto de recuperación espera a que termine el stream.
- **Backend (por turno)**: ver «Chats largos — topes del historial por turno» en
  `docs/ENV_VARIABLES.md` (imágenes históricas solo de las 3 filas más recientes, texto de
  adjuntos históricos a 8k, filas de la pila de entendimiento a 6k/1.5k) y
  `GET /api/chats/:id` ya no envía `reasoningDetails` (cadena de razonamiento firmada que el
  cliente nunca lee y que la UI descargaba tras cada turno).
- **Pendiente (decisión de Luis)**: bajar `SIRAGPT_COMPACT_MAX_HISTORY_TOKENS` (80k) /
  ratio de compactación anticipada; mover los bloques volátiles del system prompt detrás del
  historial para que el prefix-caching de OpenAI/DeepSeek/Gemini reutilice el historial;
  umbral de Virtuoso 40 → ~16; `?after=` incremental en `GET /api/chats/:id`.
- Tests: `tests/long-chat-perf.test.ts`, `backend/tests/long-chat-history-caps.test.js`.

## Brief del pedido — entendimiento de lo que pide el usuario (added 2026-10-03)

Pedido de Luis: «mejoras de gran impacto en el entendimiento de lo que pide el usuario» en
`/agentes`. Antes, el ruteo del chat decidía «¿editar archivo o responder?», «¿crear o
modificar?», «¿sobre qué?» con 30+ regex independientes que solo miraban el prompt crudo; los
bloques de entendimiento (conversation-understanding, circuit, IAG, saliency) solo alimentaban
el prompt y nunca el ruteo, y el usuario no veía la interpretación hasta recibir la respuesta.
- **`backend/src/services/request-brief.js`** (puro, ~1 ms): UNA lectura estructurada por turno
  `{ action, deliverable:{kind,format}, target:{kind: attachment|generated_artifact|previous_answer|none,
  name, format}, constraints, references, repair, ambiguity:{score, ask, question, options, note},
  confidence, summary }` a partir del prompt + últimos turnos + adjuntos del turno + ÚLTIMO
  artefacto generado del chat (`agent-runner/artifacts.getLatestConversationArtifact`, una
  query indexada solo si `needsPriorArtifactLookup`) + correferencias + repair. Bilingüe
  ES/EN sin acentos. Refinado opcional fail-open con el tier gratuito (`builder/llm.complete`,
  900 ms) solo para briefs de baja confianza con historial.
- **Cableado en `routes/ai.js`** (tras la fase de entendimiento, antes del triage): cierra la fila
  «Analizando tu mensaje» con «Entendí: Editar el archivo generado «informe.pptx» · azul»
  (detalle = supuesto o «Te pregunto antes de seguir»); emite el frame SSE `request_brief`;
  bloque de sistema `request-brief` tier 0 (`prompt-budget-allocator`) y nunca podado
  (`prompt-kernel` ALWAYS_KEEP), primero tras el master prompt; viaja al loop agéntico
  (`requestBrief`, `requestBriefBlock` en `runAgenticChat`); se persiste en
  `metadata.requestBrief` del mensaje del asistente.
- **Ruteo**: `routingHints(brief)` corrige los dos fallos documentados: «ahora en azul» /
  «ponlas todas rosadas» con un Office generado ⇒ reclamo del AgentRunner aunque no haya
  sustantivo de documento (`editsGeneratedOfficeFile`); «agrega 2 ejemplos más a tu
  explicación» ⇒ NUNCA editor de documentos ni runner (`editsPreviousAnswer`), ni en la ruta ni
  en los reclamos internos de `agentic-chat-stream`. «Crea un word con esta información» sigue
  siendo trabajo del runner (la respuesta anterior es la FUENTE, no el objeto).
- **Aclaración temprana con opciones**: sin fuente («tradúcelo» sin adjunto ni historial, «resume»
  a secas) o conflicto de formato («en word o pdf») ⇒ `intentTriageDecision` `ask` con
  `source:'request_brief'` (inmune al veto de Jev) antes de gastar modelo; la web search se
  salta en cualquier turno que termina en pregunta. El short-circuit ahora SIEMPRE emite
  `intent.clarify_options` y persiste `{ kind:'clarification', question, options }`, que
  `lib/chat-work-status` convierte en el panel de decisión sobre el compositor (chips + respuesta
  libre), en vivo y tras recargar.
- **Frontend**: `lib/api.ts` parsea `request_brief` / `intent.clarify_options`
  (`RequestBriefPayload`, `ClarifyOptionsPayload`); `chat-context-integrated` guarda
  `message.requestBrief` y convierte el frame de aclaración en `metadata.kind='clarification'`;
  `components/chat/request-brief-line.tsx` muestra «Entendí: … · supuesto» bajo la respuesta con
  «Corregir» (prefill del compositor «No era eso. Lo que quiero es: »); se oculta en small talk.
  UI lock re-baselineado para los 4 archivos tocados.
- Tests: `backend/tests/request-brief.test.js` (24), `request-brief-routing-source.test.js` (7),
  `tests/request-brief-frontend-source.test.ts` (4), `tests/components/request-brief-line.test.tsx` (3).
  Envs en `docs/ENV_VARIABLES.md` (`SIRAGPT_REQUEST_BRIEF*`).

## Acabado profesional v3 — CSS de sistema (added 2026-10-03)

Pedido de Luis: «aplica CSS de forma masiva, más profesional, para que la interfaz se vea más
bonita de manera muy avanzada». UN bloque aditivo al FINAL de `app/globals.css` («Professional
finish v3»), sin color nuevo ni código de componentes, todo con tokens (`--shadow-*`, `--ease-*`,
alfa de `--foreground`) para que claro / oscuro / medianoche compartan un lenguaje.
1. **Tipografía** (`@layer base`, las utilidades siguen ganando): `optimizeLegibility` +
   antialiasing, `text-wrap: balance` en títulos y `pretty` en párrafos, tracking óptico por
   tamaño, `kbd` como tecla, placeholders en `--text-tertiary`, una sola curva de movimiento
   para botones/enlaces/ítems que no traen la suya.
2. **Lectura de la respuesta** (`.chat-assistant-message .prose`): títulos en sans 600 con
   escala y h2 subrayado, enlaces con subrayado fino que se intensifica al hover, código inline
   como pastilla sin backticks, marcadores de lista atenuados, cita con barra de tinta sin
   cursiva, tablas como tarjeta (borde, cabecera, zebra suave, cifras tabulares), hr/img.
3. **Profundidad**: burbuja del usuario con brillo superior de 1px + contorno hairline; menús,
   listbox, popovers y diálogos con `--shadow-lg/xl` + brillo superior (tooltips excluidos por
   `data-state`).
4. **Interacción**: filas del sidebar con hover calmado y activa contorneada
   (`[data-sidebar="menu-button"][data-active="true"]`), etiquetas de grupo en terciario,
   tabs activas con `--shadow-sm`, campos de texto con contorno oscuro + lavado de 3px en vez
   del outline (excluye el compositor, el campo celeste de renombrado, `.no-default-focus-ring`
   y `[data-sidebar="input"]`).
5. **Carga**: el `Skeleton` («animate-pulse rounded-md bg-muted») barre con luz en vez de
   pulsar; `prefers-reduced-motion` lo apaga.
- Intactos: superficie del compositor (contrato + e2e), marcas, toasts, paleta del bloque de
  código, botones liquid. Verificado: los 18 tests fuente que fijan `globals.css`, compilación
  Tailwind completa, UI lock re-baselineado solo para `globals.css`.
- Test: `tests/ui-professional-finish-source.test.ts` (único bloque, monocromo sin literales
  cromáticos, exclusiones del compositor, reduced motion).

## Reconocer lo que pega el usuario + transcribir enlaces por minuto (added 2026-10-03)

Pedido de Luis con captura de un chat: un enlace de grabación (upn.class.com) pegado por el
usuario se veía como texto plano, y «transcribir del minuto 1.5 al 10» terminó en «no pude»
sin intentar nada. Tres frentes, todos obligatorios:
- **Burbuja del usuario rica** (`lib/chat/user-text-tokens.ts` puro + `components/chat/
  rich-user-text.tsx`): links (http/https y `www.`) como anclas celestes con la URL completa en
  el title y vista acotada (`host/ruta…`), puntuación final fuera del enlace (paréntesis
  balanceado se conserva), correos `mailto:`, nombres de archivo con extensión como chip mono
  (sin espacios: «informe final.docx» chipea «final.docx»), timecodes `1:30` / `01:02:03` en
  cifras tabulares y `` `código` ``. Texto plano se renderiza idéntico. Montado dentro de
  `<p className="chat-user-bubble-inner">` (invariante del test de wrap). CSS al final de
  `globals.css` («Rich user text»): los links del usuario Y de la respuesta
  (`.chat-assistant-message .prose a`) usan la excepción `--celeste`.
- **`transcribe_url`** (`backend/src/services/agent-harness/tools/transcribe-url-tool.js`):
  herramienta del harness, tier `auto`. URL con la misma postura SSRF que `web_fetch` →
  sondeo `yt-dlp --dump-single-json` (título, duración; login/privado ⇒ `media_login_required`)
  → descarga solo la sección (`--download-sections *start-end`) como mejor audio → ffmpeg
  recorta y codifica mono 16 kHz AAC → `audio-transcriber.transcribe` (escalera + whisper.cpp
  local) → segmentos desplazados al reloj de la grabación, texto `[mm:ss] …` acotado a 60k
  para el modelo y `.txt` completo (y `.srt` si `subtitles`) como tarjeta de descarga
  (`file_artifact`). Errores estructurados con `userMessage` en español
  (`media_login_required` ofrece adjuntar el audio o abrir la grabación en la computadora del
  chat; `media_too_long` pide un rango; `ytdlp_missing`). `start`/`end` aceptan segundos,
  `mm:ss`, `hh:mm:ss`, «1.5 min». Inyectable (`runCommand`, `transcribe`, `saveArtifact`,
  `dnsCheck`) — tests sin red ni binarios. Registrada en `run-agent-turn.buildHarnessTools`,
  etiqueta en `LIVE_DECISION_VERBS`, línea de política en el prompt del loop, y el
  `tool-selector` la conserva en turnos con «transcri/subtít/minuto» o la señal
  `transcribeUrl` (que la ruta deriva del brief). **`backend/Dockerfile` instala `yt-dlp`**.
- **Brief del pedido**: detecta la transcripción (tolerante a «transcirbir», «trascribir»),
  el enlace como objeto (`target.kind='url'`, solo el host en el payload público) y el rango
  `del minuto 1.5 al 10` → restricción `time_range` «01:30 → 10:00»; el bloque de sistema
  ordena usar `transcribe_url` y no decir «no puedo» sin haberla llamado; un enlace nunca
  dispara la pregunta de «¿qué quieres que transcriba?».
- Tests: `backend/tests/transcribe-url-tool.test.js` (10: rango/sección/offset/artefactos,
  login, clasificación de fallos, validación de rangos, URLs inseguras, cap, registro),
  +2 en `request-brief.test.js`, `tests/lib/user-text-tokens.test.ts` (6),
  `tests/components/rich-user-text.test.tsx` (3). Envs en `docs/ENV_VARIABLES.md`.

## OCR local con GLM-OCR — `ollama run glm-ocr` en la Lenovo (added 2026-10-03)

Pedido de Luis: incorporar GLM-OCR (Z.ai, 0,9B, nº 1 OmniDocBench v1.5) a la plataforma.
- **`backend/src/services/ollama-ocr.js`**: cliente de la API nativa de Ollama
  (`POST /api/chat` con `images` base64 y el prompt de tarea del modelo `Text Recognition:` /
  `Table Recognition:` / `Figure Recognition:`; salida Markdown). Sondeo de disponibilidad con
  `GET /api/tags` memoizado (`OLLAMA_OCR_PROBE_TTL_MS`, 5 min): sin Ollama o sin el modelo
  descargado responde `{available:false, reason}` en < 3 s y NUNCA lanza. `createOllamaOcrClient`
  inyectable (`env`, `fetchImpl`, `now`, `sharpImpl`) para tests sin red. Default ON salvo
  `NODE_ENV=test`; kill switch `SIRAGPT_OLLAMA_OCR=0`.
- **Escalera** (`ocr-engine.js`): Tesseract → **`runOllamaOcrFallback`** → OpenAI
  (`runVisionFallback`). Una lectura local válida termina ahí (status `vision_fallback`,
  provider `ollama:glm-ocr`, confianza 95 como la del modelo de nube); cualquier otro resultado
  sigue al peldaño de pago y, sin `OPENAI_API_KEY`, el fallo expone `ocr.ollamaOcr` con la razón
  local. `runVisionPdfFallback` etiqueta el proveedor con los que realmente leyeron páginas.
  Cubre imágenes adjuntas, PDFs escaneados, imágenes dentro de Office y `OCR_MODE=vision`.
- **Producción**: `docker-compose.prod.yml` pasa `SIRAGPT_OLLAMA_OCR` / `OLLAMA_OCR_BASE_URL`
  (`http://siragpt-ollama:11434`, la misma Ollama de SiraGPT Mini en la red `iliagpt-app`) /
  `OLLAMA_OCR_MODEL` (`glm-ocr`) al backend. **El modelo se instala solo**: si el sondeo ve la
  Ollama viva sin `glm-ocr`, el cliente lanza `POST /api/pull` una vez en segundo plano (~1,9 GB,
  `model_pulling` mientras tanto, reintento tras `OLLAMA_OCR_PULL_RETRY_MS` si falla) y re-sondea
  al terminar — Luis no necesita shell en la Lenovo. `OLLAMA_OCR_AUTO_PULL=0` lo apaga. Envs en
  `docs/ENV_VARIABLES.md` y `docs/operations/ENVIRONMENT.md`.
- Tests: `backend/tests/ollama-ocr.test.js` (12: config/alias `/v1`, listado de tags, sondeo y
  memo, auto-pull único + reintento parqueado, request/respuesta, fallos HTTP/timeout/caída,
  integración con el motor y PDF).

## Pulido móvil: sin tooltips táctiles + átomo «Pensando» monocromo (added 2026-10-03)

Pedido de Luis con captura de iPhone: al tocar el botón de contraer el sidebar aparecía la
burbuja negra «Contraer barra lateral ⌘B»; y el indicador de pensar debe ser «simplemente
puntitos dando vueltas, en blanco y negro», rojo solo si el sistema falla. UI lock
re-baselineado para los archivos tocados.
- **Tooltips en táctil**: `components/ui/tooltip.tsx` añade la clase `ui-tooltip` a todo
  `TooltipContent`; bloque «Touch devices: no hover tooltips» al final de `globals.css`:
  `@media (hover: none)` oculta `.ui-tooltip` y su wrapper Radix (`:has`). Radix abre el
  tooltip al enfocar y un toque enfoca el botón; en un dispositivo sin hover solo sobra. Los
  `aria-label` siguen (lector de pantalla).
- **ThinkingCore monocromo** (`components/brand/thinking-core.tsx`): sin estela (`Trail` y el
  dash `stroke-dashoffset` eliminados) y sin color por electrón (tokens `--think-electron-a|b|c`
  eliminados de `globals.css`): núcleo y los tres electrones en `currentColor` (`--think-accent`,
  la tinta), SMIL `animateMotion` por la elipse exacta con fases distintas (0 / −1.1 / −2.3 s).
  Prop `tone: "default" | "error"` (también en `ClaudeAsterisk`): `error` pinta el átomo entero
  en `hsl(var(--destructive))` y añade `claude-asterisk--error` + `data-thinking-tone`.
  `thinking-status-loader` usa el átomo estático en rojo como glifo terminal de error (el check
  de «completado» no cambia).
- **Sin núcleo (2026-10-05)**: «el puntito del medio no, solo los 3 puntitos dando vueltas» →
  ThinkingCore ya no dibuja `thinking-core__core`; se eliminaron `thinking-core-pulse`/`-soft`.
  Activo: tres electrones orbitando; idle y reduced motion: los tres puntos quietos.
- Tests: `tests/mobile-thinking-polish-source.test.ts` (nuevo); actualizados
  `thinking-core-source`, `claude-thinking-surface-source`, `brand-clover-source` y el snapshot
  de `long-operation-indicator`.

## Transcribir CUALQUIER enlace: navegador headless + cookies del usuario (added 2026-10-03)

Reporte de Luis: «el sistema todavía no puede transcribir el video que le di en el link… tiene
que entrar al video y sacar el audio sí o sí» (grabaciones de clase en upn.class.com, YouTube,
cualquier enlace). Diagnóstico: (1) YouTube exige desde 2025-11 un runtime JS + el solucionador
`yt-dlp-ejs`, y el `yt-dlp` de apk no lo trae; (2) los reproductores institucionales son SPAs sin
medios en el HTML (yt-dlp: «Unsupported URL»); (3) una grabación privada solo baja con la sesión
del usuario. Tres piezas, todas en `backend/src/services/agent-harness/tools/`:
- **`media-discovery.js`**: abre la página en el Chromium de la imagen (Playwright,
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`) con las cookies del usuario, pulsa play y registra las
  peticiones de medios (HLS/DASH/MP4/M4A, no segmentos) + `<video>/<source>`/og:video/JSON-LD;
  ranking (master m3u8 > mpd > mp4 > audio), detección de muro de login (redirección a /login,
  `input[type=password]` sin medios), exporta las cookies del contexto en formato Netscape.
  Postura SSRF de web_fetch en CADA petición de la página (route interception: sin IP literales ni
  localhost/.internal, DNS verificado por host). `discoverMedia(url, {cookies, timeoutMs, dnsCheck,
  launch})`; degrada a `browser_unavailable` sin Chromium.
- **`cookie-jar-store.js`**: `cookies.txt` (Netscape) por usuario, cifrado con `utils/encryption`
  (AES-256, `ENCRYPTION_KEY`) en `SIRAGPT_COOKIE_JAR_DIR` (`<UPLOAD_DIR>/cookie-jars`). Nunca se
  loguean ni devuelven valores: solo hosts. `isNetscapeCookieText`, `saveUserCookies`,
  `loadUserCookies`, `mergeNetscapeCookies`.
- **`transcribe-url-tool.js`** (escalera): yt-dlp (con `--no-js-runtimes --js-runtimes
  node:<process.execPath>`, `--cookies` del jar) → si no conoce la página (`DISCOVERY_ELIGIBLE`)
  → `media-discovery` → candidato seguro a yt-dlp con `--referer` + UA + cookies del navegador →
  si yt-dlp lo rechaza, **ffmpeg directo** (`-headers Referer/User-Agent/Cookie` solo del host, `-ss`,
  `-t`). Un `cookies.txt` adjunto en el turno (`loadAttachedCookies`: `ctx.fileIds` + ownership) se
  usa y se guarda para los próximos enlaces; sin adjunto se carga el jar guardado. Muro de login
  sin medios ⇒ `media_login_required` con los dos caminos (adjuntar archivo / adjuntar cookies.txt
  una vez). Resultado: `via` (`yt-dlp` | `browser+yt-dlp` | `browser+ffmpeg`), `discovery`,
  `cookies {source, hosts, saved}`.
- **`backend/Dockerfile`**: `pip3 install "yt-dlp[default]>=2026.8"` (trae `yt-dlp-ejs`) en vez
  del apk; el runtime JS es el Node 22 de la imagen.
- **Verificación real (sin red externa en este sandbox)**: `backend/tests/media-discovery.test.js`
  (9, incluye un caso con Chromium real: SPA que carga el HLS por JS → descubierto; redirección a
  /login → muro) + e2e manual con yt-dlp 2026.08 y ffmpeg reales contra un servidor local
  (archivo directo, reproductor SPA con HLS, reproductor privado sin/con cookies). YouTube y
  upn.class.com NO se pudieron probar desde el sandbox (el proxy de egreso los bloquea): la
  prueba final es en producción con un enlace real.
- Envs en `docs/ENV_VARIABLES.md` (`TRANSCRIBE_URL_JS_RUNTIME`, `_REMOTE_COMPONENTS`,
  `_BROWSER_DISCOVERY`, `_DISCOVERY_TIMEOUT_MS`, `SIRAGPT_COOKIE_JAR_DIR`).

## Transcribir grabaciones con login desde la computadora del chat (added 2026-10-04)

Reporte: «del minuto 60 al minuto 1:20» de una grabación de upn.class.com terminó en «el reproductor
de Class no respondió a tiempo». Dos causas: el rango se leía 1:00:00 → 01:20 y la grabación exige la
sesión UPN del usuario, que el Chromium headless del backend no tiene.
- **Rango**: pasada la hora, un fin «a:bb» anterior al inicio es horas:minutos («1:20» → 1:20:00):
  `transcribe-url-tool.resolveRangeEnd` y `request-brief.resolveRangeEndLabel`. Antes de la hora no cambia.
- **Peldaño «computadora»** (`transcribe_url`, tras yt-dlp y el headless): `media-discovery.discoverMedia`
  acepta `attach()` y trabaja en una pestaña NUEVA del Chrome de la computadora del chat
  (`live-page.connectLiveBrowser`, perfil persistente por usuario, ahí ya está logueado): mismo guard SSRF
  por pestaña, cierra solo su pestaña, desconecta CDP y exporta solo las cookies de la página y de los
  hosts de medios (nunca se guardan en el jar). Encontrado ⇒ `via: computer+yt-dlp|ffmpeg`. Sin medios
  (login) ⇒ abre la página en la pestaña visible (`navigatePage`), emite `computer_navigate` (SSE → el
  panel de la computadora se abre solo, `lib/api.ts`) y devuelve `media_login_in_computer`: «inicia sesión
  ahí y escribe «listo»»; el modelo reintenta la misma URL y rango. Sin computadora para el usuario ⇒
  `media_login_required` de siempre. Kill switch `TRANSCRIBE_URL_COMPUTER=0`; tope 60 s.
- Tests: `backend/tests/media-discovery.test.js` (+4: peldaño computadora, handoff de login, rangos,
  Chromium real en modo adjunto con cookies de otro sitio y pestaña del usuario intactas).

## Transcribir cualquier enlace: tope de 2 min y «rastrear el audio» (added 2026-10-04)

«podes transcribir y rastrear el audio de cualquier link, obligatorio». Causa real del «no respondió a
tiempo»: el harness cortaba `transcribe_url` a los **120 s** (tope global de `event-stream.wrapTools`)
porque `tool-registry.toAgentTool` descartaba el `timeoutMs` de la definición, y el turno agéntico
tenía 5 min. Bajar + transcribir un tramo de 20 min nunca cabía.
- `toAgentTool` conserva `timeoutMs` (afecta a todo tool del harness que lo declare; sandbox-doc-tools
  pasa de 120 s a su propio 65 s). `transcribe_url` declara `toolTimeoutMs(env)` (30 min por defecto,
  `TRANSCRIBE_URL_TOOL_TIMEOUT_MS`), y `agentic-chat-stream` da a un turno «enlace + transcribe» ese
  tope + 5 min (`isLinkTranscription`).
- **`media-capture.js`** (último peldaño): reproduce la grabación en una pestaña (computadora del chat
  por `attach()`, si no headless con las cookies) y graba el audio que suena (`captureStream` +
  `MediaRecorder` opus, elemento silenciado, busca el reproductor también en iframes, pulsa play,
  `seek` al inicio, corta en el fin). Cubre MSE/blob, segmentos con token, iframes. DRM (MediaKeys) ⇒
  `drm_protected`, no se graba. Velocidad `pickCaptureRate` (tiempo real si cabe, hasta
  `TRANSCRIBE_URL_CAPTURE_MAX_RATE`=2, luego `atempo` lo devuelve al reloj real). Rango abierto de
  duración desconocida ⇒ graba lo que quepa y marca `partial: time_budget`.
- `transcribe_url`: `captureOr()` intenta la captura (una sola por llamada) en cada punto donde antes se
  rendía (sin stream, yt-dlp sin descarga, ffmpeg no lee el stream, sin stream en la computadora);
  yt-dlp ausente / 429 / timeout también pasan por el navegador. `via: computer|browser+capture`.
  Kill switch `TRANSCRIBE_URL_CAPTURE=0`.
- Tests: `backend/tests/media-capture.test.js` (6, incluye Chromium real: `<audio>`, MSE/blob e iframe,
  solo el rango, audio real medido con ffmpeg volumedetect).

## Volcado de producción 2026-10-03 — pegado, OCR, cierre HTTP, computadora (added 2026-10-03)

Del log del 3-oct (09:20Z → 16:51Z) que pegó Luis, «corregir y dejarlo en producción». Dos
PR en paralelo: **#990** (pegado + importación de artefactos) y **#992** (OCR, cierre HTTP,
pase correctivo); #992 se fusionó con la base de #990 conservando la versión de #990.
- **Pegado de texto roto desde siempre** (#990): `auto-file-bridge.ingestPastedContent` pasaba
  `source:'paste'` y `metadata:{…}` a `prisma.file.create` — el modelo `File` no tiene esas
  columnas («Unknown argument `source`», cada pegado ≥200 chars) — y llamaba
  `documentIntelligence.analyzeFile(fileRecord, content)` con la firma equivocada. La
  procedencia vive ahora en `DocumentAnalysis.metadata` (columna Json), `getAutoFilesForChat`
  filtra por el prefijo `auto/` del `path`, y los fallos se registran como `E_FILE_INGESTION` /
  `E_FILE_INDEXING` (el mensaje de Prisma podía contener el documento entero). Test de #992
  `auto-file-bridge-prisma-fields` valida cada `data`/`where`/`select` contra las columnas
  reales de `schema.prisma`.
- **OCR local acotado** (#992, `ocr-engine.js`): una foto de WhatsApp tuvo a Tesseract 371 s
  (cientos de «Image too small to scale!!») antes de que GLM-OCR/visión vieran la imagen.
  `recognizeBestVariant` acepta `deadlineAt`; `runLocalImageOcr` fija UN presupuesto para
  ambas pasadas (`SIRAGPT_OCR_LOCAL_IMAGE_BUDGET_MS`, 20 s), `recognizeWithin` carrera el
  `recognize()` contra el plazo y **termina el worker** si se pasa (único modo de parar el job
  WASM); con `timedOut` no hay pase por mosaicos y el fallo se etiqueta `local_ocr_timeout`.
  Todo `createWorker` recibe `tesseractWorkerOptions()` (errorHandler que silencia el ruido del
  core; los errores reales del worker siguen en WARN). Seams en `ocrEngine._internals`.
- **`http_server_close` siempre vencía** (#992, 5 s): `keepAliveTimeout` es 120 s y los SSE
  siguen abiertos, así que `server.close()` nunca terminaba. `utils/http-server-close.js`
  `closeHttpServer(server, {graceMs, onCut})`: cierra el listener, suelta los sockets ociosos
  (`closeIdleConnections`), espera la gracia (`SIRAGPT_HTTP_CLOSE_GRACE_MS`, 3.5 s) y corta el
  resto (`closeAllConnections`); nunca rechaza. El orden de pasos no cambia.
- **Computadora: 502 en `GET /api/agent-computer/activity?sessionId=ac_luis&browser=1`** (346
  líneas en una tarde, más `/action` y `/navigate`): es el sondeo del navegador integrado
  (#981/#988/#989) fallando en `connectLiveBrowser` → `/sessions/<id>/cdp/json/version`.
  **Causa de código (PR posterior a #992)**: el escritorio arranca Chrome con
  `--remote-debugging-port=9222` (`start-desktop.sh`), pero toda relanzada desde el backend
  (`chromeMaximizeOrLaunch`, `chromeOpenUrlCommand`) arrancaba Chrome SIN el puerto: en cuanto
  el usuario cerraba Chrome en el escritorio, CDP quedaba muerto hasta reiniciar el contenedor y
  cada sondeo de 4 s respondía 502. Arreglo: `CHROME_CDP_FLAGS` dentro de `CHROME_DOCKER_FLAGS`
  (`chrome-desktop-flags.js`); `live-page.connectLiveBrowser` con CDP inalcanzable relanza Chrome
  en el MISMO escritorio (`persistent.dockerExec` + `chromeMaximizeOrLaunch`, una vez por
  `CHROME_RECOVERY_COOLDOWN_MS` = 20 s por sesión) y espera hasta 8 s el puerto; contenedor
  ausente ⇒ `desktop_unavailable` (503, «Vuelve a abrir la computadora»), lo demás ⇒
  `browser_observation_unavailable` (502). `agent-computer.js`: `failComputer` registra UNA línea
  WARN por código cada 30 s (`[agent-computer] <code> status= route= session= cause=`, causa
  saneada con `looksLikeSecretOrStack`, repeticiones contadas en `suppressed=`); el sondeo
  `browser=1` responde `200 {ok:false, browser:null, error, message}` cuando el escritorio o su
  Chrome no están (nunca `ok:true`; el panel muestra el error y «Reintentar» igual), en vez de un
  5xx por tick; `browser_viewport_failed` y los demás conservan su estado. Acciones y navegación
  siguen en 5xx con el código real. Tests: `chrome-desktop-flags` (+2),
  `computer-browser-controls` (+3: relanzada, cooldown, contenedor ausente),
  `computer-browser-poll-unavailable` (4).
- **Importación de artefactos a cowork** (#990): leía primero R2 (objeto aún no subido) y luego
  el local (ya borrado por el espejo) → «Artifact content is not available». Ahora local
  primero (handle acotado, realpath dentro de `ARTIFACT_DIR`) y solo con ENOENT una lectura
  remota.
- **Pase correctivo** (#992): «corrective pass failed: Request was aborted.» era nuestro propio
  tope de 8 s (el SDK de OpenAI lanza `APIUserAbortError`, no `AbortError`). Se clasifica por
  señales: tope → «abandoned», Stop del usuario → silencio, otro → fallo real.
- Sin arreglo en código (upstream): turnos degradados `step_timeout` a 60 s con xAI grok-4.7
  + 16 tools (CONVERSAR), `feedback-exemplars > 900ms` (consulta lenta), sondas CVE a
  `/metabase`, y el 502 de `/action` tras un reinicio (escritorio reiniciando).
- Tests (#992): `auto-file-bridge-prisma-fields` (3), `ocr-engine-local-budget` (7),
  `http-server-close` (5, servidor real con SSE + keep-alive), `ai-service-corrective-abort-source` (1).

## Plantilla PPT obligatoria + edición quirúrgica de láminas (added 2026-10-03)

Pedido de Luis: «si le doy un formato de ppt quiero que el software lo siga obligatorio y hacer
cambios quirúrgicos en documentos». Auditoría con agentes (12 lectores + recorrido de escenarios +
verificación adversarial) sobre el pipeline de documentos: todo turno «crea una ppt con este
formato» + Plantilla.pptx terminaba en un deck aurora de pptxgenjs y la plantilla se reducía a un
excerpt de «material de referencia»; no existía ninguna operación para añadir/duplicar/borrar/mover
láminas ni para pintar el fondo de UNA sola. Solo backend; UI lock intacto.
- **`backend/src/services/document-template-intent.js`** (puro): `detectTemplateIntent({prompt,
  fileNames, priorArtifactNames})` → `{isTemplateFill, templateFile, contentFiles, outputFormat}`.
  `.potx/.dotx/.xltx` son plantilla siempre; `.pptx/.docx/.xlsx` solo con cue («con este formato»,
  «usa/usando esta plantilla», «siguiendo el diseño», «como esta», «pasa mi informe al formato de la
  plantilla», par contenido+plantilla) y una intención de crear/convertir/usar-para. Una edición
  acotada («cambia el título de la lámina 3 manteniendo el formato») NUNCA es relleno de plantilla.
- **`backend/src/services/document-template-lineage.js`** (puro, pizzip): `summarizeTemplate`
  (layouts con placeholders, masters, láminas de muestra, fuentes/paleta del tema →
  `describeTemplateForPrompt`) y `verifyTemplateLineage({templateBuffer, outputBuffer})`: el
  entregable debe compartir esquema de color+fuentes del tema, masters (spTree), layouts (por
  nombre), cada lámina referencia un layout y no quedan láminas de muestra ni texto «Haga clic…».
  Para docx: estilos, tema, encabezados/pies, geometría de página, sin XXXX/lorem.
- **Runner** (`agent-runner/index.js`): el turno con plantilla fuerza `creatingNewFile`, no es
  `isEdit` (la barrera de delta no aplica), emite el paso «Leyendo la plantilla adjunta» con el
  inventario, y `buildAgentRunnerPrompt({templateFill})` sustituye el OFFICE_WORKFLOW quirúrgico y
  la regla «NEW PPTX ⇒ create_presentation» por **TEMPLATE WORKFLOW** (`prompt.js
  templateWorkflow`): construir SOBRE `uploads/<plantilla>`; nunca pptxgenjs/sira_design/tema.
  `collectValidOutputs` corre `verifyTemplateLineage` sobre cada salida del formato de la plantilla:
  fallo ⇒ `output_invalid template_not_followed`, el archivo no se entrega y el reintento le dice
  al modelo por qué. Kill switch `SIRAGPT_TEMPLATE_LINEAGE=0`. `shouldRunAgentRunner` reclama
  «haz una presentación como esta» / «usa esta plantilla para una ppt» (cue + sustantivo + adjunto).
- **`create_presentation` con `template`** (`tools.js`): llama a `sira_office.py build_from_template`
  (abre la plantilla, convierte .potx a presentación, elimina las láminas de muestra, crea cada
  lámina desde un layout PROPIO elegido por `layout`/`role` o por placeholders —cover/content/
  section/closing— y rellena título/subtítulo/viñetas; masters/layouts/tema byte-idénticos).
  Entradas del outline aceptan `layout`, `role`, `subtitle`. Reporta `leftover_placeholder_text_on`
  y `warnings` (gráficas: python-pptx sobre la MISMA salida).
- **Ops de lámina en `office_edit`** (`sira_office.py pptx_apply_slide_op`): `add_slide{layout?,
  role?, title?, subtitle?, bullets?, body?, position?}`, `duplicate_slide{slide, position?, title?,
  bullets?}` (clona la lámina y sus partes propias —gráficos, incrustados—, descarta sus notas),
  `delete_slide{slide}`, `move_slide{slide, position}`, `set_slide_background{slide|slides|"all",
  color}` (SOLO esas láminas; `<p:bg>` en la lámina, nunca el master) y `list_layouts{}`.
  Comandos CLI `build_from_template` y `layouts`.
- **Fast path del fondo** (`extractSlideScope`): «solo en la 2» / «la segunda lámina» ⇒ `slide_number`
  escalado a esa lámina; «2, 3 y 5», «de la 2 a la 4», «la última» ⇒ sin fast path (el loop usa
  `set_slide_background{slides}`); «todas» ⇒ todo el deck como antes. Nunca en un turno con plantilla.
- **Brief del pedido** (`request-brief.js`): restricción `template` (primera, con `file`/`format`),
  acción `create`, entregable por formato de la plantilla, resumen «Crear una presentación con el
  formato de «X.pptx» · 8 láminas», línea PLANTILLA OBLIGATORIA en el bloque tier 0 (sin la línea
  «Objeto: … trabaja sobre SU contenido»), `routingHints().templateFile/templateFormat`. El refinado
  LLM no puede inventar una plantilla.
- **doc-agent**: `EXT_TO_SKILL` mapea `.potx/.pptm/.odp→pptx`, `.dotx/.docm/.odt→docx`,
  `.xltx/.xlsm/.ods→xlsx`; `surgical-rules.buildSurgicalPromptAddition({fileNames})` añade
  `TEMPLATE_FILL_RULES` cuando el turno es relleno de plantilla; `validate.validateEditedFile({
  templateFill:true})` tolera la eliminación de láminas/notas de muestra y los cambios de
  `presentation.xml`/rels/`[Content_Types].xml`, nunca de masters/layouts/tema.
- Tests: `document-template-intent` (7), `document-template-lineage` (5), `agent-runner-template-fill`
  (6: reclamo, prompt, create_presentation template=, ops expuestas, barrera de linaje + kill switch,
  scope de láminas), `pptx-slide-ops-engine` (2, motor real con lxml sobre `defensa_demo.pptx`;
  skip honesto sin lxml). Verificado a mano: `build_from_template` y las 5 ops sobre el fixture
  producen paquetes coherentes (content types, rels, sldIdLst) que pasan el linaje. En este sandbox
  `soffice` no carga ni el fixture original (fallo de entorno), así que el render queda para CI.
- Pre-existentes en este entorno (idénticos en el árbol limpio): `agent-runner-scenario-bank`
  («scripted client exhausted», 37) y `agent-runner.test.js` «runAgentRunnerForDocRoute … file shape».

## Presentaciones profesionales en el chat — generación y mejora iterativa (added 2026-10-06)

Pedido: que cualquier «hazme una ppt» salga con diseño de consultor y que cada instrucción
posterior la mejore sin perder ese diseño. Todo backend (sin UI). El camino por defecto en
producción es el AgentRunner (`create_presentation` → pptxgenjs); el pipeline avanzado solo
corre cuando el runner no reclama el turno.
- **Un solo motor** (`agent-runner/index.js` `isCreateDocumentRequest`): para PRESENTACIONES el
  reclamo del runner cubre «haz / genérame / elabora / prepara / draft / build una presentación»
  (`CREATE_DECK_VERB_RE` × `DECK_NOUN_RE`) + «quiero / necesito una (nueva) ppt…» / «quiero 10
  diapositivas…» (`CREATE_DECK_PHRASE_RE`; artículo indefinido o conteo: «quiero la presentación
  en azul» sigue siendo edición) y los plurales «diapositivas / láminas / presentaciones / deck».
  Word / Excel / PDF conservan el reclamo original («crea / genera / hazme + sustantivo»):
  «prepara el informe en Word y PDF» o «prepara un SPSS y un Excel» siguen en el loop agéntico
  (sus tests lo fijan). Antes los pedidos de deck con esos verbos caían en el pipeline genérico
  con otro diseño. El orquestador usa el mismo clasificador.
- **Layouts** (`agent-runner/deck-builder.js`): además de cards / KPI / lista, cada entrada de la
  outline acepta `layout` (agenda · columns · timeline · table · quote · section · closing),
  `subtitle`, `notes` (notas del orador), `columns [{title,bullets}]` (2-3), `steps
  [{title,description}]` (2-6), `table {headers,rows}` (≤14×8; si no cabe → `E_PARAMS`, nunca se
  recorta), `quote {text,author}`. La agenda sin viñetas lista los títulos reales del deck; el
  cierre admite hasta 3 líneas de llamado a la acción; el divisor lleva número; todo texto usa
  `fit:'shrink'`. `resolveLayout` / `planLayouts` son puros.
- **Auditoría de diseño** (`tools.js` `auditDeckPlan`): el resultado de `create_presentation` trae
  `layouts`, `notesSlides` y `designWarnings` (título >70 chars, >6 viñetas, viñeta >160 chars,
  títulos repetidos o de relleno, >3 láminas seguidas de viñetas, sin cierre, sin notas); el
  prompt ordena corregirlas con una segunda llamada al mismo `filename`.
- **Tema según las palabras del usuario**: `makeToolExecutors(sandbox, { deck: { prompt } })` →
  `resolveDesignTheme({ prompt })` cuando el modelo no pasa `theme` ni hay color. Regla nueva en
  `pptx-design-system.js`: «ejecutiva / directorio / inversionistas» → boardroom (los adjetivos
  visuales siguen ganando: «ejecutiva y minimalista» → minimal).
- **Mejora iterativa**:
  - `add_slide` (tool nueva, `agent-runner/deck-append.js` `appendDesignedSlide`): añade UNA
    diapositiva diseñada a un deck de SiraGPT (tema detectado por `SiraDeco[<id>]`, color
    bloqueado incluido), la inserta en `position` (por defecto antes del cierre), renumera todos
    los pies «NN / TT», lleva notas y escribe `<stem>-v2.pptx` (`nextVersionName`). Rechaza
    gráficas (`E_UNSUPPORTED`) y decks ajenos (`E_NOT_SIRA_DECK`): ahí el modelo usa python-pptx.
  - Color sobre un deck de SiraGPT («ahora en azul», «ponlas todas rosadas»,
    `isDeckColorRestyleRequest`): fast path determinista `restyleSiraDeckWithColor` →
    `sira_design.restyle` con `themeFromColor` bloqueado (tarjetas, chips, KPI, pies y gráficas
    con contraste WCAG), sin llamada al LLM; si falla cae a los caminos previos. Un deck ajeno
    conserva `set_slide_background`. Elementos («el título en rojo»), una sola lámina («la
    portada azul») y preguntas quedan fuera.
  - «Agrega una lámina de gracias» sobre un deck de SiraGPT → cierre temado vía
    `appendDesignedSlide`; en decks ajenos el clon (`office-helpers.appendTextSlide`) ya no
    repite las viñetas de la última lámina ni comparte su parte de notas.
- **Prompt** (`prompt.js`): bloque «DECK DESIGN RULES» (estructura cover → agenda (6+) → bloques
  → cierre, una idea por lámina, título ≤ 8 palabras como conclusión, 3-5 viñetas ≤ 14 palabras,
  nunca más de 2 láminas seguidas de viñetas, notas en todas, tema por audiencia, corregir
  `designWarnings`, `add_slide` / restyle para los follow-ups).
- **Nombres de forma**: `SiraDeco[...]` solo para decoraciones que `sira_design` redibuja (barras,
  reglas, pie); lo nuevo usa `SiraChip` (bandas de columnas, pasos), `SiraKpi quote value`,
  `SiraSection number`, `SiraRail`, `SiraAgenda`, `SiraStep`, `SiraQuote`, `SiraColumn`,
  `SiraTable`, de modo que un rediseño posterior los recolorea en vez de borrarlos.
- Tests (registrados en `backend/package.json`): `backend/tests/deck-builder-layouts.test.js`
  (layouts, notas, shrink, auditoría, tema por prompt, add_slide, clon),
  `backend/tests/agent-runner-create-routing.test.js` (reclamo ampliado, clasificador de color,
  prompt y tools; wiring real con python-pptx + LibreOffice) y un caso nuevo en
  `pptx-design-system.test.js`.
- Gotcha de entorno: sin `node_modules` (pizzip/pptxgenjs) solo corren los tests puros
  (`pptx-design-system`); los de pptxgenjs los valida el CI.

## Volcado de producción 2026-10-07 — bloqueo de 2 s por minuto, navegador y ruido (added 2026-10-07)

Del log del 7-oct (15:10 → 18:45 UTC) que pegó Luis. Diagnóstico: el visor Admin → Logs
solo muestra lecturas ≥1,5 s (`live-logs/classify.js` `QUIET_MAX_MS`), así que los 104
`304` de 2 s de `/api/agent-computer/activity` (sondeo cada 4 s), `/login-handoff` y
`/api/credits/me` eran UN sondeo por minuto estancado, siempre el que arranca en :48 y
termina en :50.2, con `stripe_webhook_recovery_completed` cerrando en :50.5 (víctima, no
causa). El único trabajo pesado con esa cadencia era el barrido de recuperación de
transcripciones.
- **`media-transcription-queue.reconcilePendingMedia`**: cargaba filas COMPLETAS (con
  `extractedText`) de todo archivo en etapa pendiente, de cualquier tipo, y filtraba
  `isMediaFile` en Node. Ahora `pendingMediaWhere()` filtra en PostgreSQL por MIME de
  medios, `RECONCILE_SELECT` trae columnas estrechas, el pase es acotado
  (`SIRAGPT_MEDIA_RECONCILE_MAX_ROWS`, 500) y un cursor por servicio continúa el backlog en
  el pase siguiente (sin releer la cabeza ni matar de hambre la cola). Cadencia
  `SIRAGPT_MEDIA_RECONCILE_INTERVAL_MS` (60 s, mín. 15 s). Sin migración (no hay índice
  sobre `processingStage`; el seq scan ya existía, lo caro era el volumen transferido y
  parseado).
- **Navegador integrado** (`computer/navigate-url.js` + gemelo `lib/computer-navigate.ts`):
  «google» → búsqueda (`SIRAGPT_COMPUTER_SEARCH_URL`, default Google) en vez de
  `https://google/`; `localhost:3000` es host:puerto, no esquema.
  `classifyNavigationFailure(cause, url)` en `navigateMemberDesktop`: dirección
  irresoluble/inválida ⇒ 422 (`navigate_host_unresolved` / `navigate_url_invalid`, mensaje
  con el host; sin línea ERROR), sitio caído ⇒ 502 `navigate_site_unreachable`, certificado
  ⇒ 502 `navigate_tls_failed`, lento ⇒ 504 `navigate_timeout`; lo demás sigue
  `navigate_failed`.
- **Ruido**: latido idle de Stripe a `debug` (campo `idle`), `goal_cleanup_*_completed` a
  INFO, sin `console.log` en el callback de Google OAuth.
- **`/admin` error boundary**: `lib/client-bundle-recovery.ts` compartido con
  `app/error.tsx` (recarga única por build+error con cooldown de 10 min, detector ampliado a
  chunks con nombre y módulos dinámicos); el admin reporta a telemetría y muestra «Hay una
  versión nueva de SiraGPT · Recargar». UI lock re-baselineado para esos 4 archivos.
- **Sin arreglo en código**: `POST /api/doc/generate` → `turn_wall` tras 395 s con
  `edits:0 verifyAttempts:1 visionDisagreements:1` (el loop de edición Office agotó los 6 min
  de `documentTurnWallMs()` sin producir un cambio verificado; hace falta la traza del turno,
  no hay defecto evidente en el código del muro). `/api/admin/models` 6,5 s (sondas de salud
  de modelos). `GET /api/codex/projects/by-chat/:id` 404 es la respuesta normal de un chat
  sin proyecto codex.
- Tests: `backend/tests/navigate-url.test.js` (+8), `computer-browser-route.test.js` (+1),
  `media-transcription-queue.test.js` (+2, fixture honra el filtro MIME y `select`),
  `stripe-webhook-recovery.test.js` (+1), `production-log-hygiene.test.js` (5, nuevo),
  `tests/client-bundle-recovery.test.ts` (4, nuevo), `tests/admin-error-boundary-source.test.ts`
  (3, nuevo), `tests/computer-navigate.test.ts` (+1).

## Volcado de producción 2026-10-07 (2.º) — tormenta de refresh, Claude→DeepSeek, trazas Office (added 2026-10-07)

Del log del 7-oct (14:36 → 22:39 UTC, build nuevo desde 19:43) que pegó Luis. Lo del primer
volcado ya no aparece tras el despliegue; lo nuevo:
- **Tormenta de `POST /api/auth/refresh → 401`** (20:15 → 22:37, ~20 peticiones fallidas por
  minuto de UNA pestaña ya deslogueada, siempre en :47–:49 porque Chrome despierta los
  timers de una pestaña en segundo plano una vez por minuto): `lib/authenticated-fetch.ts`
  reintentaba el refresh en CADA 401 aunque el propio endpoint de refresh acabara de
  responder 401, y los sondeos (`CreditsBadge` cada 30 s → `/api/credits/me`,
  `/agent-computer/activity`, `/login-handoff`) seguían vivos. Ahora el transporte tiene un
  **session guard** (`authenticatedFetch.sessionGuard`): un 401/403 del refresh es
  definitivo y bloquea el refresh automático 5 min (`AUTH_REFRESH_FAILURE_COOLDOWN_MS`) para
  ese bearer; se levanta si cambia el token (login en otra pestaña), si un handshake
  (`/auth/me|login|register|refresh`) responde 2xx, con `apiClient.setToken(token)` o al
  expirar. La petición original SIEMPRE se envía (su 401 es la respuesta al llamador); solo
  se omite el refresh. Emite `siragpt:session-expired` una vez por bloqueo (el auth context
  ya lo escucha). `ApiClient._tryRefresh` arma el mismo guard tras su escalera (bearer +
  cookie) y `getMyCredits` devuelve `null` sin petición mientras el guard esté armado.
  Exports: `isAuthRefreshBlocked`, `blockAuthRefresh`, `clearAuthRefreshBlock`. 5xx/red no
  bloquean. UI lock re-baselineado para `lib/api.ts`, `lib/authenticated-fetch.ts`,
  `lib/credits-service.ts` (solo lógica interna, sin cambio visual).
- **`E_PROVIDER candidate_unavailable` con Claude elegido** (22:39, tarea de documento falló a
  los 7 s): el worker no tiene runtime para un id `claude-*` pelado, remapeó la tarea a
  DeepSeek (`runtimeModel=deepseek-v4-flash modelRemapped=true`) pero le pasaba al
  AgentRunner `runnerModelSpec(detected?.provider /* null */, 'deepseek-v4-flash')` =
  «Unresolved:deepseek-v4-flash», que el preflight rechaza. `agent-task-runner.js`
  `runnerPickedModelSpec(profile)`: tras un remap el runner sigue el runtime real
  (`DeepSeek:deepseek-v4-flash`); sin remap, el proveedor y modelo del picker; sin cliente,
  honesto (`Unresolved:…`). `applyAgentRuntimeResolution` factoriza la mutación del perfil.
  Pendiente de decisión de Luis: dar al worker de tareas un runtime Anthropic nativo para
  que «Claude» no corra en DeepSeek (hoy el chat sí usa el SDK de Anthropic).
- **`POST /api/doc/generate` → `edits:0` con `turn_wall` (×3, 395–408 s) y
  `subtask_no_progress` (×1, 113 s)**: sin traza en el log no hay causa. El loop corta
  `subtask_no_progress` tras 3 tool calls seguidas con `ok:false` (`cutSubtaskIfNoProgress`,
  por diseño); el muro de 6 min (`SIRAGPT_AGENT_RUNNER_TURN_WALL_MS`) cae en turnos de
  creación con investigación (5 `web_search` en 20 s) + construcción + render + verificación
  con veto de visión. La línea `[office-edit]` lleva ahora `steps`, `failedCalls`,
  `iterations`, `visionVetoes` / `checksFailVisionOk` (dirección del desacuerdo),
  `toolTrace` («web_search✓1.9s→…→verify_visual✗35s», últimos 24 pasos, ≤700 chars) y
  `lastError` (160 chars del último tool fallido). El evento de error del muro dice el tope
  real («tope de 360 s») y no el «120 s» de la tabla 3H64 (`describeWallCut` en `loop.js`).
  Subir el muro es decisión de Luis (env, hasta 20 min).
- **Solo Luis (entorno)**: `STRIPE_SECRET_KEY` ausente/malformada (pagos deshabilitados),
  `SENTRY_DSN`, endpoint OTEL, `MCP_ALLOWED_HOSTS`, SMTP, claves Groq/Kimi/Meta. Sin arreglo
  en código: `/api/admin/models` 6,5 s (sondas), `codex/projects/by-chat` 404 (normal),
  `/uploads/gpt-icons/…jpeg` 404 (archivo ausente), 401 anónimos del navegador in-app de
  Facebook.
- **CI**: el shard 1 del gate `E2E · critical UI gate` instala por `apt` Chromium con deps y
  las herramientas de escritorio (xvfb, xdotool…) y gastaba ~15,5 de sus 18 min en un run
  normal; en el run de este PR `apt` tardó 12 min y el tope canceló el job con 50/59 specs en
  verde (la app de GitHub de Claude no puede relanzar jobs: 403). `timeout-minutes` 18 → 25
  en `.github/workflows/ci.yml` (ningún test fija ese valor).
- Tests: `tests/lib/authenticated-fetch-session-guard.test.ts` (7, nuevo),
  `tests/lib/credits-service-session-guard.test.ts` (3, nuevo), `api.test.tsx` /
  `refresh-token.test.ts` resetean el guard; `backend/tests/agent-task-runner-remapped-runner-spec.test.js`
  (4, nuevo), `agent-runner-turn-wall-copy.test.js` (1, nuevo), `agent-runner-office-metrics.test.js`
  (traza), `agent-runner-turn-honesty.test.js` (contrato del spec actualizado).

## «Generar una PPT no lo hace» — presupuesto de tiempo y revisor de visión para documentos nuevos (added 2026-10-08)

Reporte de Jorge tras #1007. El log del 7-oct tiene CINCO generaciones de documento y las cinco
fallaron: cuatro por `/api/doc/generate` (tres `turn_wall` a 395–408 s y un `subtask_no_progress`
a 113 s, todas con `edits:0`) y una tarea con Claude elegido (`E_PROVIDER`, arreglada en #1007).
El deck sí se construye (`deck-builder-layouts` 14/14 verdes aquí); lo que fallaba era el ciclo
crear → render → revisión de visión → veto → regenerar → muro, sin entregar nada.
- **El loop no sabía cuánto tiempo le quedaba** (`agent-runner/time-budget.js`, cableado en
  `loop.js`): con ≤ 30 % del muro restante (tope 90 s; 108 s en un muro de 6 min, 144 s en uno de
  8) inyecta UNA vez el mensaje `TIME BUDGET: about N s remain…` (no empezar otra regeneración;
  `inspect_document` + `verify_visual` sobre lo que ya existe o corregir solo los ✗; si no alcanza,
  cerrar y decir en español qué quedó sin verificar) y emite `time_budget` (fila
  «Queda poco tiempo: cerrando el turno» en el timeline de `/api/doc/generate`; la ruta de tareas
  ignora tipos desconocidos). Solo turnos con `turnWallMs` (documentos); el chat no cambia.
- **Muro por tipo de turno** (`documentTurnWallMs(env, { creatingNewFile })`): ediciones 6 min;
  CREACIÓN de un documento nuevo (incluye relleno de plantilla) 8 min
  (`SIRAGPT_AGENT_RUNNER_CREATE_TURN_WALL_MS`), bajo el tope de 10 min del job de la cola.
  `SIRAGPT_AGENT_RUNNER_TURN_WALL_MS` explícito sigue mandando para ambos. Ambas llamadas a
  `runAgentLoop` (loop principal y reintentos de salida) pasan `{ creatingNewFile }`.
- **Revisor de visión para documentos NUEVOS** (`multimodal/visual-verifier.js`
  `NEW_DOCUMENT_REVIEW_SYSTEM_PROMPT`, `mode:'new'|'edit'`): el prompt de ANTES/DESPUÉS pedía
  buscar «elementos movidos o borrados» y «cambios fuera de lo pedido» en un deck recién creado y
  juzgar notas del orador o conteos que una hoja de contacto de miniaturas de 300 px no muestra.
  En modo `new`: `cumple: true|false|null` (null = no comprobable en la imagen, nunca falla), solo
  defectos VISIBLES en `problemas` (texto cortado/desbordado, láminas vacías, marcadores, solapes,
  contraste), sin juicio de gusto; un «fallo» sin requisito fallido ni problema visible NO veta
  (se anota en el texto). El modo `edit` conserva el contrato anterior. `verify_visual` pasa
  `mode` según haya `before`, y para documentos nuevos adjunta hasta dos páginas a tamaño
  completo (`visual.page_images` del motor) junto a la hoja de contacto; `sira_office.py` genera
  esa hoja con 3 columnas de 480 px (antes 4 de 300) y expone `page_images`.
- **Copia de fallo**: `turn_wall` / `wall_clock` → «agotó el tiempo máximo del turno antes de
  terminar y verificar el archivo; si ya había generado uno, no se entregó sin verificar»;
  `subtask_no_progress` → «encadenó tres pasos fallidos seguidos y se detuvo». La política de no
  entregar un archivo sin verificar NO cambia (decisión de producto); lo que cambia es que el turno
  tiene tiempo y criterio para verificarlo.
- Tests: `backend/tests/agent-runner-time-budget.test.js` (5: umbral, disparo único, texto, loop
  real con muro de 2 s y control sin muro, copia), `agent-runner-vision-new-document.test.js`
  (4: prompt por modo, null y «fallo» sin motivo, defecto visible y requisito fallido,
  plumbing de `verify_visual` con páginas completas), `agent-runner-turn-honesty.test.js`
  (muros por tipo + contrato de las llamadas). Envs en `docs/ENV_VARIABLES.md`.

## «No puede generar ppt» (2.ª) — describe_image sin visión + aviso antes del corte (added 2026-10-08)

Captura de Jorge con #1009 ya publicado: el deck se construyó («Próximos pasos» renderizada en el
timeline), luego «Revisando la línea de tiempo · falló» ×2 (icono de imagen) y «Recortando la línea
de tiempo para revisar bordes · falló» (terminal), y el turno terminó con la copia nueva «encadenó tres
pasos fallidos seguidos» sin entregar nada.
- **Causa**: `describe_image` (herramienta F7 para mirar una imagen) se construía con el cliente y el
  modelo del LOOP (`prepareF7Extras({ client: llm, model: resolvedModel })`): con DeepSeek V4 Flash
  elegido, que no ve imágenes, cada llamada era un 400 y la herramienta fallaba SIEMPRE. El agente la
  llamó dos veces sobre la lámina de línea de tiempo, intentó recortar el PNG con Python (tercer
  fallo) y el guardia 3H59/3H61 `cutSubtaskIfNoProgress` (tres tool calls seguidas con `ok:false`,
  `tokensDelta/artifactsDelta` siempre 0) cortó el turno. `verify_visual` nunca tuvo ese problema: su
  revisor usa la escalera de visión (`multimodal/vision-ladder.js`: deepseek-flash → grok → gemini → gpt).
- **Fix 1 — una sola escalera de visión por turno** (`agent-runner/index.js`
  `buildVisionLadderClient({ pickedModel, env, onFailover })`, exportada): `verify_visual` y
  `describe_image` comparten el mismo cliente (`visionLadder`); `prepareF7Extras` recibe
  `client: visionLadder, model: null` (la fachada elige el modelo por llamada) y NUNCA `llm`. Sin
  escalera (sin claves con visión, o `NODE_ENV=test`) `describe_image` no se ofrece: `multimodal/index.js`
  `extraToolDefinitions({ env, vision })` + `extraExecutors` exigen `hasVisionClient(client)`. Seam
  `visionClient` en `runAgentRunner` para tests. La descripción de la herramienta manda a
  `verify_visual`/`render_preview` para Office.
- **Fix 2 — el guardia de «sin progreso» avisa UNA vez antes de cortar** (`agent-runner/no-progress-nudge.js`,
  cableado en `loop.js`): tras tres fallos seguidos inyecta `RECOVERY REQUIRED: …` con cada llamada
  fallida (`tool: error`, ≤160 chars), prohíbe repetir el enfoque, ordena verificar lo que ya existe en
  `outputs/` (`inspect_document` + `verify_visual` sin `before`) o cerrar con honestidad, y emite
  `no_progress_recovery` («Tres pasos fallidos seguidos: cambiando de estrategia»). Tras el aviso el
  guardia mira solo los pasos posteriores: tres fallos seguidos MÁS cortan igual (`subtask_no_progress`).
  El dead letter del mismo tool (3 fallos → la siguiente llamada se rechaza, `tool_dead_letter`) no cambia:
  tres fallos de `execute_python` ahora son aviso → el modelo insiste → dead letter antes de la 4.ª ejecución.
- Tests: `backend/tests/agent-runner-no-progress-recovery.test.js` (6: texto del aviso, forma exacta de
  producción → aviso y recuperación, tres fallos más → corte sin segundo aviso, gate de `describe_image`,
  escalera sin el modelo de texto, contrato de cableado en `index.js`); actualizados
  `ola-3h61-invariants` (M-001: 3+3 fallos), `agent-runner-tool-failure-recovery`,
  `agent-runner-python-api-recovery` (aviso → dead letter) y `agent-runner-f7-multimodal` (seam
  `visionClient`; sin visión no hay `describe_image`).

## Parche de dependencias — audits del 6-oct-2026 (added 2026-10-07)

Los audits de producción (`npm audit --omit=dev` raíz + `scripts/audit-backend-production.cjs`)
bloqueaban todo PR que tocara `package.json`. Parche en el PR de presentaciones (#1002):
- Raíz: `sharp` 0.35.5 (pin exacto + `overrides` `$sharp`), `@capacitor/{android,core,ios,cli}`
  8.5.2, `source-map-js` 1.2.2 (transitivo, `npm update --package-lock-only`).
- Backend: `sharp` 0.35.5, `@modelcontextprotocol/sdk` 1.32.1, `simple-git` ^4.0.2,
  `compression` 1.8.2 y `proxy-addr` 2.0.8 (transitivos). `image-size` sigue en alto pero el
  gate lo acepta con el parche verificado (`backend/scripts/image-size-security-patch.cjs`).
- **simple-git v4** (`github/git.service.js`): el export por defecto desapareció (`{ simpleGit }`)
  y hay un guard de entorno: toda variable `GIT_*` / EDITOR / VISUAL / PAGER / PREFIX /
  SSH_ASKPASS pasada por `.env()` cuenta como explícita y LANZA si no está en
  `allowEnvironment` (las ambientales se descartan en silencio). `hardenedGit` copia
  `process.env` sin esas claves (`ambientGitEnv`) y allowlista `GIT_TERMINAL_PROMPT`.
  Nunca `.env({ ...process.env, ... })` a secas con v4.
- `THIRD_PARTY_LICENSES.md` se editó a mano (sin `node_modules` aquí); si el job Licenses
  marca drift, aplicar el diff que imprime y ya.

## Diez mejoras de alto impacto — backend + frontend (added 2026-10-08)

Pedido de Jorge: «Aplica 10 mejoras de alto impacto en frontend y backend». Auditoría con
5 agentes (rendimiento, seguridad, resiliencia, observabilidad, frontend) sobre el árbol de
producción; cada hallazgo verificado en código antes de elegirlo. Un solo PR, sin UI nueva
(UI lock re-baselineado solo para `hooks/use-file-processing-status.ts`, `lib/api.ts`,
`lib/authenticated-fetch.ts`, `lib/message-preservation.ts`: lógica interna, sin cambio visual).

### Backend
1. **Catálogo de modelos memoizado** (`model-sync-service.js`): `ensureStaticCatalogModels({ maxAgeMs })`
   reutiliza un pase terminado hace menos de `STATIC_CATALOG_MEMO_MS` (10 min) para el mismo set de
   tipos. `GET /api/admin/models` tardaba 6,5 s porque cada lectura re-ejecutaba ~280 UPDATEs
   secuenciales; el picker IMAGE/VIDEO y cada generación de video hacían lo mismo. Las rutas de
   lectura (`admin.js` GET /models y /models/stats, `ai.js` ×3) pasan `maxAgeMs`; «Sync models»
   (POST) sigue ejecutando siempre. Los fallos nunca se memoizan.
2. **API de chats más ligera** (`routes/chats.js`): `GET /:id` ya no lee `extractedText` de los
   knowledgeFiles del GPT (gpts.js prohíbe exponerlo y ningún cliente lo leía — MBs por turno) ni
   `reasoningDetails` (`omit` en la query; el `delete` posterior sigue como contrato). `GET /` omite
   `contextSummary`/`contextSummaryMeta`/`googleCalendarContext`/`draftText`, el mensaje de preview
   lleva `select` estrecho y el índice de tareas se lee UNA vez por página
   (`task-store.listActiveTasksForChats`) en vez de una por chat.
3. **Streams sin crash** (`utils/pipe-stream-to-response.js` en 6 rutas): `Readable.fromWeb(body).pipe(res)`
   y `createReadStream().pipe(res)` sin listener de `error` convertían un reset upstream en
   `uncaughtException` → `process.exit(1)`. `code-runner.js`, `github.js` (proxies: además destruyen el
   body si el cliente cierra), `thesis.js` ×2, `rlhf.js` ×2, `agent-task.js`, `voice-studio.js`.
4. **SSRF en `/api/link-preview`**: `isBlockedAddress` delega en `isPrivateOrReservedAddress`
   (web-fetch) para lo que los matchers locales no veían: la forma hex de IPv4-mapped que produce WHATWG
   URL (`[::ffff:127.0.0.1]` → `::ffff:7f00:1`), NAT64 `64:ff9b::`, CGNAT 100.64/10 (metadata de
   Alibaba), Azure WireServer, rangos de benchmarking/TEST-NET. Tras la respuesta, el host final de una
   redirección se re-valida también por DNS (`resolvesToBlockedAddress`): un destino público que resuelve
   a 10.x devolvía su página.
5. **Share links respetan el borrado** (`routes/public.js`): `/share/:shareId` exige `deletedAt: null`
   en el chat y en sus mensajes; `/share/message/:shareId` responde 404 si el chat padre está borrado y
   lee los mensajes con `findFirst({ deletedAt: null })`. Antes un chat borrado seguía legible por su
   enlace hasta el purgado de 30 días.
6. **Abuso y cuenta**: `SlidingWindowRateLimiter` honra `max` (apps-ai/apps-kv lo pasaban y corrían con
   el default 60/min); `POST /api/telemetry/error` limitado por usuario/IP
   (`SIRAGPT_TELEMETRY_RATE_LIMIT_PER_MIN`, 20) — beacons anónimos con `page` distinto saltaban el
   dedupe de alertas; `PUT /api/users/profile` rechaza cambiar el email (400 `email_change_unsupported`):
   re-vinculaba Google sign-in y el reset de contraseña sin verificación.
7. **Observabilidad**: `react-agent.js` requería `../codex/model-telemetry` (ruta inexistente → la
   telemetría de cada turno del react agent se saltaba en silencio); el request logger se monta ANTES
   de los rate limiters (una tormenta de 429 no dejaba líneas en Admin → Logs); un cliente que cierra a
   mitad de respuesta se loguea con `aborted: true` y Admin → Logs lo resume «· cliente cerró»;
   `unhandledRejection` usa `utils/error-chain.describeErrorChain` (cadena `cause` con code/status/req id,
   nunca `[object Object]`).

### Frontend
8. **Estado de archivos: un poll por archivo** (`hooks/use-file-processing-status.ts` +
   `ProcessingStatusMemo` en `lib/file-processing-status-client.ts`): cada chip del mismo archivo
   (compositor, burbuja, sync) abría su propio GET cada 2 s y un re-render remontaba todos; ahora
   comparten UN loop por fileId, una respuesta terminal (`ready`/`failed`) se reutiliza 10 min entre
   remontajes y el loop se pausa con la pestaña oculta (`visibilitychange`). Los estados de abandono
   (401/403/410, techo) no se cachean.
9. **Transporte**: `lib/api.ts` lee/escribe `auth-token` con try/catch (Safari privado y webviews con
   storage bloqueado lanzaban en el constructor → la app no cargaba); `request()` pasa
   `retryTransient: false` a `authenticatedFetch` (el transporte repetía cada GET 429/502/503/504 además
   del propio reintento del ApiClient: el doble de peticiones contra un servidor que pidió alivio);
   el transporte honra `Retry-After` también en 503 (`parseRetryAfterMs`, delta o HTTP-date, tope 2 s) y
   nunca re-pide si la señal del llamador ya abortó.
10. **Chats largos**: `isAnsweredAssistant` memoizado por objeto (`WeakMap`, invalidado por `content`) —
    el Pass B del dedupe re-parseaba el sobre JSON `agent-task-state` de cada fila intermedia por frame;
    el Pass D calcula el gap de tiempo solo tras las comprobaciones baratas.

### Tests
Backend (registrados en `backend/package.json`): `model-sync-catalog-memo` (7), `chats-api-slim` (3),
`pipe-stream-guards` (3), `public-share-soft-delete` (5), `abuse-and-account-guards` (6),
`observability-hygiene` (9), +3 en `link-preview-route`. Frontend: `tests/lib/file-processing-status-hook.test.tsx`
(5), `tests/lib/authenticated-fetch-transient-retry.test.ts` (6), `tests/lib/api-token-storage.test.tsx` (3),
`tests/message-dedupe-answered-memo.test.ts` (3), +2 en `tests/file-processing-status-client.test.ts`.

### Pendientes detectados (no en este PR)
Memo durable de `feedback-exemplars` (consulta >900 ms), batching de `hydrateChatMessageAttachments`,
escrituras fs del cursor SSE por delta + Map `sseLastEventCursorBySession` sin tope, Map `thesisSessions`
sin expiración, carrera read-modify-write en chunked upload, fetch sin timeout en ejecutores de apps,
observador de consultas lentas, `omit apiKey` en el GET de modelos de admin, caché de créditos con pestaña oculta.

## Automatizaciones + marketplace de skills (OpenClaw nativo) — added 2026-10-09

Pedido de Jorge: «los clientes piden que incorporemos funcionalidad de alto impacto de
https://github.com/openclaw/openclaw». OpenClaw es MIT; según `docs/code/openclaw-port-charter.md`
se REESCRIBE en nativo (nunca se copia código). Las dos brechas de mayor impacto que SiraGPT no
cubría: (A) automatizaciones creadas por el agente desde el chat (recordatorios, cron, `/loop`,
heartbeat) entregadas en el MISMO chat, y (B) instalar skills de la comunidad por referencia
(ClawHub / GitHub / URL) con verdicto de seguridad. Todo backend + `lib/api.ts` (zona horaria);
sin migración de Prisma; sin UI nueva.

### A · Automatizaciones (`backend/src/services/automations/`)
- `schedule.js` (puro): `parseNaturalSchedule(texto, {now, tz})` ES/EN → `{ kind: at|every|cron,
  cronExpr, tz, at, everyMs, adjusted, description }`: «en 20 minutos», «mañana a las 9», «el
  viernes a las 10», «cada lunes a las 9», «todos los días a las 8:30», «lunes a viernes a las 9»,
  «cada fin de semana», «cada mes el día 1», «cada 15 minutos» (minutos/horas se ajustan a divisores
  cron y lo informa en `adjusted`), «15/10 a las 18», cron de 5 campos. Intervalos ≥ 1 día son
  `cron`. Errores: `schedule_in_past` / `schedule_too_far` (1 año) / `schedule_too_frequent` (1 min);
  texto irreconocible ⇒ `null` (la herramienta pregunta, no adivina). `describeSchedule`,
  `nextRunFor`, `formatLocal`, `normalizeTimeZone` (Intl).
- `origin.js`: una automatización es una fila de `ScheduledAgentTask` (tabla del scheduler Cowork) con
  `createdFrom = agent:<once|recurring|loop|heartbeat>;chat=<chatId>` (≤ 60 chars). Las filas `ui`
  conservan el comportamiento Cowork anterior.
- `index.js`: `createAutomation` (tope `SIRAGPT_AUTOMATIONS_MAX_PER_USER` = 25, pasos/coste del plan
  vía `controlPlane.loadUserLimits`, `deliver: 'chat'`), `listAutomations` (`?chatId`), `get/remove/
  setAutomationEnabled` (reanudar recalcula `nextRunAt` y borra la racha de fallos; un recordatorio
  vencido no se reanuda) / `runAutomationNow` (encola al próximo tick del worker), heartbeat por
  usuario (`ensureHeartbeat`: cron `*/30 8-21 * * *` codifica cadencia 15/20/30/60 min + horas
  activas, con cruce de medianoche; `disableHeartbeat`), `buildAutomationSystemPrompt` (hora local
  del usuario + contrato `NO_REPLY`), `nextStateAfterRun` (one-shot se BORRA tras éxito; fallo ⇒
  `lastStatus: failed:N` + backoff 30 s / 1 min / 5 / 15 / 60 min; 10 fallos seguidos ⇒
  `enabled:false` + `lastStatus: disabled:failures` + notificación; recordatorios se rinden a los 3).
- **Scheduler** (`cowork/scheduler.js`): `ensureDeliveryChat` entrega en el chat de origen (chat
  borrado ⇒ chat nuevo «Automatización: …», nunca se pierde el resultado); `executeTask` usa
  `kind: automation:<kind>`, pasa el system prompt de automatización al headless runner
  (`headless-runner.runCoworkHeadless({ extraSystem })`), respuesta exactamente `NO_REPLY` ⇒ sin
  mensaje, sin notificación, `lastStatus: quiet`; con respuesta ⇒ fila USER (el prompt; en heartbeat
  una línea fija) + fila ASSISTANT con `metadata.automation {id, kind, cronExpr, tz}` + `automated:
  true`, toca `chat.updatedAt`, notificación in_app + web_push («Recordatorio de SiraGPT» /
  «SiraGPT tiene algo para ti» / «Automatización ejecutada») con `actionUrl → /agentes?id=<chat>`.
  Fallos de automatización no notifican por intento (solo al pausarse). Modelo por defecto del chat
  de entrega: `native-llm.FLASH` (invariante 3H6; antes `gpt-4o-mini`).
- **Tool del harness `automations`** (`agent-harness/tools/automations-tool.js`, tier `auto`):
  `create` (prompt + `schedule` con las palabras del usuario) / `list` / `remove` / `pause` /
  `resume` / `run_now` / `heartbeat_on` / `heartbeat_off`; responde un `summary` en español con la
  hora local exacta que el modelo repite tal cual. Zona horaria: `lib/api.ts` envía `timeZone`
  (Intl, con try/catch) en cada `/api/ai/generate`; `routes/ai.js` la valida y la pone en
  `toolContext.timeZone` (`normalizeTimeZone`, UTC si falta). Línea de política en el prompt del loop
  agéntico, `LIVE_DECISION_VERBS.automations`, y `tool-selector` la conserva ante señales de
  programación (`automations/cues.js` `mentionsAutomation`, también como `selection.signals.automations`).
- **Rutas** `/api/automations` (`routes/automations.js`, CSRF): `GET /health` (público), `GET /`
  (`?chatId`), `POST /` ({prompt, schedule, chatId, tz}), `GET|DELETE /:id`, `POST /:id/pause|resume|run`,
  `GET|PUT|DELETE /heartbeat`.

### B · Marketplace de skills (`backend/src/services/skills-import.js`)
- Fuentes: ClawHub (`clawhub:<slug>`, slug a secas, `https://clawhub.ai/skills/<slug>`), GitHub
  (`github:owner/repo[/ruta][@ref]`, `owner/repo`, URLs tree/blob), URL directa a un `SKILL.md` o
  `.zip/.skill`. Flujo ClawHub: `GET /api/v1/skills/:slug/verify` (verdicto `fail`/bloqueada ⇒
  `skill_blocked` 409 con motivos, sin descargar nada) → `/install` (archive `downloadUrl` o GitHub
  fijado a commit; `ok:false` ⇒ bloqueada) → zip en memoria (pizzip, sin extraer a disco) →
  `SKILL.md`. `CLAWHUB_TOKEN` solo viaja al origen del hub, nunca a un CDN ajeno.
- Postura SSRF de `web_fetch`: `assertSafeUrl` por salto, DNS anti-rebinding (`connectors/web-fetch`
  `resolveAndAssertSafe`), redirecciones manuales ≤ 3 re-validadas (sin reenviar `authorization`),
  topes 256 KB (SKILL.md) / `SIRAGPT_SKILL_IMPORT_MAX_BYTES` (zip, 2 MB), HTML rechazado
  (`skill_not_markdown`). Guarda con `chatSkills.createUserSkill` (misma validación que subir un
  archivo); un nombre de skill integrada se guarda como `<nombre>-importada`; reimportar actualiza en
  sitio; una skill propia con ese nombre exige `overwrite`. Procedencia en `.skills-state.json`
  (`imports[name] = {source, ref, url, version, sha256, importedAt}`; `skills-persist.normalizeSkillState`
  la conserva acotada y solo escribe la clave cuando hay algo). `searchMarketplace(q)` normaliza
  `/api/v1/search`. Kill switch `SIRAGPT_SKILL_IMPORT_DISABLED=1`.
- **Tools del harness**: `search_skills_marketplace` (auto) e `install_skill` (confirm), en
  `agent-harness/tools/skills-marketplace-tools.js`; política añadida a la línea de Skills del prompt;
  `tool-selector` las conserva (y `use_skill`) cuando el turno menciona skill/habilidad/clawhub/marketplace.
- **Rutas** (`routes/chat-skills.js`): `GET /api/skills/marketplace/search?q=` (límite por usuario
  `SIRAGPT_SKILL_SEARCH_RATE_LIMIT_PER_MIN` = 30, 429 `rate_limited`), `POST /api/skills/import`
  ({source, name?, overwrite?} → 201 {skill, provenance}); `GET /api/skills/:name` expone
  `provenance`; `DELETE` olvida la procedencia. `chat-skills` exporta `saveSkillState` y `reservedSkillName`.

### Tests (todos offline)
`automations-schedule` (10) · `automations-service` (11) · `automations-scheduler` (8) ·
`automations-tool` (7) · `automations-routes` (5) · `skills-import` (10) · `skills-marketplace-tools`
(6) · `tests/automations-timezone-source.test.ts` (2). Envs en `docs/ENV_VARIABLES.md`.
Pendiente (decisión de Luis): canales de negocio entrantes (WhatsApp/Telegram → chat) — requieren
tokens de proveedor; y una vista de «Automatizaciones» en Ajustes (UI lock).

## Marca oficial: el mark de ocho brazos + animación «Pensando» (added 2026-10-09)

Pedido de Jorge con el logo (disco central, ocho brazos rectos —N, NE, E, SE, S, SO, O, NO— con
un punto en cada extremo, una sola tinta) y la página «SiraGPT · Animación en blanco y negro»
(canvas: los ocho brazos se abren y se cierran en un ciclo continuo de 2 s). Sustituye al átomo
de tres órbitas (2026-10-02). UI lock re-baselineado para los archivos tocados.
- **`lib/brand/sira-motion.ts`** (puro, testeado): el modelo del mark y de su movimiento.
  `LOGO_GEOMETRY` (caja 400: alcance 163, centro 48, semilla 38, punta 37, trazo 17 — proporciones
  medidas sobre el logo entregado, el mark abierto toca la caja), `LOGO_GEOMETRY_SMALL` (tamaño
  óptico para ≤ 32 px), `SHOWCASE_GEOMETRY` (los números exactos del canvas entregado, 720),
  `SIRA_TIMING` (ciclo 2000 ms, apertura 970 ms, cierre desde 1000 ms, escalonado 10 ms por rango),
  `ARM_RANKS` [0,2,1,3,0,2,1,3] (brazos opuestos comparten rango), `smooth` (smoothstep quíntico:
  velocidad y aceleración nulas en los extremos), `progressAt`, `frameAt(t)` (distancias de los
  brazos, radio de cada punta —florecen tras salir del centro— y radio del centro, que respira
  entre semilla y tamaño completo), `openFrame` (= el logo estático), `logoGeometryFor(size)`,
  `siraMarkSvg()` (SVG del mark para assets y tests).
- **`components/brand/sira-mark.tsx` (`SiraMark`)**: la marca estática, misma API que tenía
  `AtomMark` (`size`, `title`, `weight`, `className`), `currentColor`, `data-brand="sira"`.
  Renders: sidebar (lockup 22 px + rail 20 px), `BrandLogo`, `BrandCycle`, `PWAInstallPrompt`,
  auth (login/registro/recuperar/reset). **`AtomMark`, `public/brand/atom.svg` y
  `brand/atom-maskable-512.png` se eliminaron.** `CloverMark` sigue solo como componente de
  documentos (sin consumidores en la app).
- **`components/brand/thinking-core.tsx` (`ThinkingCore`, el único glifo «Pensando»)**: ahora es
  el mark en movimiento. SVG con ocho `line` (`thinking-core__arm`), ocho `circle`
  (`thinking-core__tip`) y el centro (`thinking-core__core`); un `requestAnimationFrame` mueve los
  atributos con `frameAt` (sin SMIL ni canvas: nítido a 12–48 px y `currentColor`). El render del
  servidor, `active={false}` y `prefers-reduced-motion` dibujan el frame abierto (el logo); se
  pausa con la pestaña oculta o fuera de vista (`IntersectionObserver`). `tone="error"` pinta el
  mark entero en `--destructive`. El bloque CSS `.claude-asterisk` de `globals.css` ya no tiene
  reglas de electrones.
- **Assets — `npm run brand:assets`** (`scripts/generate-brand-assets.cjs`, en el repo; transpila
  `sira-motion.ts` en memoria y renderiza con sharp; `--only=web|social|android|ios|desktop|extension`):
  `public/brand/sira-mark.svg` (precacheado por `sw.js`, `SCHEMA_VERSION` → `sira-v4`),
  `public/icon.svg` (mark en tinta sobre tile blanco rx 96), `favicon.ico` (16/32/48 PNG-in-ICO con
  la geometría pesada), `sira-gpt-{192,512}.png` / `sira-gpt.png` (tile redondeado con alfa),
  `sira-gpt-180.png` = `apple-touch-icon.png` (OPACOS a sangre: iOS compone el alfa sobre negro y
  aplica su propia máscara), `brand/sira-maskable-512.png` (zona segura 80 %); manifest `purpose: maskable` → ese archivo;
  `layout.tsx` usa `?v=sira` para soltar el favicon átomo cacheado. **Fuera de la web** (eran el
  trébol, el nudo o el default de Capacitor): `opengraph-image.png` / `twitter-image.png` (mark +
  «SiraGPT» en Liberation Sans), Android `mipmap-*/ic_launcher{,_round,_foreground}.png` + los 11
  `splash.png`, iOS `AppIcon-512@2x.png` (1024, opaco) + `Splash.imageset`, escritorio
  `apps/desktop/assets/icon.{png,icns,ico}` (tile redondeado estilo macOS; ICNS con 11 entradas PNG,
  ICO con DIB 16–128 + PNG 256; el mínimo del readiness para el `.icns` bajó a 60 kB porque el mark
  plano comprime mucho mejor que el raster anterior) + tiles appx (vía
  `generate-windows-appx-assets.js`, su `--check` sigue verde), el icono de ficha de Google Play
  `docs/store-submission/assets/android/play-icon-512.png` (opaco a sangre, Play aplica su máscara;
  `native-store-assets.json` apunta ahí) y `extension/icons/icon-{16,48,128}.png`. Las tarjetas
  sociales rotulan «SiraGPT» en Liberation Sans vía fontconfig: el PNG commiteado es el artefacto
  (CI nunca lo renderiza); regenerar con `fonts-liberation` instalada. Pendiente que requiere
  Playwright: capturas de `docs/store-submission/assets` (`npm run native:store:assets:generate`).
- Tests: `tests/lib/sira-motion.test.ts` (8, vitest), `brand-clover-source`,
  `thinking-core-source`, `sidebar-brand-header-source`, `claude-thinking-surface-source`,
  `claude-trace-rail-source`, `mobile-thinking-polish-source` actualizados; snapshot de
  `long-operation-indicator` regenerado. El job «Visual regression» no bloquea (`|| warning`) y
  no tiene PNG en el repo.

## Conexiones externas
- Repo: https://github.com/infosiragpt-ops/SiraGPT-APP
- Remoto: `origin`
- Rama de producción: `production-main` (solo vía PR + squash-merge; nunca push a `main`)
- CI: GitHub Actions, check requerido "CI · required checks passed" (frontend, backend en 4
  shards, seguridad, licencias, UI lock, visual regression, e2e-critical, desktop)
- Producción: https://siragpt.com (health en `/api/health`; `api.siragpt.com` es 404)

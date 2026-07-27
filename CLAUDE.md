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
1. **No modificar la UI/componentes visuales** — solo funcionalidad interna
2. **Trabajar en:** agentes, herramientas de generación, pipelines, sistema de archivos, backend
3. **Push directo a main** en `https://github.com/SiraGPT-ORg/siraGPT`
4. **Cada cambio debe mantener CI verde** — correr `npm test` y `npm run lint` antes de push
5. **Hacer `git pull --rebase` antes de push** para evitar conflictos
6. **Priorizar:** estabilidad, rendimiento, cobertura de errores, calidad de código

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

### Gotchas
- vitest forks pool cuelga aquí → usar `--pool=threads`.
- Tests e2e/integración deben `delete process.env.REDIS_URL` o el publish abre una conexión ioredis
  que mantiene vivo el proceso (cuelga node --test).
- git-real tests: `git config core.autocrlf false` en el repo temporal (Windows CRLF rompe la comparación byte-a-byte).

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

## Conexiones externas
- Repo: https://github.com/SiraGPT-ORg/siraGPT
- Remoto: `origin`
- Branch: main (push directo)
- CI: GitHub Actions (automatic cancel on newer commit)

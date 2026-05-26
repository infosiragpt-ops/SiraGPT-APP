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
npm run lint           # ESLint (ratchet: max-warnings 45)
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
`ambiguityBlock`, `adversarialBlock`. `prompt-budget-allocator` runs after
assembly to trim overflow without dropping tier-0 (master prompt, safety
alerts, contract).

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

## Next Improvement Areas
1. **Document pipeline** — add more generator formats (EPUB, RTF, ODT)
2. **Service health probes** — endpoint health monitoring
3. **Rate limiting** — Redis-backed rate limiter for API endpoints
4. **Intent attribution learning** — feed back actual response-success signals into the lexicon/rule weights to self-improve over time.
5. **Front-end attribution panel** — UI that consumes /api/attribution-toolkit/visualize + /attribution-explainer/explain to render an explainability sidebar (UI work is out of scope for this branch per CLAUDE.md rules).

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
    - `GET  /metrics`          — JSON snapshot
    - `GET  /metrics/summary`  — one-line digest (`?format=text` for plain)
    - `GET  /metrics.prom`     — Prometheus text exposition
    - `GET  /info`             — single-call aggregator for picker first paint
    - `POST /metrics/reset`    — admin-only counter reset
  All read endpoints public, no auth. API key NEVER leaked in any payload.
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
  `toPrometheusText`). Wired into `chargeCredits` so every silent
  fallback increments `sira_free_ia_fallback_total` + per-feature
  labels. Exposed via `GET /api/free-ia/metrics` (JSON) and
  `GET /api/free-ia/metrics.prom` (Prometheus text exposition).
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

## Conexiones externas
- Repo: https://github.com/SiraGPT-ORg/siraGPT
- Remoto: `sira-org`
- Branch: main (push directo)
- CI: GitHub Actions (automatic cancel on newer commit)

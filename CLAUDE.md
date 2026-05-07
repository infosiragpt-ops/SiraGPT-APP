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

## Visual Tools Inventory (11 tools)
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

## Next Improvement Areas
1. **Document pipeline** — add more generator formats (EPUB, RTF, ODT)
2. **Service health probes** — endpoint health monitoring
3. **Rate limiting** — Redis-backed rate limiter for API endpoints

## Conexiones externas
- Repo: https://github.com/SiraGPT-ORg/siraGPT
- Remoto: `sira-org`
- Branch: main (push directo)
- CI: GitHub Actions (automatic cancel on newer commit)

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
npm test               # Tests backend (Node --test) - 994 tests
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

## Test Files (994 tests)
- `backend/tests/visual-media-tools.test.js` — 23+ tests for all visual tools
- `backend/tests/agent-task-store.test.js` — 13+ tests for task-store
- `backend/tests/agent-task-runner-classify.test.js` — 10 tests for error classifier
- `backend/tests/code-sandbox-extras.test.js` — code sandbox tests
- `backend/tests/document-pipeline-registry-formats.test.js` — format tests
- `backend/tests/agent-task-route-contract.test.js` — contract tests
- `backend/tests/tool-manifest-helpers.test.js` — budget + output format tests
- `backend/tests/agent-task-durable-events.test.js` — durable event tests
- `tests/agent-tools-improvements.test.ts` — agent tools hardening tests

## Tool Manifest Functions
- `authorizeToolCall()` — clearance-based authorization
- `checkToolUsageBudget()` — per-task call budget enforcement
- `checkOutputFormat()` — file format validation against manifest
- `validateManifest()` — schema validation
- `listManifests()` — get all registered tool manifests

## Next Improvement Areas
1. **Self-healing agent retry** — use classifyTaskError() in job scheduler
2. **Agent collaboration** — multi-agent coordination patterns
3. **Service health probes** — endpoint health monitoring
4. **Rate limiting** — Redis-backed rate limiter for API endpoints
5. **Error telemetry** — structured error reporting with context
6. **Document pipeline** — add more generator formats (EPUB, RTF, ODT)
7. **Artifact streaming** — SSE-based artifact progress for large files

## Conexiones externas
- Repo: https://github.com/SiraGPT-ORg/siraGPT
- Remoto: `sira-org`
- Branch: main (push directo)
- CI: GitHub Actions (automatic cancel on newer commit)

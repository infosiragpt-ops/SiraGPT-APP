# /code vs Claude Code — paridad de INFRAESTRUCTURA (modelo excluido)

> Auditoría sobre `production-main` (2026-07-26). Comparación pura de
> infraestructura: el modelo de IA queda fuera del análisis por decisión de
> producto — Codex ya enruta a cualquier modelo vía su escalera de
> proveedores, así que toda dimensión aquí es programable y el objetivo del
> 99% es legítimo. Complementa
> [autonomous-company-roadmap.md](./autonomous-company-roadmap.md).

## Inventario de infraestructura de Claude Code (el spec objetivo)

Plano de herramientas (Read/Write/Edit con file-state, Glob/Grep, Bash con
background tasks, WebFetch/WebSearch) · loop con parallel tool calls y
streaming · gestión de contexto (microcompact + compaction con resumen +
continuación post-compact) · sesiones (transcript JSONL, resume/continue,
rewind por checkpoints, fork) · subagentes con aislamiento de contexto ·
extensibilidad (MCP client, hooks Pre/PostToolUse, skills/slash commands,
plugins) · sistema de permisos (modos, allowlists, veto por hooks) ·
memoria (CLAUDE.md auto-cargado, auto-memory) · git/PR workflow · telemetría
de coste · modo headless/SDK · scheduling (cron).

## Puntuación por dimensión (solo infraestructura)

| # | Dimensión | Codex hoy | Gap principal | % |
|---|---|---|---|---|
| 1 | Herramientas | 16 tools: run_command, install_dependencies, read/list/grep/write/edit, web_search, type_check, dev_server_check, browser_check, run_subagent, update_plan, repo_map, use_skill, inspect_database | Glob, WebFetch, file-state tracking (read-before-edit, detección de archivo cambiado), Read multimodal | 70% |
| 2 | Mecánica del loop | Budgets, truncation-nudge, delegación paralela de subagentes (flag) | Parallel tool calls GENERALES (no solo subagentes) | 65% |
| 3 | Contexto largo | Microcompact in-place (estilo Claude Code, literal en el código) | Compaction con RESUMEN LLM + continuación tras compactar | 50% |
| 4 | Verificación | tsc + dev_server_check + browser_check (Chromium) como gates | Correr tests/lint del propio proyecto como gate en verify-loop | 70% |
| 5 | Subagentes | 7 especialistas + custom `.sira/agents.json` + paralelo + contexto aislado | Subagente explorador barato (economía de contexto) | 80% |
| 6 | Extensibilidad | use_skill + agents.json | MCP client (reusar `agent-harness/mcp-client.js`), hooks, slash commands de usuario | 30% |
| 7 | Permisos | Full-auto en sandbox + access-control | Modos por proyecto, tools con aprobación (`waiting_approval` ya existe), veto por hooks | 40% |
| 8 | Sesiones/persistencia | Checkpoints git + SSE replay + boot-recovery de cola | Resume del LOOP a mitad de run, fork, rewind expuesto como acción de usuario | 60% |
| 9 | Git/PR | Commits de checkpoint + rollback/diff | Rama por run, merge, resolución de conflictos, PR como salida | 35% |
| 10 | Capa de modelos (infra) | Escalera + cuarentena + capability registry + cost-resolver | Prompt caching (cache_control), effort control por etapa | 55% |
| 11 | Observabilidad | Timeline SSE + oficina + coste por run + métricas | Dashboard agregado por proyecto/día | 75% |
| 12 | Memoria | `.sira/notes.md` | SIRA.md auto-cargado + ledger estructurado + auto-memory | 40% |
| 13 | Scheduling/autonomía | **Proactive-engine con departamentos — SUPERA a Claude Code** (cron genérico) | — | 110% |
| 14 | Multi-tenant/sandbox | **Runner aislado multi-usuario — Claude Code es single-user local** | segundo sandbox-provider | 100%+ |

**Global ponderado (dims 1–12): ~58–60%. Techo programable: 99%.**
En 13–14 Codex ya está POR DELANTE: Claude Code no tiene un motor de
departamentos que se auto-propone trabajo ni multi-tenancy.

## Backlog completo hacia el 99% — 15 órdenes de trabajo

> Ejecución: modifican `backend/src/services/codex/*` (repo siraGPT, fuera
> del sandbox del agente). Las ejecuta una sesión Claude Code sobre este
> repo; la OT-10 habilita que Codex se las auto-aplique después.

### Tramo 1 · 60% → 75%
- **OT-1 · Prompt caching** (S): `cache_control: {type:'ephemeral'}` en
  system prompt + prefijo estable del transcript (`anthropic-turn.js`).
  Criterio: cache hits visibles en `usage`; test con fetch mockeado.
- **OT-3 · Tests/lint del proyecto como gate** (S): en `verify-loop.js`,
  tras tsc correr `bunx vitest run --reporter=json` y eslint si existen;
  fallos → fixer con presupuesto `CODEX_VERIFY_FIX_STEPS`.
- **OT-8 · SIRA.md + ledger** (S): cargar `SIRA.md` del workspace al system
  prompt; el agente lo actualiza al cerrar; ledger `brief.ledger[]` con
  outcomes (== Fase 1 del roadmap de autonomía).
- **OT-11 · File-state + glob** (S): tracker read-before-edit en
  `build-tools.js` (edit sobre archivo no leído o cambiado desde la última
  lectura → error instructivo); tool `glob` sobre el runner.

### Tramo 2 · 75% → 85%
- **OT-2 · Compaction con resumen + resume del loop** (M): resumen LLM del
  prefijo cuando microcompact no baste; persistir `{summary, tail}` en el
  run; boot-recovery REANUDA runs interrumpidos en vez de marcarlos error.
- **OT-16 · Parallel tool calls generales** (M): ejecutar en paralelo
  cualquier turno multi-tool sin dependencias (hoy solo run_subagent);
  read-after-write serializado por archivo.
- **OT-6 · Hooks + permisos por proyecto** (M): `.sira/hooks.json`
  pre/post-tool (allow/deny/transform) + `brief.permissions` con
  `waiting_approval` para tools sensibles.
- **OT-4 · Visión de browser_check** (M): screenshot como bloque imagen si
  el modelo soporta visión (capability registry); fallback texto.

### Tramo 3 · 85% → 93%
- **OT-7 · Rama git por run + merge** (M): `run/<id>` por run, merge al
  cerrar verde, tool `resolve_conflict`; habilita N runs concurrentes.
- **OT-9 · Background tasks** (M): `run_command {background:true}` +
  registro de procesos + `task_logs`/`task_stop` + límite por workspace.
- **OT-12 · Sesiones: transcript + fork + rewind de usuario** (M):
  transcript JSONL por run en el artifact store; acciones "continuar
  desde", "fork" y "rewind a checkpoint" en la API (`codex.js`).
- **OT-17 · web_fetch** (S): reusar `agent-harness/tools/web_fetch`
  (denylist SSRF ya resuelta) como tool de Codex.

### Tramo 4 · 93% → 99%
- **OT-5 · Cliente MCP** (L): montar `agent-harness/mcp-client.js` en
  `build-tools.js`; servers por proyecto (`.sira/mcp.json` + `mcp_servers`).
- **OT-14 · Slash commands de usuario** (S): skills invocables desde el
  composer (`/deploy`, `/test`, `/review` → prompts parametrizados del
  registro de skills).
- **OT-10 · Self-hosting** (L): tipo de proyecto `repo` (git URL): Codex
  clona siraGPT con hooks+ramas obligatorios y PR como salida — a partir
  de aquí Codex se mejora a sí mismo.

## Secuencia

Tramo 1 completo (una semana) → Tramo 2 → Tramo 3 → Tramo 4. Dentro de cada
tramo las OT son paralelizables (módulos disjuntos). Cada OT lleva tests
offline registrados en `backend/package.json` y debe dejar CI verde.

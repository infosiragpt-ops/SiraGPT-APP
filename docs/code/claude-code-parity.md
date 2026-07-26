# /code vs Claude Code — análisis de paridad de infraestructura

> Auditoría sobre `production-main` (2026-07-26). Comparación dimensión a
> dimensión del motor Codex V2 (`backend/src/services/codex/`) contra la
> infraestructura de Claude Code. Complementa
> [autonomous-company-roadmap.md](./autonomous-company-roadmap.md).

## Puntuación por dimensión

| # | Dimensión | Codex hoy | Claude Code | % |
|---|---|---|---|---|
| 1 | Plano de herramientas | 16 tools tipadas: run_command, install_dependencies, read/list/grep/write/edit, web_search, type_check, dev_server_check, browser_check, run_subagent, update_plan, repo_map, use_skill, inspect_database | Bash completo + Read multimodal (imágenes/PDF) + Glob + WebFetch + background tasks | **70%** |
| 2 | Loop agéntico | Budgets, truncation-nudge, update_plan, delegación paralela (flag) | Parallel tool calls generales, interleaved thinking, streaming granular | **65%** |
| 3 | Contexto largo | Microcompact in-place (recorte de tool-results viejos, tail verbatim) | Compaction con RESUMEN LLM + continuación de sesión post-compact + memoria en archivos | **55%** |
| 4 | Verificación | tsc + dev_server_check + browser_check (Chromium real) | Suites de test arbitrarias + lint + hooks de verificación | **70%** |
| 5 | Subagentes | 7 especialistas + custom `.sira/agents.json` + paralelo | Task tool + agents custom + aislamiento de contexto | **80%** |
| 6 | Extensibilidad | use_skill + agents.json | **MCP client** (ecosistema entero) + hooks Pre/PostToolUse + plugins + slash commands | **30%** |
| 7 | Permisos/seguridad | Full-auto dentro de sandbox; access-control.js | Modos de permiso, allowlists, sandbox bash, veto por hooks | **40%** |
| 8 | Persistencia | Checkpoints git + SSE replay + boot-recovery de cola | Resume de SESIÓN del loop a mitad de tarea, rewind | **65%** |
| 9 | Git/PR workflow | Commits de checkpoint | Ramas, PRs, gh CLI, resolución de conflictos, co-authoring | **35%** |
| 10 | Capa de modelos | Escalera Anthropic→OpenRouter→Cerebras + cuarentena + cost-resolver | **Prompt caching** (cache_control), contextos 1M, effort control | **55%** |
| 11 | Observabilidad/UX | Timeline SSE + oficina 3D + métricas/coste por run | Terminal + transcript + /cost | **75%** |
| 12 | Memoria de proyecto | `.sira/notes.md` | CLAUDE.md auto-cargado + memoria persistente por directorio + auto-memory | **40%** |

**Global ponderado: ~58–60%.**

## Verdad incómoda sobre el "99%"

Tres componentes de Claude Code NO son alcanzables programando features en
Codex, y conviene saberlo antes de gastar esfuerzo:

1. **El modelo**: gran parte de "lo que hace bien Claude Code" es Claude
   (Opus/Fable) con interleaved thinking. Codex ya enruta a Claude vía
   `ANTHROPIC_API_KEY` — ese % se compra, no se programa.
2. **Acceso nativo al host**: Claude Code vive en la máquina del usuario.
   Codex vive en un sandbox multi-tenant — es una decisión de seguridad
   correcta, no un gap.
3. **El ecosistema MCP** existe fuera; se integra, no se reimplementa.

El techo realista programable es **~90–93% de la infraestructura relevante
para su dominio** (construir y operar apps web en workspace aislado). Las
10 órdenes de trabajo siguientes cierran ese tramo, ordenadas por
(impacto ÷ esfuerzo).

## Órdenes de trabajo (OT) — del 60% al ~90%

> Nota de ejecución: estas OT modifican `backend/src/services/codex/*`, que
> vive en el repo siraGPT — FUERA del sandbox del agente Codex. Las ejecuta
> una sesión de Claude Code sobre este repo (o la OT-10 habilita el modo
> self-hosting para que Codex se mejore a sí mismo).

### OT-1 · Prompt caching Anthropic (+velocidad, −coste, S)
En `anthropic-turn.js`/`llm-provider.js`: marcar con `cache_control:
{type:'ephemeral'}` el system prompt y el prefijo estable del transcript en
cada llamada a la API de Anthropic. El system prompt de Codex (~4k tokens con
skills+repo-map) se re-cobra entero en cada turno de cada run. Criterio:
header `anthropic-beta` correcto, cache hit visible en `usage` del response,
test offline con fetch mockeado verificando los breakpoints de cache.

### OT-2 · Compaction con resumen + resume del loop (M)
`agent-loop.js`: cuando `compactMessages` no baste (transcript > umbral),
generar un RESUMEN LLM del historial (decisiones, archivos tocados, estado)
y sustituir el prefijo por el resumen — hoy solo se recortan tool-results.
Persistir `{summary, tailMessages}` en el run para poder REANUDAR un run
interrumpido (proceso reiniciado) en vez de marcarlo error en boot-recovery.
Criterio: run matado a mitad → al reboot continúa y termina; test e2e.

### OT-3 · Tests y lint del proyecto como gate (S)
`verify-loop.js`: tras tsc, si el workspace tiene script `test`, correr
`bunx vitest run --reporter=json` vía runner y alimentar fallos al fixer;
ídem `eslint` si hay config. `frontend_builder` debe generar smoke tests.
Criterio: run que rompe un test existente NO cierra checkpoint sin intentar
arreglo; presupuesto `CODEX_VERIFY_FIX_STEPS` respetado.

### OT-4 · Visión: screenshot de browser_check al modelo (M)
`browser-check.js` ya conduce Chromium: capturar screenshot y, si el modelo
activo soporta visión (capability registry), adjuntarlo como bloque imagen
en la observación del tool. Un agente que VE la página detecta layouts rotos
que el DOM-check no. Criterio: content-block multimodal correcto en
Anthropic/OpenRouter; fallback texto para modelos sin visión.

### OT-5 · Cliente MCP en Codex (L)
Reusar `backend/src/services/agent-harness/mcp-client.js` (YA existe para el
chat: discovery, namespacing, timeouts, headers cifrados) montándolo en
`build-tools.js`: tools `mcp__<srv>__<tool>` por proyecto
(`.sira/mcp.json` + tabla `mcp_servers`). Criterio: un server MCP HTTP de
prueba expone tools en un run; fallo de server nunca tumba el run.

### OT-6 · Hooks + política de permisos por proyecto (M)
`.sira/hooks.json`: `preToolUse`/`postToolUse` con matchers por tool y
acción allow/deny/transform (validación estricta como agents.json).
`brief.permissions`: lista de tools que requieren `waiting_approval` (la
maquinaria de aprobación YA existe en run-service/plan-mode). Criterio:
hook que deniega `run_command rm -rf` visible en timeline; test unitario.

### OT-7 · Git workflow real: rama por run + merge (M)
`checkpoint-service.js`: cada run trabaja en `run/<id>`; al cerrar verde,
merge a `main` del workspace; en conflicto, tool `resolve_conflict` que
delega al subagente debugger. Habilita N runs paralelos sobre un proyecto
sin pisarse (hoy el workspace es single-writer). Criterio: dos runs
concurrentes sobre archivos distintos → ambos mergean; e2e con git real.

### OT-8 · Memoria por proyecto: SIRA.md + ledger (S)
Cargar `SIRA.md` del workspace al system prompt (equivalente CLAUDE.md);
el agente lo actualiza al cerrar (convenciones, decisiones). Implementar el
ledger de la FASE 1 del roadmap de autonomía (mismo cambio, doble uso).
Criterio: run 2 respeta convención anotada por run 1 sin re-descubrirla.

### OT-9 · Background tasks gestionados (M)
`runner-client.js`/`build-tools.js`: `run_command` con `background:true`
→ registro de proceso {id, log tail, status} + tools `task_logs`/`task_stop`.
Hoy el dev server es el único proceso largo y está hardcodeado en su tool.
Criterio: agente lanza un watcher, lo consulta y lo mata; límite de
procesos por workspace.

### OT-10 · Self-hosting: Codex programa a Codex (L, después de OT-6/7)
Tipo de proyecto `repo` (git URL + rama) además del starter Vite: clona
siraGPT en el workspace del runner, con hooks de permisos (OT-6) y ramas
(OT-7) obligatorios, y PR como salida en vez de merge directo. A partir de
aquí las OT restantes se le pueden dictar al propio /code.

## Secuencia recomendada

OT-1 → OT-3 → OT-8 (una semana, ~75%) → OT-2 → OT-4 → OT-6 (~82%) →
OT-7 → OT-9 (~87%) → OT-5 → OT-10 (~90–93%, techo del dominio).

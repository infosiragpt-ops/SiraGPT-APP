# Auditoría APPS + Agents SDK + Research (Cursor / Claude Code / Codex)

**Fecha:** 2026-07-12  
**Alcance:** `/apps`, Enterprise Agents SDK, motor Codex APPS, despliegue producción  
**Producción:** `https://siragpt.com` · VPS `root@62.72.11.231` · `/opt/siragpt`

---

## 1. Diagnóstico (por qué “APPS no funcionaba como Claude Code”)

### Lo que se perdió
El 2026-07-03 el commit `fdf9b8448` (*Agents SDK empresarial*) **reemplazó** la página real de APPS:

| Antes (`b2940afaf`) | Después (prod hasta este fix) |
|---|---|
| `CodexAgentPanel surface="apps"` | Shell de tabs con “Code Agent available at /code” |
| Plan → Build → Preview, timeline, subagents | UI estática de 3 agentes hardcodeados |
| Runner sandbox + Vite preview | Tools del loop con **placeholder** (`result placeholder`) |
| `enterprise_analyst` + `run_subagent` en codex | Sin ejecución real de Read/Write/Bash |

El motor Codex (BullMQ + runner + agent-loop + agent-sdk de subagentes) **seguía en el backend** y en `/code`. Lo roto era la **superficie `/apps`**: desconectada del builder.

### Hallazgos de auditoría (código)

| Área | Estado | Severidad |
|---|---|---|
| `app/apps/page.tsx` | Desconectada del Codex builder | **Crítica** (UX producto) |
| `app/api/agents/run/route.ts` | Tool calls → placeholder | **Crítica** (SDK mentía) |
| `server/agents/*` | Registry TOML OK; sin executor | Alta |
| `backend/src/services/codex/agent-sdk` | Subagents enterprise listos | Bien |
| `backend/src/services/codex/agent-loop.js` | MODO APPS + run_subagent paralelo | Bien |
| `components/codex/*` | Timeline, plan, preview | Bien (no montado en /apps) |
| `@siragpt/agents` package | Client SDK sin tools reales detrás | Media |
| Auth gate en /apps | Ausente en shell SDK | Media |
| Health prod | healthy (db/redis/migrations) | OK |

---

## 2. Qué se implementó en este cambio

1. **Restaurar App Builder en `/apps`**  
   Tab principal monta otra vez `CodexAgentPanel surface="apps"` (plan → auto-build → preview).

2. **Agents SDK con tools reales** (`server/agents/tools.ts`)  
   Sandbox por sesión en `/tmp/siragpt-agent-sessions/<id>`:  
   `read | write | edit | bash | glob | grep | web_search | web_fetch`  
   Path jail, bash blocklist, caps de salida/tiempo.

3. **Loop SSE real** (`app/api/agents/run/route.ts`)  
   Eventos: `agent_start`, `token`, `tool_call`, `tool_result`, `plan`, `subagent_result`, `done`.  
   Sin placeholders.

4. **Agente `enterprise-builder`** (`agents/enterprise-builder.toml`)  
   Especializado en CRM/ERP/inventario/facturación/RRHH/POS.

5. **UI Enterprise Agents** con timeline de tools (estilo Claude Code).

6. **Prompt APPS reforzado** en `codex-agent-panel`: delegación `enterprise_analyst` + subagents paralelos.

7. **Tests de contrato** `tests/agents-sdk-tools.test.ts` (4/4).

---

## 3. Research: Cursor · Claude Code · Codex → qué copiar en SiraGPT

### 3.1 Claude Code + Claude Agent SDK
- **Harness único**: loop autónomo + tools built-in + compactación de contexto.
- **Tools canónicos**: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, AskUserQuestion, Monitor.
- **Subagents** con contexto fresco y resumen final (no el transcript completo).
- **Hooks** Pre/PostToolUse, permisos (`allowedTools`, `permissionMode`).
- **Skills / CLAUDE.md / MCP** como filesystem config.
- **SDK vs CLI**: misma capacidad; SDK para producto/CI; CLI para interactivo.

**Ya tenemos en SiraGPT:** agent-loop, build-tools, agent-sdk subagents, MCP harness, plan mode.  
**Este ship cierra:** tools reales del public Agents SDK + /apps montado al builder.

### 3.2 Cursor
- Harness = Instructions + Tools + Model (tuned por modelo).
- **Codebase indexing** (embeddings) para recall en repos grandes.
- **Subagents paralelos** + **git worktrees** (hasta ~8) para no pisar archivos.
- Agent-first UI (tareas, no solo archivos).
- Semantic search propio + terminal + multi-file edits.

**Pendiente SiraGPT:**
- Index/embeddings de workspace del usuario (repo-map ya existe parcialmente).
- Worktree isolation multi-agente en runner.
- Semantic search de proyecto en APPS (hoy: glob/grep).

### 3.3 OpenAI Codex
- Agent loop con mensaje `developer` que describe el **sandbox** del shell tool.
- Sandbox OS-level (Seatbelt / Landlock / bubblewrap / Windows restricted token).
- Approval modes: Suggest / Auto Edit / Full Auto.
- Parallel tool calls + MCP.
- Cloud sandbox preloaded con el repo (network off by default).

**Pendiente SiraGPT:**
- Sandbox kernel (hoy: temp dir + env strip + timeouts — no seccomp).
- Approval interactivo unificado en Agents SDK (el chat agent sí tiene permission_request).
- Diff review UI antes de apply en el SDK público.

---

## 4. Roadmap de código recomendado (prioridad)

| Prio | Feature | Por qué | Dónde |
|---|---|---|---|
| P0 | ✅ Tools reales + /apps Codex | Producto roto sin esto | Este ship |
| P0 | E2E smoke /apps plan→build→preview en prod | Evitar regresiones | `e2e/` + deploy checks |
| P1 | Permission prompts en Agents SDK | Paridad Claude/Codex | reutilizar `agent-harness` |
| P1 | `repo_map` / semantic search en sandbox | Paridad Cursor | `codex/repo-map` + tool |
| P1 | Worktree isolation multi-subagent | Evitar race en writes | runner |
| P2 | Publish `@siragpt/agents` con docs | Enterprise customers | `packages/siragpt-agents` |
| P2 | Session resume / fork | Claude Agent SDK sessions | SSE + store |
| P2 | Hooks Pre/PostToolUse auditables | Compliance empresas | tools.ts + audit-log |
| P3 | OS sandbox (bubblewrap) en runner | Codex-grade safety | infra/sandbox |
| P3 | Eval harness (tasks golden) | Calidad agent | tests/evals |

---

## 5. Despliegue seguro (recordatorio ops)

```bash
cd /opt/siragpt
git fetch origin
git merge --ff-only origin/production-main   # o main según tracking
docker compose -f docker-compose.prod.yml -f docker-compose.production.override.yml --env-file .env config -q
docker compose -f docker-compose.prod.yml -f docker-compose.production.override.yml --env-file .env build backend frontend
docker compose -f docker-compose.prod.yml -f docker-compose.production.override.yml --env-file .env up -d --no-deps backend frontend
```

**Nunca:** `docker compose down -v`, `docker volume rm`, `docker system prune --volumes`.

Verificación:
- `https://siragpt.com/api/health/ready`
- `https://siragpt.com/apps` → App Builder + Enterprise Agents
- `https://siragpt.com/chat` → no regresión chat

---

## 6. Cómo probar APPS (manual)

1. Login en https://siragpt.com  
2. Ir a `/apps`  
3. **App Builder**: Nueva app → prompt tipo  
   *“CRM de ventas con pipeline, clientes y dashboard de KPIs”*  
   → debe planificar, auto-build, mostrar timeline de tools y preview.  
4. **Enterprise Agents**: tab → Enterprise Software → mismo prompt en modo auto  
   → timeline con `write`/`bash` reales y `session_id`.  
5. Chat en `/chat` para confirmar que no se rompió nada ajeno.

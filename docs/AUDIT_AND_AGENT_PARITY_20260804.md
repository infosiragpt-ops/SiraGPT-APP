# SiraGPT — Auditoría + Paridad Claude Code / Cursor / Codex

**Fecha:** 2026-08-04  
**Alcance:** `/apps`, Agents SDK, `/code` ciudad de agentes, producción siragpt.com  
**Repo:** `infosiragpt-ops/SiraGPT-APP` · rama de trabajo `feat/apps-city-agents-claude-parity-20260804`

---

## 1. Estado de producción (snapshot)

| Check | Resultado |
|---|---|
| `GET https://siragpt.com/api/health/ready` | **healthy** (db, migrations, redis, queue, rbac, auth security) |
| `/chat` HTTP | 200 |
| `/code` HTTP | 200 |
| Rama remota de deploy | `production-main` @ `2c12fe5` (antes de este PR) |
| `origin/main` | **desalineada** (HEAD viejo ~`71ee295`); el deploy real vive en `production-main` |
| SSH desde esta máquina | **Sin llave** (`/Users/luis/.ssh/id_ed25519` no existe; `ssh-add -l` vacío) |

### Riesgo operativo

1. **No hay llave SSH local** para `root@62.72.11.231`. El despliegue seguro documentado (compose up sin `-v`) no se pudo ejecutar desde esta sesión.
2. **`main` ≠ `production-main`**: el flujo CI “promote main → production-main → deploy” puede confundir. Hoy `origin/HEAD` apunta a `production-main`.
3. **Secretos** en `/opt/siragpt/.env` (no se leyeron ni pegaron aquí). Correcto.

---

## 2. Auditoría de código (Apps / Agents / Code)

### 2.1 Fortalezas ya presentes

| Área | Qué hay | Calidad |
|---|---|---|
| `/apps` | `CodexAgentPanel` + tabs Agents SDK / API Keys / Usage | Buena base; auto-approve + `autoExecute` durable |
| Contrato APPS | `lib/code-agent/apps-mode-contract.ts` multi-capa | Sólido (plan→build→verify) |
| Agents SDK server | `server/agents/{registry,tools,llm,safe-network}.ts` + TOML en `agents/` | Patrón Claude Code real (sandbox, tools) |
| SDK cliente | `packages/siragpt-agents` | Público-listo; stream SSE corregido en este PR |
| `/code` ciudad 3D | `agent-office-{city,scene,overlay}` + stances working/blocked | Diferenciador fuerte |
| Empresa de agentes | pools, misiones, evidencia, command center | Maduro en backend codex |

### 2.2 Gaps vs Claude Code / Cursor / Codex (priorizados)

| # | Gap | Impacto | Implementación recomendada |
|---|---|---|---|
| P0 | **Plan mode interactivo** con diff review (Claude Code) | Alto | UI de plan card ya existe; falta “edit plan” + approve parcial por task |
| P0 | **Worktrees / aislamiento multi-agente** (Cursor 2.0) | Alto | Un workspace por subagente (git worktree o copy sandbox) + merge al padre |
| P0 | **Permisos de tools granulares** (allow-once / always / deny) | Alto | Ya hay `ToolPermissionCard` en Codex; unificar en Agents SDK `/api/agents/run` |
| P1 | **Memoria de proyecto** (`CLAUDE.md` / `SIRA.md` auto) | Alto | Leer `SIRA.md` + `.siragpt/memory.md` en cada run |
| P1 | **Skills / slash commands** compartidos | Medio | Mapear `skills/` + slash a tools del agent loop |
| P1 | **Background agents durables** (web/desktop Claude) | Alto | APPS ya marca durable; exponer job queue + resume en UI |
| P1 | **MCP servers** en el loop de agents enterprise | Medio | Reusar `McpServersCard` + bridge en `server/agents/tools` |
| P2 | **Semantic codebase search** (Cursor Composer training loop) | Medio | Índice embeddings por workspace + tool `code_search` |
| P2 | **Parallel “best of N”** | Medio | N runs aislados + selector de mejor evidencia |
| P2 | **Hooks pre/post tool** | Bajo | shell hooks como Claude Code |

### 2.3 Hallazgos de código

- **Duplicación de prompt APPS** reducida: `CodexAgentPanel` ahora usa `buildAppsModePrompt`.
- **SSE del SDK** tenía parse roto (trataba cada línea `data:` sin frames); corregido a frames `\n\n`.
- **Agentes enterprise** solo 4 TOML → se añadieron `crm-builder`, `erp-builder`, `hr-builder`.
- **Ciudad**: densificada (38 torres full), skybridges, helipads, siluetas de agentes en ventanas, escritorios dual-monitor modernos.
- **Deploy path**: sin SSH no se pudo “restaurar” el VPS a mano; la vía correcta es push → CI en `production-main` → workflow Deploy.

### 2.4 Seguridad (checklist breve)

- [x] Tools de agents con sandbox path (no escape del root temp)
- [x] Webhook en `/api/agents/run` fail-closed (`webhook_pending_review`)
- [x] Health auth redis fail-closed en prod
- [ ] Revisar rate-limit por user en `/api/agents/run` (recomendado)
- [ ] No commitear `.env`; backups en `/root/siragpt-backups/` (operación servidor)

---

## 3. Cómo funcionan los competidores (investigación)

### 3.1 Claude Code (Anthropic)

**Modelo de producto:** agent harness multi-superficie (CLI, VS Code, Desktop, Web, JetBrains) con el **mismo motor** (tools + memory + MCP).

**Piezas clave:**

1. **Tools:** Read, Edit, Write, Bash, Glob, Grep, Web, agentes anidados.
2. **Plan mode:** planifica sin mutar; el usuario aprueba.
3. **Sub-agents / agent teams:** lead coordina, subagentes en paralelo.
4. **CLAUDE.md + auto-memory:** instrucciones persistentes del repo.
5. **Skills + hooks:** workflows reutilizables y shell around tool events.
6. **MCP:** conectores a sistemas externos.
7. **Rutinas / cloud / remote control:** trabajo durable fuera del laptop.

**Implicación SiraGPT:** `/apps` debe sentirse como “Claude Code en el browser” — loop tools + plan/build + preview + SIRA.md. Ya hay 70% del harness; faltan worktrees, permisos unificados y memoria de proyecto.

### 3.2 Cursor 2.0 + Composer

**Modelo de producto:** IDE agent-first. Composer es un modelo propio RL-entrenado con tools (semantic search, edit, terminal).

**Piezas clave:**

1. **Hasta ~8 agentes en paralelo** aislados con **git worktrees** o máquinas remotas.
2. **Best-of-N:** varios modelos al mismo problema, se elige el mejor.
3. **UI agent-centered** (no solo chat lateral).
4. **Semantic codebase search** entrenado en el loop.

**Implicación SiraGPT:** la “ciudad de agentes” es la metáfora visual perfecta de multi-agent. Cada persona en un escritorio = 1 agent run/worktree. Falta el aislamiento real de filesystem por agente y “Apply merge”.

### 3.3 OpenAI Codex (CLI / cloud)

**Modelo de producto:** agent de software engineering con sandbox, plan/auto, multi-agente cloud.

**Piezas clave:**

1. **Plan vs auto execution.**
2. **Sandbox** (red restringida, writable paths limitados).
3. **Cloud multi-agent** con review de PRs.
4. **AGENTS.md** (instrucciones de repo, análogo a CLAUDE.md).

**Implicación SiraGPT:** el panel Codex + runner preview ya imita este stack. Endurecer sandbox y documentar `SIRA.md`/`AGENTS.md` como contrato.

---

## 4. Qué implementamos en este PR

1. **Ciudad moderna** (`agent-office-city.ts` / `agent-office-scene.tsx`):
   - Más torres (38 full / 18 thumb), skyline más alto.
   - Paleta glass/graphite corporativa.
   - Sky bridges entre oficinas altas.
   - Helipads en signature towers.
   - Siluetas de agentes en ventanas iluminadas (noche).
   - Escritorios dual-monitor modernos + beacon de agente activo.
2. **Agents SDK enterprise:**
   - TOML: `crm-builder`, `erp-builder`, `hr-builder`.
   - UI Agents agrupada (empresa vs ingeniería).
3. **APPS Claude parity:**
   - Prompt unificado `buildAppsModePrompt` + orquestación subagentes.
   - Badge “Claude Code mode” en `/apps`.
4. **SDK `@siragpt/agents`:** fix del stream SSE.

---

## 5. Roadmap de implementación (siguiente sprint)

### Sprint A — Paridad harness (2 semanas)

1. `SIRA.md` loader en cada run (APPS + agents).
2. Tool permission policy unificada (allow/deny/session).
3. Job durable UI: lista de runs background + resume.
4. Rate limit + cost caps por org en `/api/agents/run`.

### Sprint B — Multi-agent Cursor-style (3 semanas)

1. Sandbox worktree por subagente.
2. UI “Apply” merge de worktree al workspace padre.
3. Hasta N agentes visibles en la ciudad (1 worker = 1 worktree run).

### Sprint C — Product polish (2 semanas)

1. Semantic search tool.
2. MCP bridge en Agents SDK.
3. Best-of-N opcional en APPS enterprise.

---

## 6. Deploy checklist (cuando haya SSH)

```bash
ssh -tt -i /Users/luis/.ssh/id_ed25519 root@62.72.11.231
cd /opt/siragpt
git fetch origin
git merge --ff-only origin/production-main
docker compose -f docker-compose.prod.yml -f docker-compose.production.override.yml --env-file .env config -q
docker compose -f docker-compose.prod.yml -f docker-compose.production.override.yml --env-file .env build backend frontend
docker compose -f docker-compose.prod.yml -f docker-compose.production.override.yml --env-file .env up -d --no-deps backend frontend
# NUNCA: docker compose down -v | volume rm | prune --volumes
curl -sS https://siragpt.com/api/health/ready | head
```

**Alternativa sin SSH:** push a `production-main` → CI verde → workflow Deploy (secrets en GitHub Actions).

---

## 7. Verificación manual post-deploy

1. https://siragpt.com/chat — composer, stop, effort.
2. https://siragpt.com/apps — Builder (auto plan→build) + Agents SDK (CRM/ERP/RRHH).
3. https://siragpt.com/code — abrir empresa → oficina 3D: ciudad densa, day/night, agentes en escritorios.

---

*Documento generado en sesión Grok Build · sin secretos de `.env`.*

# Auditoría del módulo /code · APPS — SiraGPT (rama de producción)

**Fecha:** 2026-07-02 · **Base auditada:** worktree de `production-main` (`aabf41354`)
**Método:** 4 agentes de auditoría en paralelo (frontend chat, host-runner, Codex V2, builder), solo lectura.
**Complemento:** [coding-agents-report.md](coding-agents-report.md) — cómo funcionan Claude Code / Cursor / Codex y qué implementar.

> **Nota:** varios hallazgos ALTA/MEDIA de esta auditoría fueron corregidos el mismo día en el commit
> `feat(code): Claude-engine tiers + Claude Code-parity agent loop` (verificación post-build,
> compactación, grep/list/read-offset/edit-replaceAll, purge-string, tool-calls silenciosos,
> timeout del runner-client, atajo determinista vs Codex, contrato de tier). Se marcan como ✅.

---

## 1. Flujo real del chat de /code

Todo entra por `dispatch` (`components/code/ai-code-chat-panel.tsx`):

```
usuario escribe
  ├─ guard busy/park (mensaje aparcado, slot único)
  ├─ saludo rápido (canned, sin red)
  ├─ gate de conversación (preguntas → chat plano, nunca el generador)
  ├─ atajo build determinista  → /api/builder/generate   ✅ ahora solo si Codex NO está disponible
  └─ FSM nextAgentAction → generate | patch | debug | passthrough
       ├─ generate: Codex V2 (plan→auto-approve→build, SSE) → OpenCode (opt-in) → builder determinista → index.html local
       ├─ patch:    parche determinista → Codex iterate → OpenCode iterate → streaming autoApply
       └─ debug:    SRE determinista o streaming con sreSystemPrompt
```

- **Motor agéntico real** = Codex V2 (`backend/src/services/codex/agent-loop.js`): loop LLM↔tools con eventos SSE
  durables, checkpoints git, métricas de costo. Flag `CODEX_AGENT_V2` activo por defecto en prod.
- **Ejecución** = host-runner (`backend/src/services/code/host-runner.js`, in-process, `/api/code-runner/*`) para el
  preview del navegador; sidecar Bun (`scripts/code-runner.js`, `:4097`) para los workspaces de Codex.
- **Auto-fix del preview**: 3 canales (arranque, tsc, verificación headless con chromium) emiten
  `siragpt:code-fix-error` → el chat repara con presupuesto `AUTO_FIX_MAX=3` por canal y estado terminal `stuck`.

## 2. Top-10 gaps vs Claude Code (por impacto)

| # | Gap | Estado |
|---|-----|--------|
| 1 | **Sin fase de verificación en el loop** — el build cerraba sin comprobar que compila | ✅ corregido: `verifyWorkspace` (bun install + tsc --noEmit) con 2 rondas de autocorrección |
| 2 | **Routing saboteaba al agente** — los build requests clásicos iban a plantilla, nunca a Codex | ✅ corregido: atajo determinista solo sin Codex |
| 3 | **Sin sync workspace→Codex en iterate** — Codex edita OTRO proyecto y pisa el local con starters | ❌ pendiente (fix de mayor palanca restante) |
| 4 | **Contexto sin compactar** — transcript crecía sin límite con modelo 8B | ✅ corregido: microcompact de TOOL_RESULT antiguos (`CODEX_CONTEXT_MAX_CHARS`) |
| 5 | **Modelo débil para agencia** — Cerebras prompted para todo | ✅ corregido: tiers → Claude nativo (standard→Haiku, power→Sonnet) + ladder Anthropic/OpenRouter/Cerebras |
| 6 | **Sin grep/list/read parcial** — el agente adivinaba rutas | ✅ corregido: `list_files`, `grep_search`, `read_file` offset/limit |
| 7 | **edit_file frágil** — solo 1ª aparición, sin guía en ambigüedad | ✅ corregido: conteo de ocurrencias + `replaceAll` |
| 8 | **"Detener" no cancela los motores** — Codex cancelado dispara el fallback que construye igual; OpenCode queda zombie hasta 150s | ❌ pendiente |
| 9 | **Tier LLM streaming regenera archivos enteros viendo solo el archivo activo** | ❌ pendiente (mitigado: ahora ese tier es el 3º fallback) |
| 10 | **Rail de fases teatral** — "Verificar: done" se estampaba sin verificar | ⚠️ parcial (el loop de Codex sí verifica; el rail del streaming sigue decorativo) |

## 3. Hallazgos por área

### 3.1 Frontend chat (`ai-code-chat-panel.tsx`, 3441 líneas)

**ALTA**
- ✅ Atajo determinista robaba build requests (corregido).
- ❌ **Iterate sin sync de workspace**: `codexApi` no tiene endpoint de escritura; `runCodexEngine(iterate)` arranca de
  starter-files y al final `applyFilesToWorkspace` pisa el workspace local. `codexProjectRef`/`engineSessionRef` son
  refs en memoria — un reload pierde el mapeo. *Fix:* endpoint de import/sync + persistir mapping en localStorage.
- ❌ **Cancelación**: tras abort, `handle.done` resuelve → `succeeded=false` → fallback `buildApp` construye lo cancelado;
  en OpenCode `idle` nunca resuelve y el `finally` tardío puede tumbar el `busy` de un turno nuevo.
- ❌ El fallback `buildApp` dentro de `runCodexEngine` duplica el turno del usuario (funciona por closure stale).
- ❌ Recovery hardcodeado "Cafetería Aurora" puede re-disparar un build destructivo en cada reload.

**MEDIA**
- `case "ask"`: ~80 líneas muertas (el FSM ya no devuelve `ask`).
- Parser de fences corta README con bloques ```bash anidados → archivos fantasma.
- `opencodeService.prompt().catch(()=>{})`: si el POST falla al instante, la UI espera el timeout completo.
- `pendingInputRef` slot único: el 2º mensaje aparcado sobreescribe al 1º en silencio.
- Inyección de prompt vía contenido del archivo activo (fence sin escape) en el system prompt.
- ✅ Contrato de tier roto (mandaba nombre de provider) — corregido con `tierForModelChoice`.
- Orphan-recovery borra el user-turn antes de re-despachar: si el dispatch hace early-return, el mensaje desaparece.

**BAJA**: JWT en query string del SSE (queda en logs de proxy) · estado mutable a nivel de módulo (debounce compartido
entre instancias) · `runDeterministicSRE` no setea busy · fuga menor en `freshVoiceIdsRef`.

**Positivo:** iframe del preview `sandbox` sin `allow-same-origin` (origen opaco); escapes correctos en fallbacks.

### 3.2 Codex V2 backend (`backend/src/services/codex/`)

**Corregidos ✅:** sin verify (B2) · contexto (§2) · edit_file (B6) · tool-calls descartados sin aviso (B7) ·
purge `rm -rf` como string que el runner rechazaba · timeout HTTP 30s vs comandos de 120s ·
`codex-access-control.test.js` fuera de la lista de CI.

**Pendientes:**
- **[ALTA] Runner sidecar single-tenant** (`scripts/code-runner.js`): un solo `devProc`/`DEV_PORT` globales — dos
  previews concurrentes de usuarios distintos se matan entre sí. Mitigado solo por el access-gate.
- **[MEDIA] Cancelación solo entre pasos**: un `run_command` de 120s no se interrumpe a mitad.
- **[MEDIA] `event-store` seq process-local**: no escala a multi-réplica sin lock distribuido (OK single-node).
- **[MEDIA] `node -e` en el allowlist** = ejecución arbitraria dentro del contenedor; el límite de seguridad es el
  contenedor — revisar egress/network del runner.

**Bien resuelto:** path traversal, injection git (argv + SHA_RE), carreras de estado terminal (updateMany guardado),
single-active-run (advisory lock), rollback git idempotente, boot-recovery.

**Aclaración:** `codex-run-orchestrator.js` (JSON en disco, clone GitHub→PR→CI) NO es código muerto — es el
"codex-runs legacy", subsistema distinto montado antes de V2 a propósito. Conviene renombrar/documentar.

### 3.3 Host-runner (`backend/src/services/code/host-runner.js`)

- **[MEDIA] Gating fail-open**: con `CODE_HOST_RUNNER=1` y allowlist vacía, TODO usuario autenticado obtiene
  `/exec` = `/bin/sh -c` en el host. *Fix:* exigir allowlist no vacía (fail-closed) cuando el flag está activo.
- **[MEDIA — documentado]** `exec` sin jail de filesystem (cwd no es sandbox); solo aceptable single-tenant/owner-gated.
- **[BAJA]** `/api/code-runner` sin CSRF (mitigado por Bearer) · TOCTOU de puerto (strictPort falla ruidoso) ·
  token de preview sin comparación constant-time.
- **Positivo:** kill de process-group, reaper idle, ownership en todas las rutas, `.env` runtime nunca a disco,
  readiness estricta (rechaza overlays), puerto anulado en runs muertos, env allowlisted a los hijos.
- **Gap de tests:** `execInRun` (la superficie de shell) sin cobertura; `verify-agent` sin test propio.

### 3.4 Builder (`backend/src/services/builder/`)

- **[MEDIA]** `POST /generate` sin límite de longitud de prompt (→ `.isLength({max:10000})`).
- **[MEDIA]** Colisión de entidades duplicadas ("user"/"User") → modelos Prisma duplicados (schema inválido);
  `brief-from-prompt` dedupa pero el intake no.
- **[BAJA]** React por CDN unpkg sin SRI en live-app · `</main>` duplicado (HTML inválido tolerado).
- **Duplicación:** 5 generadores de scaffold con pins divergentes de Vite/TS, 4 copias de `escapeHtml`, 2 semánticas
  de `jsxText`, 3 tablas de temas. `buildViteLandingFiles` (~760 líneas) muerto salvo tests. UI de intake
  (`app/builder/page.tsx`) huérfana sin link de navegación. Modo `'client'` de scaffold sin caller.
- **Docs desactualizados:** el codegen real es Next 15.5.19 + PostgreSQL (no "Next 14 + SQLite").

## 4. Recomendaciones priorizadas (lo que sigue)

1. **P0 — Sync workspace↔Codex + persistencia del project-id** (hallazgo 3.1-ALTA): endpoint
   `POST /api/codex/projects/:id/files` de import + `localStorage` para el mapping chat→proyecto.
2. **P0 — Arreglar cancelación** (Codex fallback post-abort + OpenCode idle zombie).
3. **P1 — Host-runner fail-closed** (flag exige allowlist) + test de `execInRun`.
4. **P1 — Runner sidecar multi-proyecto** (o serializar por proyecto y documentar single-tenant).
5. **P1 — Parser de fences anidados** (4 backticks para markdown) + límite de prompt en `/generate`.
6. **P2 — Poda**: case "ask" muerto, recovery "Cafetería Aurora", `buildViteLandingFiles`, unificar escapes/temas.
7. **P2 — Dedupe de entidades en el intake** + SRI en el CDN de live-app.

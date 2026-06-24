# Codex Agent V2 — Estándar de experiencia agéntica (inspirado en Replit Agent)

**Fecha:** 2026-06-12 · **Estado:** Diseño aprobado · **Flag:** `CODEX_AGENT_V2`
**Módulo:** `/code` (frontend Next.js 14) + `backend/` (Express, Prisma, Redis, BullMQ) + runner Bun (`scripts/code-runner.js`)

Este documento es el estándar que exige el brief del proyecto (PROMPT.md): primero la
investigación del estado actual, luego el estándar UX y la arquitectura que lo implementa.
Todo el desarrollo ocurre detrás del flag `CODEX_AGENT_V2` sin romper ningún flujo existente.

---

## 1. Investigación: estado actual del sistema

### 1.1 Lo que ya existe y se reutiliza

| Pieza | Ubicación | Qué aporta |
|---|---|---|
| Módulo `/code` | `app/code/page.tsx`, `components/code/` | Workspace tipo Cursor: chat panel con 6 modos (incl. `plan`), selector de modelo, Monaco, file tree, terminal, preview con ▶ Ejecutar |
| OpenCode bridge | `/api/opencode/*`, `lib/opencode/opencode-service.ts` | Sesiones de agente, write/edit de archivos, run/stop del dev server Vite, SSE de eventos. **Es el sandbox real del repo** |
| Runner Bun | `scripts/code-runner.js` + volumen Docker `runner_bun_cache` | `bun install` + `bunx vite --port 5173`, URL de preview viva |
| Agent harness | `backend/src/services/agent-harness/` | Eventos SSE tipados con `blockIndex`+`seq`, persistencia en `agent_steps`, `estimateCostUsd()`, permisos con pausa |
| BullMQ | `bullmq@5.76.10` + `@bull-board/*` en `backend/package.json` | Cola de jobs sobre Redis, ya instalada |
| Prisma append-only | `GoalRun`/`GoalRunEvent`, `AgentTask`/`AgentTaskEvent`, `ChatRun` | Patrón probado de eventos persistidos por corrida |
| UI agéntica parcial | `components/agent-trace.tsx`, `thinking-trace.tsx`, `components/code/diff-view.tsx` | Timeline de tools con iconos/duración/colapso, razonamiento colapsable ("Pensé durante 12 s"), visor de diffs |
| Tool-calling multi-modelo | `backend/src/services/agents/prompted-tool-calling.js` + clientes de proveedor | Escalera native/prompted: cualquier modelo puede correr el loop |
| Generación determinista | `lib/code-agent/vite-scaffold.ts`, `backend/src/services/builder/` | Scaffold Vite 7 + React 18 sin LLM; intake/blueprint/codegen del Builder |
| i18n | `messages/*.json` (59 locales), patrón `scripts/add-agent-locale-keys.js` | Propagación de claves nuevas a todos los locales |

### 1.2 Los huecos reales (lo que se construye)

1. **Workspace con git** por proyecto: no hay `git init`, ni checkpoints como commits, ni rollback, ni diffstat.
2. **Corridas server-driven**: hoy el navegador orquesta la generación (`ai-code-chat-panel.tsx`); no hay jobs, ni timeline reconstruible al recargar.
3. **Protocolo SSE persistido** específico de builds (narrativa + acciones + razonamiento + checkpoints + métricas).
4. **Métricas por corrida** (duración, acciones, líneas leídas, ±diff, tokens, costo) y sus tarjetas.
5. **Tarjetas de error accionable** y tabla de diagnósticos benignos.
6. **Composer réplica** (toggle Plan, selector Power, micrófono) y **barra inferior de pestañas** mobile-first.

### 1.3 Desajustes del brief con el repo (resueltos por decisión del propietario)

El brief describe React 19 + Vite, Drizzle ORM, BullMQ y `sandbox.chatagic.com`. Decisiones tomadas:

| Decisión | Resolución |
|---|---|
| Stack | **Adaptar a siraGPT**: Prisma (no Drizzle), módulo `/code` (no "Codex"), runner OpenCode/Bun como sandbox, BullMQ existente |
| Capturas de referencia | No disponibles → se diseña sobre el patrón conocido de **Replit Agent** (el brief lo describe textualmente con detalle) |
| Alcance UI | **Todo, por fases**: primero el motor con la UI actual, al final composer/tabs mobile-first |
| Costos | **Multi-proveedor**: `usage` del proveedor cuando exista, `/api/v1/generation` cuando sea OpenRouter, `estimateCostUsd()` como fallback, con `costSource` explícito |
| Motor | **Subsistema nuevo** (modelos `codex_*` + cola BullMQ + worker): aislamiento total tras el flag; se reutilizan utilidades y patrones, no tablas |

---

## 2. Estándar UX (el contrato visual y de comportamiento)

### 2.1 Flujo objetivo

1. El usuario entra a `/code` y **crea un proyecto** → se provisiona un workspace aislado en el runner (directorio propio, repo git inicializado, dependencias instaladas, dev server y URL de preview).
2. En el chat describe **qué quiere construir** (landing, página o sistema web completo).
3. El agente responde **primero con el plan propuesto**: arquitectura, páginas, componentes y tareas. El usuario lo aprueba o lo ajusta. El toggle **Plan** del composer restringe la corrida a solo planificación (nunca ejecuta).
4. Al ejecutar el build, el chat **narra en tiempo real, en primera persona y en español** lo que el agente hace, intercalando:
   - **Párrafos de narrativa** (texto streaming del modelo).
   - **Filas de chips de acciones agrupadas**: ícono por tipo (terminal, lectura de archivos, razonamiento, web), contador "N actions", expandibles al detalle de cada comando y su salida resumida.
   - **Bloques de razonamiento colapsables** con etiqueta y duración: «Planning database migration verification (47 seconds)».
   - **Píldora flotante "Scroll to latest"** cuando el usuario se desplaza hacia arriba durante el streaming.
5. Al finalizar cada corrida se renderizan **dos tarjetas colapsables**:
   - **"Checkpoint made X ago"** — commit git real con título descriptivo, fecha y tres acciones: *Rollback here* (hard reset confirmado), *Changes* (visor de diff), *View preview* (URL viva del sandbox).
   - **"Worked for N minutes"** — métricas reales: *Time worked*, *Work done* (número de acciones), *Items read* (líneas), *Code changed* (+adiciones −eliminaciones), *Agent Usage* (costo total con precio original tachado y precio final aplicado).
6. Ante errores bloqueantes, tarjeta **"Acción requerida de su parte 🔴"**: error crudo en bloque de código copiable, lista de capacidades bloqueadas y enlace de remediación. Los diagnósticos benignos se anotan sin alarmar.
7. Recargar la página **reconstruye el timeline completo** desde la base de datos.

### 2.2 Composer (réplica mobile-first)

- Placeholder **"Make, test, iterate..."**, botón **+** (adjuntos), toggle **Plan**, selector de modo **"Power"** mapeado a tiers del catálogo de modelos (Eco → FlashGPT/Cerebras gratis · Estándar · Power → modelos top), **micrófono** para dictado (Web Speech API) y botón de envío.

### 2.3 Barra inferior de pestañas (mobile-first)

| Pestaña | Mapea a |
|---|---|
| Preview | `preview-pane` (iframe de la URL viva) |
| Agent | Chat + timeline de la corrida |
| Web | Webview de la URL de preview a pantalla completa |
| Conexiones | Integraciones/MCP (reutiliza el patrón `McpServersCard`) |
| Checklist | Tareas del plan aprobado con progreso por corrida |
| Archivos | File tree + editor |

En desktop se conserva el layout de paneles redimensionables actual; la barra aparece en viewports móviles.

---

## 3. Arquitectura

```
Usuario (/code, flag ON)
  │ POST /api/codex/projects            → provisioning (workspace + git init + install + preview)
  │ POST /api/codex/runs {mode}         → encola job BullMQ "codex-runs"
  │ GET  /api/codex/runs/:id/stream?afterSeq=N   (SSE: replay desde DB + canal vivo)
  ▼
Worker BullMQ (proceso backend)
  ├─ Loop del agente: LLM (multi-proveedor, escalera prompted/native) + herramientas
  │    run_command / read_file / write_file / edit_file (bridge OpenCode + runner) / web_search
  ├─ Cada evento → INSERT codex_events (seq monotónico) + PUBLISH Redis (canal por run)
  ├─ Checkpoint → git commit real en el workspace
  └─ Cierre → métricas (duración, acciones, líneas, diffstat, tokens, costo) → run_summary
```

- **Server-driven**: el navegador solo crea corridas y consume el stream. Cancelar = `POST /api/codex/runs/:id/cancel` (marca el job + aborta el loop).
- **Aislamiento**: con `CODEX_AGENT_V2` apagado, las rutas `/api/codex/*` devuelven 404 y la UI no cambia en absoluto. Ningún código existente se modifica salvo registro de rutas/worker (condicionado al flag) y la rama de UI nueva.

## 4. Modelo de datos (Prisma, migración aditiva)

Seis modelos nuevos, `@@map` a tablas `codex_*`:

- **CodexProject** — `userId`, `name`, `workspacePath`, `opencodeSessionId?`, `previewUrl?`, `status` (`provisioning|ready|error`), `brief` JSONB, timestamps.
- **CodexRun** — `projectId`, `mode` (`plan|build`), `status` (`queued|running|waiting_approval|done|error|cancelled`), `jobId`, `model`, `tier`, `planRunId?` (el build referencia al plan aprobado), `startedAt/finishedAt`.
- **CodexEvent** — `runId`, `seq` (único por run, monotónico), `type`, `payload` JSONB, `ts`. **Fuente única de verdad del timeline.** Índice `(runId, seq)`.
- **CodexAction** — proyección consultable: `runId`, `kind` (`terminal|file_read|file_write|reasoning|web`), `command/path`, `outputSummary` (cap 30k), `durationMs`, `linesRead`, `status`.
- **CodexCheckpoint** — `runId`, `projectId`, `commitSha`, `title` (estilo commit), `createdAt`.
- **CodexRunMetric** — 1:1 con run: `timeWorkedMs`, `actionsCount`, `itemsReadLines`, `additions`, `deletions`, `tokensIn`, `tokensOut`, `costUsd`, `costSource` (`provider_exact|openrouter_generation|estimated`), `costOriginalUsd`, `costAppliedUsd`.

## 5. Protocolo SSE tipado y persistido

Sobre común: `{ runId, seq, ts, type, data }`.

| Evento | data |
|---|---|
| `run_status` | `{ status }` — transiciones del run |
| `plan_proposed` | `{ architecture, pages[], components[], tasks[] }` — estructura del plan |
| `reasoning_start` | `{ blockId, label }` |
| `reasoning_delta` | `{ blockId, text }` |
| `reasoning_end` | `{ blockId, durationMs }` → "… (47 seconds)" |
| `action_start` | `{ actionId, kind, command/path, groupId }` |
| `action_end` | `{ actionId, status, outputSummary, durationMs, linesRead? }` |
| `narrative_delta` | `{ text }` — narración 1ª persona, español |
| `checkpoint_created` | `{ checkpointId, commitSha, title, createdAt }` |
| `run_summary` | `{ metrics: CodexRunMetric }` |
| `action_required` | `{ patternId, rawError, blockedCapabilities[], remediationUrl, title }` |
| `heartbeat` | `{}` — keep-alive |

**Persistencia y replay:** el worker inserta cada evento en `codex_events` y lo publica por Redis pub/sub (canal `codex:run:<id>`). La ruta SSE replays desde DB (`afterSeq`) y luego engancha el canal vivo. Recarga y reconexión quedan resueltas por construcción (mismo patrón `blockIndex`/`seq` del agent-harness, ver `docs/sse-resumption.md`).

## 6. Workspace y git

- Provisioning (síncrono, rápido): directorio por proyecto en el volumen del runner → scaffold inicial determinista → `git init` + commit inicial → `previewUrl` asignada. El `bun install` + dev server arrancan **on-demand** (`POST /api/codex/projects/:id/preview/start`, mismo patrón de polling que el ▶ Ejecutar actual): el runner es single-tenant en el puerto dev, así que solo hay un dev server activo a la vez y "View preview" apunta siempre al proyecto activo.
- **Checkpoint** = commit git real con título descriptivo generado por el agente al cierre de cada build.
- **Rollback** = `git reset --hard <sha>` con confirmación explícita del usuario; si el lockfile cambió, reinstalación de dependencias y restart del dev server.
- **Changes** = `git diff` entre el checkpoint y su padre, renderizado con `diff-view.tsx`.
- **Diffstat** para métricas = `git diff --shortstat` respecto del checkpoint base de la corrida.
- Requisito de imagen: `git` disponible en el contenedor del runner (se añade si falta).

## 7. Loop del agente (worker)

1. **Plan primero, siempre**: la primera corrida de una conversación es `mode: plan` → `plan_proposed` → `waiting_approval`. El usuario aprueba (la UI hace `POST /api/codex/runs { mode: 'build', planRunId }`) o ajusta con texto libre (genera una nueva corrida `plan`). El toggle **Plan** fuerza terminar ahí.
2. **Build**: loop con presupuesto de pasos, reutilizando los clientes de proveedor existentes y `prompted-tool-calling` (cualquier modelo sirve). Texto streaming = `narrative_delta`; razonamiento (nativo o prompted) = `reasoning_*`; tool calls = `action_*` agrupadas por ráfaga (`groupId`) para los chips "N actions".
3. **Cierre**: checkpoint + métricas + `run_summary`. Errores del loop pasan por el clasificador de patrones (§8) antes de marcar `error`.

**Costos multi-proveedor** (`codex-usage-tracker`): `usage` de cada respuesta cuando el proveedor lo devuelve (con `include_usage`); si es OpenRouter, consulta a `/api/v1/generation` para el costo nativo; fallback `estimateCostUsd()`. `costSource` viaja a la tarjeta ("exacto" vs "estimado"); FlashGPT/Cerebras → $0. `costOriginalUsd` = tarifa de lista; `costAppliedUsd` = tras descuento de plan/promoción (precio tachado → precio final).

## 8. Errores accionables y diagnósticos benignos

Registro declarativo de patrones sobre logs y salidas de acciones:

- **Bloqueantes** → `action_required`: `402 Insufficient credits` (OpenRouter) con enlace de recarga, API key ausente/inválida, cuota agotada, fallo de provisioning. Payload: error crudo copiable + capacidades bloqueadas + remediación.
- **Benignos** → anotación informativa en el timeline: p.ej. `ECONNREFUSED :5050` durante el boot («el frontend arranca antes que el backend — comportamiento normal»), warnings de peer-deps, etc. Tabla extensible en código.

## 9. Frontend

**Fase A — Timeline (layout actual de `/code`):** componente `CodexRunTimeline` que consume el stream y renderiza por `seq`: narrativa, filas de chips agrupadas (evolución de `agent-trace.tsx`), bloques de razonamiento (patrón `thinking-trace.tsx`), píldora "Scroll to latest", tarjeta Checkpoint, tarjeta Worked-for, tarjeta Acción-requerida. Reducer puro de eventos → estado del timeline (testeable con vitest).

**Fase B — Composer + tabs:** réplica del composer (§2.2) y barra inferior (§2.3), mobile-first, gated por flag.

**i18n:** claves nuevas en español (`messages/es.json`) propagadas a los 59 locales con el patrón de `scripts/add-agent-locale-keys.js` (namespace `codex`).

## 10. Feature flag

- `CODEX_AGENT_V2=1` en el env del backend habilita rutas + worker.
- El frontend consulta `GET /api/codex/health` → `{ enabled }` (sin rebuild de Next para encender/apagar).
- Flag off: `/api/codex/*` → 404, worker no se registra, UI idéntica a hoy.

## 11. Testing

- **Unit backend** (node --test, offline/determinista): orden y serialización del protocolo, replay `afterSeq`, cálculo de métricas, resolución de costo por proveedor (fetch mockeado), detectores de patrones, git checkpoint/rollback en repo temporal, loop del worker con LLM falso.
- **Unit frontend** (vitest, `tests/lib/`): reducer del timeline por cada tipo de evento, agrupado de chips, render de las tres tarjetas.
- **Integración**: crear proyecto → describir contexto → plan propuesto → aprobar → build con streaming → checkpoint → rollback → preview, con LLM falso + git real en tmp + DB de test.
- Cada fase termina con `npm test`, `npm run lint`, `npx tsc --noEmit --skipLibCheck` y build en verde, commits convencionales y push (CI verde obligatorio).

## 12. Fases de entrega

| Fase | Entregable | Verificación |
|---|---|---|
| **F0** | Este documento (investigación + estándar) | Revisión del propietario |
| **F1** | Migración Prisma + flag + rutas esqueleto + provisioning (workspace + git + preview) | Tests de provisioning + CI |
| **F2** | Motor: cola BullMQ, loop server-side, protocolo SSE persistido con replay | Tests de protocolo/replay + CI |
| **F3** | Checkpoints/rollback/diff + métricas y costos + patrones de error | Tests de métricas/costo/git + CI |
| **F4** | UI Fase A: timeline + chips + razonamiento + scroll pill + 3 tarjetas + toggle Plan | Vitest reducer/cards + CI |
| **F5** | UI Fase B: composer réplica + tabs mobile-first + i18n 59 locales | Vitest + CI |
| **F6** | Integración E2E del flujo completo + hardening + doc final | Suite completa verde |

## 13. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Worker BullMQ en el mismo proceso backend compite por CPU | Concurrencia 1–2 por worker; jobs con timeout duro; medible vía bull-board |
| Runner sin `git` en la imagen | Verificación en F1; añadirlo al Dockerfile del runner si falta |
| Modelos sin tool-calling nativo | Escalera `prompted-tool-calling` existente (probada en chat) |
| Costo OpenRouter no disponible en local (key vacía) | `costSource` explícito + fallback estimado; tests con fetch mockeado |
| Rollback con dev server corriendo | Stop → reset → reinstall condicional → restart, como transacción secuencial |
| Runner single-tenant (un dev server, puerto 5173) | Workspaces multi-proyecto en subdirectorios, pero un solo preview activo por despliegue; multi-tenant de previews queda fuera del MVP |
| Crecimiento de `codex_events` | Índice `(runId, seq)`; retención/poda fuera de alcance del MVP (anotado) |

## 14. Fuera de alcance (MVP)

- Codegen real para mobile/desktop (sigue el pendiente del Builder).
- Retención/archivado de eventos antiguos.
- Colaboración multiusuario sobre el mismo workspace.
- Ejecución del proyecto generado fuera del runner actual (WebContainers, etc.).

## 14. Smoke de release (validación local con Docker)

Guion para validar la experiencia V2 end-to-end con un modelo real barato (FlashGPT/Cerebras):

1. **Levantar el runner**: `docker compose --profile opencode up -d runner` (volumen `opencode_workspace`, control API interna 4097, dev 5173).
2. **Config**: en `.env.local` → `CODEX_AGENT_V2=1`, `REDIS_URL=...`, `CEREBRAS_API_KEY=...`, `CODE_RUNNER_URL=http://runner:4097`. Arrancar backend (`logCodexConfig` debe loguear "config OK") y frontend.
3. **Crear proyecto**: en `/code` (con el flag on aparece el panel V2 ⚡ Codex) → "Nuevo". Verifica `status: ready`, `previewUrl` asignada y el commit inicial en el workspace.
4. **Plan**: escribe "haz una landing de zapatos" → corrida `plan` → tarjeta de plan en `waiting_approval`.
5. **Build**: "Aprobar y construir" → el timeline narra en 1ª persona (español), chips de acciones agrupadas, bloque de razonamiento con duración; al cierre tarjeta **Checkpoint made X ago** + **Worked for N minutes** con métricas reales.
6. **Checkpoint**: *Changes* abre el diff; *View preview* abre la URL viva; *Rollback here* (con confirmación) restaura el workspace.
7. **Recarga**: refresca la página a mitad de build → el timeline se reconstruye idéntico (replay desde `seq 0`) y sigue en vivo.
8. **Errores accionables**: con créditos OpenRouter agotados (o key inválida) la corrida termina con la tarjeta **Acción requerida de su parte 🔴** (error crudo copiable + remediación).
9. **Flag off**: `CODEX_AGENT_V2=0` → `/code` idéntico a hoy, `/api/codex/*` → 404 (salvo `/health`), worker no registrado.

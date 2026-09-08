# /chat → Cowork profesional — plan de programación

> Auditoría sobre `production-main` (2026-07-26). Objetivo: que
> https://siragpt.com/chat opere como un Claude Cowork avanzado — trabajo
> por carpetas, tareas largas autónomas y dirigibles, paralelismo visible,
> programación recurrente, conectores y aprobaciones — sobre la base que YA
> existe. Hermano de [../code/claude-code-parity.md](../code/claude-code-parity.md).

## 0 · Base verificada (no re-construir)

| Pieza | Estado |
|---|---|
| Loop agéntico con ~80 tools + AgentTrace SSE tipado | producción |
| Agent-harness: permisos tier confirm + MCP por usuario (UI en Settings) | producción |
| Cowork engine (auto-file bridge, deep analyzer, skills registry) inyectado en `/api/ai/generate` | producción |
| Active-memory dos niveles + UI de memoria | producción |
| **session-manager.js** (multi-sesión, spawn, forward, compact) | backend SÍ, **UI CERO** |
| Chats en paralelo + socket-detach + persist-on-abort | producción |
| Document pipeline profesional (docx/pptx/xlsx quirúrgico, temas) | producción |
| Primitivas cron (`system-cron.js`, skill `cron_schedule`, `cron-next-runs`) | existen, **sin modelo por-usuario** |
| Artifact store + previews (document/code) | producción, **sin versionado** |

Los gaps no son de motor: son **workspace, dirección de tareas largas,
scheduler por usuario, bandeja de aprobaciones y superficies de UI** para lo
que ya corre en backend.

## E1 · Workspace: la carpeta de trabajo como ciudadano de primera (XL)

El cambio de paradigma de Cowork: el agente trabaja EN una carpeta y los
entregables son ARCHIVOS, no burbujas de chat.

- **Modelo**: `CoworkWorkspace {id, userId, name, createdAt}` +
  `CoworkFile {id, workspaceId, path, contentHash, size, mime, updatedBy
  (user|agent), version}` + `CoworkFileVersion {fileId, version,
  contentHash, authorRunId, createdAt}`. Contenido en el artifact store
  (content-addressable, ya existe `task-tools.js saveArtifact` atómico).
- **Tools nuevas** en el registry del harness: `ws_read`, `ws_write`,
  `ws_edit` (contrato file-state: leer-antes-de-editar + detección de
  versión pisada), `ws_move`, `ws_glob`, `ws_grep` — todas scoped al
  workspace del chat, tier `auto`; `ws_delete` tier `confirm`.
- **Integración pipeline**: los generadores docx/pptx/xlsx escriben SU
  salida como `CoworkFile` versionado (hoy emiten artifact suelto).
  `document_edit` quirúrgico opera sobre archivos del workspace.
- **UI**: panel lateral árbol de archivos (crear/renombrar/descargar zip/
  arrastrar dentro), badge de versión, diff visual entre versiones
  (texto: CodeMirror merge; office: re-render preview de ambas).
- **Chat↔workspace**: cada chat puede montarse sobre un workspace
  (`chatId → workspaceId`); subir archivos al chat los materializa en la
  carpeta; el system prompt recibe el árbol (como `fileTree` en codex).
- **Tests**: contrato file-state (edit sin read → error instructivo),
  versionado inmutable, aislamiento entre usuarios, zip export.

## E2 · Tareas largas dirigibles: plan visible + steering (L)

- **Checklist persistente**: tool `update_checklist` (items con estado
  pending/in_progress/done/blocked) persistida en `agent_metadata` +
  evento SSE `checklist_update`; componente `TaskChecklist` encima del
  AgentTrace (colapsable, como el plan de Claude Code).
- **Steering mid-run**: hoy un mensaje del usuario aborta o espera. Añadir
  `POST /api/ai/steer {chatId, note}` → cola de notas que el loop drena
  entre pasos (el punto de inyección existe: el harness envuelve cada
  execute) y el modelo recibe `[NOTA DEL USUARIO A MITAD DE TAREA]`.
  Pausar/reanudar: flag en el estado del run que el loop respeta entre
  pasos.
- **Presupuestos por tarea**: `maxSteps/maxCostUsd` opcionales por mensaje
  (UI selector "tarea corta/larga/sin límite"), enforced en el loop.
- **Tests**: nota inyectada aparece en el transcript del paso siguiente;
  pausa detiene antes del siguiente tool; presupuesto corta con resumen.

## E3 · Paralelismo visible: tablero de sesiones (M)

El backend ya lo tiene (`session-manager.js`: spawn, forward, history,
compact) — falta TODO el frontend.

- **UI**: vista "Tareas" (tabla/kanban): cada chat-en-curso con estado
  (working/waiting_approval/done/error, coste, último paso), botones ver /
  dirigir (E2) / abortar. Fuente: los eventos SSE ya persistidos +
  `GET /api/cowork/sessions`.
- **Spawn desde el chat**: tool `spawn_task` (tier confirm) — el agente
  propone dividir trabajo en sub-sesiones paralelas; chip en UI para
  abrirlas. Límite de concurrencia por usuario/plan
  (`PLAN_BUDGETS`-aware, hoy no existe: `maxConcurrentAgentChats`).
- **Tests**: spawn hereda contexto, límite de concurrencia 402/429,
  forward entre sesiones.

## E4 · Scheduler por usuario: trabajo recurrente (L)

- **Modelo**: `ScheduledAgentTask {id, userId, workspaceId?, prompt,
  cronExpr, tz, enabled, lastRunAt, lastStatus, nextRunAt, deliver
  (chat|email|telegram), createdFrom}` (espejo de `ScheduledPost` que ya
  existe para social).
- **Worker**: job repetible en el patrón de `system-cron.js`: cada minuto
  toma vencidas (`nextRunAt <= now`, lock optimista), crea una sesión de
  agente headless (mismo camino que socket-detach) y entrega el resultado
  por el canal elegido. `cron-next-runs.js` ya calcula próximas
  ejecuciones para la UI.
- **Lenguaje natural**: la skill `cron_schedule` (ya existe) parsea "cada
  lunes a las 9" → cronExpr; el agente puede AUTO-registrar tareas con
  tool `schedule_task` (tier confirm SIEMPRE).
- **UI**: sección "Programadas" en Tareas (E3): próxima ejecución,
  historial, pausar/editar/borrar.
- **Guardarraíles**: máx N tareas por plan, presupuesto diario agregado,
  kill-switch global `SIRAGPT_SCHEDULER_DISABLED`.

## E5 · Bandeja de aprobaciones + notificaciones (M)

Hoy la tarjeta de permiso vive inline en el stream: si no estás mirando,
expira (TTL 2 min → deny). Cowork profesional = trabajo desatendido.

- **Approval inbox**: persistir `permission_request` pendientes
  (`AgentApproval {id, userId, chatId, tool, args, humanDescription,
  status, expiresAt}`); TTL largo (24 h) cuando el chat está detached; el
  run queda `waiting_approval` (estado ya soportado en codex — replicar en
  harness). UI: campana con pendientes, aprobar/denegar desde fuera del
  chat.
- **Notificaciones**: servicio unificado `notify.js` (email vía SMTP ya
  configurado + Telegram bridge YA desplegado + Web Push nuevo) con
  eventos: tarea terminada, bloqueada en aprobación, error, programada
  ejecutada. Preferencias por usuario en Settings.
- **Tests**: aprobación fuera de línea reanuda el run; expiración limpia;
  dedupe de notificaciones.

## E6 · Conectores de un clic (L)

`McpServersCard` es para técnicos (URL + headers). Cowork = catálogo.

- **Catálogo**: registro declarativo `connector-catalog.js` (nombre, logo,
  scopes, tipo auth) sobre la infra MCP existente; los OAuth flows de
  Google/GitHub/Spotify YA existen en `routes/auth.js` — generalizar a
  `connector_accounts` (tokens cifrados con `utils/encryption`, patrón
  token-vault de social-company).
- **Primeros conectores**: Gmail (leer/redactar-borrador), Google Drive
  (importar/exportar al workspace E1), Notion, Slack (los dos últimos vía
  MCP remoto). Cada acción de escritura = tier `confirm` → cae en E5.
- **Salud**: ping por conector, badge conectado/roto, re-auth guiada.

## E7 · Memoria de proyecto + browser visible (M)

- **Memoria por workspace**: namespacing de active-memory
  (`scope: user|workspace`); el prompt del chat montado sobre workspace
  recall prioriza su scope. UI de memoria filtra por proyecto.
- **Browser del agente visible**: el research-agent ya conduce Playwright
  headless — exponerlo como tool general `browse_page` con screenshots
  como eventos SSE (`page_snapshot`) renderizados en AgentTrace, denylist
  SSRF del harness reutilizada. Acciones de escritura en páginas = confirm.

## E8 · Calidad, coste y auditoría (M)

- **Coste agregado**: rollup por chat/workspace/día (los datos por-run ya
  existen: `costUsdEstimate` en agent_done) + límites por plan con
  degradación elegante (aviso → FlashGPT fallback ya existente).
- **Audit log**: toda acción externa (conector, publicación, schedule)
  → `AgentAuditLog` append-only consultable en Settings.
- **Evals de regresión**: extender el harness E2E de memoria
  (`project_live_chat_e2e`) con escenarios cowork: workspace CRUD,
  steering, aprobación offline, tarea programada.

## Orden de construcción

```
E2 (steering+checklist)  →  E5 (aprobaciones+notify)  →  E3 (tablero)
        ↓ en paralelo
E1 (workspace)  →  E7 (memoria por proyecto)  →  E6 (conectores)
        ↓ después
E4 (scheduler)  →  E8 (coste+audit)
```

E2+E5 primero: convierten lo que YA corre en background en trabajo
*dirigible y desatendido* — el salto de chat a cowork se percibe ahí.
E1 es el más grande y va en paralelo porque no toca el loop.
E4 al final: programar tareas solo es seguro con E5 (aprobaciones) y E8
(presupuestos) debajo.

## Regla transversal

Toda pieza nueva: servicio puro inyectable + tests offline registrados en
`backend/package.json` (el sharder ya descubre por disco), rutas con
express-validator + rate-limit, secretos SOLO vía `utils/encryption`,
CI verde antes de push, y NADA de tocar la UI existente fuera de las
superficies nuevas listadas (regla #1 del repo aplica al resto).

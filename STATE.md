# STATE — Estado del programa Frontier Agent

- **Última actualización:** 2026-08-13
- **Owner:** SiraGPT / Luis Carrera
- **Repo:** `infosiragpt-ops/SiraGPT-APP`

---

## Fase activa

**F3 — SSE traces + cancel end-to-end.**
Estado: **COMPLETED (pendiente de merge/deploy)** — trazas SSE uniformes por
paso del AgentRunner (`type: 'stage'`, labels en español + tool) y cancelación
end-to-end (Stop → AbortSignal → loop + sandbox + job BullMQ). Tests verdes:
`tests/agent-runner-f3-traces.test.js` (14) + las suites F1/F2 existentes
(agent-runner / routing / f2-routing / e2e / agentic-chat-stream / doc-agent /
sandbox — 146 tests, todos verdes en local). Falta el merge del PR y la
verificación de CI/producción por Luis.

F2 (routing completo): **COMPLETED** — mergeado a `production-main` en el
PR #281 (junto con el hardening F1 del PR #279) y hotpatcheado en siragpt.com
el 2026-08-13. Telemetría `[doc-routing]` activa en las 4 entradas.

F1 (core agéntico): **COMPLETED** — el hardening del 2026-08-13 (PR #279)
cerró el fallback silencioso al pipeline genérico en chat y `/api/doc/generate`
con errores honestos (`agent_runner_failed` / `no_llm` / `llm_402`). Mergeado.

F0 (docs): **COMPLETED** — ROADMAP aprobado por Luis el 2026-08-13.

## Completado (honesto)

- **F0**: `ROADMAP.md` + `STATE.md` en la raíz, aprobados.
- **AgentRunner v0** en `backend/src/services/agent-runner/`: loop LLM→tool→result→LLM
  (tope 25, nativo + ReAct), tools (`execute_python/bash`, `read/write_file`,
  `list_files`, `render_preview`, `create_presentation`, `set_slide_background`),
  artefactos (`GeneratedArtifact`, follow-ups sobre la ÚLTIMA versión), cola BullMQ
  opcional, gate de verificación (`verify.js`, ≤3 reintentos).
- **Routing v0**: `shouldRunAgentRunner` (archivos, artefactos previos, crear-doc,
  follow-ups de estilo); preloop del runner en `agentic-chat-stream.js`.
- **`/api/doc/generate` runner-first**: intenta AgentRunner y cae al
  `advanced-document-pipeline` solo si el runner no entrega archivo.
- **Color PPT desde el pedido del usuario**: el hex/nombre pedido gana al tema
  oscuro hardcodeado (parche de seguridad en `pptx-design-system.js`).
- **`office_helpers.py` carga lazy/fail-open**: un ENOENT ya no tumba el require del
  módulo (antes eso desviaba `/doc/generate` al pipeline oscuro en silencio).
- **Crear-PPT ya NO tiene fast-path stub**: los decks nuevos pasan por el loop LLM
  para que el contenido sea del tema pedido; el fast-path determinista queda solo
  para PINTAR un pptx existente.
- **F1 hardening (este PR): sin fallback al pipeline genérico cuando el runner
  reclama el turno.**
  - `/api/doc/generate`: si `shouldRunAgentRunner` es true y el runner no entrega
    archivo, la ruta NO llama a `tryGenerateSourcePreservingDocumentEdit` ni a
    `streamAdvancedDocumentPipeline` — persiste y devuelve un error honesto en
    español con la razón (`no_llm`, `llm_402`, `no_output`, excepción). El
    pipeline queda SOLO para pedidos que el runner no reclama.
  - Chat (`agentic-chat-stream`): los turnos de documento runner-only (crear-doc
    y follow-ups de estilo/color) terminan en error honesto
    (`agent_runner_failed`) en vez de caer al loop LLM / pipeline genérico. Los
    turnos de EDICIÓN con archivos conservan el camino quirúrgico
    `document_edit` (nunca toca el pipeline genérico).
  - Créditos: 402 de OpenRouter / "credit balance is too low" de Anthropic
    detienen el loop de inmediato (`llm_402`, sin reintentos) y la razón viaja
    hasta las rutas. `max_tokens` del loop bajó de la reserva implícita de 8192
    a 3072 (env `SIRAGPT_AGENT_RUNNER_MAX_TOKENS`, clamp 256–8192) para que un
    saldo bajo aún complete un loop corto.
  - Tests: `tests/agent-runner-routing.test.js` (402/no_llm/no_output → nunca
    pipeline) + casos nuevos en `agentic-chat-stream.test.js`.
- **F2 — routing completo (este PR).** Auditoría de TODAS las entradas que
  pueden crear/editar pptx/docx/xlsx y cierre del último gap:
  - **`/api/agent/task` (agent-task-runner) es ahora runner-first.** El
    classifier de intención del chat UI enruta los turnos 'ppt'/documento a
    esta entrada, que hasta ahora creaba documentos vía `create_document` o
    `generateAutoDocument` (advanced pipeline) SIN consultar al AgentRunner.
    Preloop nuevo: turno reclamado → archivo verificado del runner o (turnos
    crear-doc / estilo-color) error honesto `agent_runner_failed`. Los turnos
    de EDICIÓN reclamados conservan el rescate quirúrgico source-preserving,
    pero `create_document` y el auto-document pipeline quedan prohibidos por
    el resto del run (la prohibición sobrevive al rebuild post-loop de
    `documentPolicy`). Los fast-paths deterministas que responden desde los
    archivos REALES del usuario (transcripción plana, matriz Vancouver,
    respuestas de adjuntos chat-only) conservan prioridad — nunca tocan la
    plantilla genérica.
  - **Chat**: un turno reclamado que falla y continúa como edición quirúrgica
    ya no puede alcanzar `create_document` en el loop.
  - **Telemetría F2** (`agent-runner/telemetry.js` → `logDocumentRouting`):
    cada entrada (chat, `/api/doc/generate`, gate de `/api/ai/generate`,
    `/api/agent/task`) emite una línea estructurada `[doc-routing]` + counter
    `document_turn_path_total` con el camino que respondió:
    `agent_runner | agent_runner_failed | source_preserving_edit |
    advanced_pipeline | skipped`.
  - Tests: `tests/agent-runner-f2-routing.test.js` (10) — frases crear-ppt y
    follow-ups de estilo SIEMPRE reclaman el runner; fallo reclamado NUNCA
    invoca el pipeline genérico ni `create_document`; "hola" no entra al
    runner; preloop de agent-task e2e con runner stub. El preloop es opt-in
    bajo `NODE_ENV=test` (`AGENT_TASK_AGENT_RUNNER=1`), igual que las demás
    features del runner que tocan red.

- **F3 — SSE traces + cancel end-to-end (este PR).**
  - **Trazas uniformes** (`agent-runner/trace.js` → `toStageEvent`): TODO
    evento del runner (tool_call / tool_result / retry / thought /
    iteration_start / sandbox_ready / final / cancelled / error) se normaliza
    a UN solo shape SSE `{ type: 'stage', step, label, tool, iteration?,
    attempt?, ok?, preview? }` con labels en español ("Pensando", "Ejecutando
    código", "Verificando resultado", "Reintentando", "Listo", "Cancelado") +
    nombre de tool. El contrato `type: 'stage'` que la UI ya consume no
    cambia — solo se rellenan los huecos (antes `error` y los eventos sin
    label se perdían). Consumidores: chat (`agentic-chat-stream.js`),
    `/api/doc/generate` (`runAgentRunnerForDocRoute` → `onStage` reenvía
    label + tool + step), worker BullMQ (pub/sub → mismo mapeo en el chat).
  - **Cancel end-to-end**: Stop (`POST /api/ai/stop-stream` →
    `controller.abort()`) aborta (1) el loop in-process — `bail()` en
    `loop.js` emite UN evento `cancelled` ("Cancelado") y corta antes de la
    siguiente llamada LLM/tool; (2) el comando sandbox EN VUELO — el loop pasa
    `{ signal }` a cada executor y `execute_python/bash/render_preview/glob/
    grep` lo reenvían a `sandbox.exec` (kill de process-group en local; en
    docker el driver reenvía `opts.signal` — fix — y `destroy()` hace
    `docker rm -f`, así que nunca queda proceso vivo); (3) el job BullMQ si
    `AGENT_RUNNER_ASYNC=1` — canal Redis `agent-runner:cancel:<jobId>`
    (`requestAgentRunnerJobCancel`), el worker mantiene un AbortController
    por job, publica `job_cancelled` (nunca `job_done`: sin éxito declarado
    para un turno parcial) y `waitForAgentRunnerJob` propaga el cancel al
    abortar además de tratar `job_cancelled` como AbortError. El path async
    abortado ya NO cae al camino in-process (antes reiniciaba el turno).
  - **Reanudación de stream**: sin cambios de contrato — el chat sigue
    montado sobre el stream-resume de `/api/ai/generate` (Last-Event-ID +
    `activeResumeStreams`); las trazas `stage` son efímeras por diseño y el
    contenido se reanuda como hasta ahora.
  - **Tests** (`tests/agent-runner-f3-traces.test.js`, 14): (a) loop mockeado
    emite stages en orden con labels/tool; (b) abort a mitad de loop no hace
    más llamadas LLM/tool y traza "Cancelado" una sola vez; (c) el sandbox
    respeta señal Y timeout, y una cancelación de `runAgentRunner` a mitad de
    comando no deja ningún proceso vivo (verificado contra `ps`); (d) cancel
    BullMQ: publish → worker aborta → `job_cancelled`, y el wait aborta +
    propaga. Suites F1/F2 existentes verdes sin cambios.

## En progreso

- Nada fuera de F3. F4+ NO se inicia (planner, gVisor, Playwright, memoria,
  LoRA, SSO, MinIO quedan secuenciados en `ROADMAP.md`).

## Pendiente

- **F4 en adelante**, según `ROADMAP.md`: orquestador → sandbox hardening →
  search/browser → multimodal → memoria/skills/MCP → evals/optimizer →
  flywheel (router aprendido + LoRA/vLLM) → enterprise
  (SSO/SCIM/Stripe/marketplace) → plataforma y superficies (MinIO/OTel/canary,
  voz/cron/email/CLI/PWA, i18n, migración Prisma→Drizzle).

## Cómo retoma una sesión futura

1. Leer `STATE.md` (este archivo) para saber la fase activa y su estado.
2. Leer `ROADMAP.md` para el alcance y el gate de la fase activa.
3. Implementar SOLO la fase activa. No adelantar fases. No reabrir la base obligatoria.
4. Al cerrar: tests + evals verdes, commit propio, actualizar `STATE.md`
   (fase cerrada → siguiente fase activa) en el mismo PR.

## Notas operativas

- ORM actual: **Prisma** (Drizzle = fase posterior, no está hecho).
- Deploy: Luis pushea desde su Mac; el VPS no puede `git push`. Los agentes abren PRs.
- `AGENT_RUNNER_ASYNC` off por defecto (SSE in-process); BullMQ opcional via env.

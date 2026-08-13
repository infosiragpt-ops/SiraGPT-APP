# STATE — Estado del programa Frontier Agent

- **Última actualización:** 2026-08-13
- **Owner:** SiraGPT / Luis Carrera
- **Repo:** `infosiragpt-ops/SiraGPT-APP`

---

## Fase activa

**F1 — Core agéntico (AgentRunner: loop + tools + artefactos + verificación).**
Estado: **DEPLOYED_AWAITING_GATES** — el runner está desplegado pero los gates de
F1 aún no cierran: la evidencia de producción del 2026-08-13 ("crea una ppt del
embarazo de color celeste/rosado" seguía contestando la plantilla genérica de
8 diapositivas) mostró que el routing caía en silencio al
`advanced-document-pipeline` cuando el runner fallaba (OpenRouter 402 /
Anthropic sin créditos / sin LLM). F1 NO está completa.

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

## En progreso

- Nada fuera de F1. Este PR es un **hardening de F1** (routing runner-first sin
  fallback al pipeline genérico + errores honestos de créditos). F1 sigue
  DEPLOYED_AWAITING_GATES; NO se marca completa y NO se inicia F2 (retiro del
  classifier en todos los entry points + dashboard de telemetría quedan para F2).

## Pendiente

- **F2 en adelante**, según `ROADMAP.md`: routing completo → SSE traces + cancel →
  orquestador → sandbox hardening → search/browser → multimodal → memoria/skills/MCP
  → evals/optimizer → flywheel (router aprendido + LoRA/vLLM) → enterprise
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

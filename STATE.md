# STATE — Estado del programa Frontier Agent

- **Última actualización:** 2026-08-13
- **Owner:** SiraGPT / Luis Carrera
- **Repo:** `infosiragpt-ops/SiraGPT-APP`

---

## Fase activa

**F1 — Core agéntico (AgentRunner: loop + tools + artefactos + verificación).**
Estado: **IN_PROGRESS** — implementación en este PR; cierra cuando los gates de F1
(unit + e2e verdes) pasen en revisión y el PR se mergee.

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

## En progreso

- Nada fuera de F1. (F1 = este PR: tools nuevas `edit_file`/`glob`/`grep`,
  `create_presentation` con outline + cualquier color sin default rosado, prompt de
  calidad de contenido, tests e2e de frases reales.)

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

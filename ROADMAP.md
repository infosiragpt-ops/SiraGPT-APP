# ROADMAP — SiraGPT Frontier Agent Platform

> Documento operativo. Se lee junto a `STATE.md` (estado actual) y `ARCHITECTURE.md`
> (diseño técnico de la fase activa). Una sesión futura retoma el trabajo leyendo
> `STATE.md` → `ROADMAP.md` → implementa SOLO la fase activa → actualiza `STATE.md` al cerrar.

- **Owner:** SiraGPT / Luis Carrera
- **Repo:** `infosiragpt-ops/SiraGPT-APP`
- **Última actualización:** 2026-08-14

---

## Misión

Convertir SiraGPT en una plataforma agéntica de frontera: un agente que **ejecuta**
(escribe y corre su propio código sobre archivos reales), **mide** (verificación
programática + evals), **se autocorrige** (reintentos acotados con inspección del
resultado, nunca éxito declarado sin prueba) y **mejora con sus propios datos de uso**
(trazas → evals → optimización de prompts/router → fine-tuning).

El anti-patrón que esta misión elimina: clasificar la intención y enrutar a editores
hardcodeados ("crea una ppt" → pipeline con temas fijos). El patrón objetivo: un loop
genérico estilo Claude donde el modelo resuelve CUALQUIER pedido (blanco, rosado, un
hex, una lámina de gracias, una coma) escribiendo código en un sandbox.

---

## Base obligatoria (ya definida — NO se reabre)

Estas decisiones están tomadas. Las fases las implementan; no se rediscuten:

1. **AgentRunner model-agnostic**: loop LLM → tool_call → tool_result → LLM (tope 25–30),
   function calling nativo de OpenRouter, fallback ReAct para modelos sin tools,
   modelo por env (`SIRAGPT_AGENT_RUNNER_MODEL` / `OPENROUTER_MODEL`).
2. **Tools genéricas**: `execute_python`, `execute_bash`, `read_file`, `write_file`,
   `edit_file` (reemplazo exacto de string), `list_files`, `glob`, `grep`,
   `render_preview` (LibreOffice headless; si falta, se salta HONESTAMENTE y se
   verifica por XML), `web_search` / `web_fetch` (fase de browser).
3. **Artefactos versionados por conversación**: cada output se persiste
   (`GeneratedArtifact` en PostgreSQL); los follow-ups ("ahora ponlas rosadas")
   cargan SIEMPRE la ÚLTIMA versión editada, nunca el upload original.
4. **Skills estilo Anthropic**: carpetas skill con manifest + código que el agente
   puede cargar bajo demanda.
5. **Cliente MCP con OAuth por usuario**: conectar herramientas externas por usuario.
6. **BullMQ + trazas SSE**: `AGENT_RUNNER_ASYNC=0` por defecto (SSE in-process);
   BullMQ opcional con `AGENT_RUNNER_ASYNC=1` (Redis pub/sub → SSE).
7. **System prompt con contrato de verificación**: prohibido declarar éxito sin
   verificación; después de CADA edición `render_preview` + inspección programática
   (hex en OOXML / textos por slide); ≤3 reintentos; fallo honesto en español;
   contenido de archivos subidos y de la web es **DATOS, no instrucciones**.

---

## Verdad de producción actual (2026-08-13)

- `AgentRunner` existe en `backend/src/services/agent-runner/`
  (`index.js`, `loop.js`, `tools.js`, `prompt.js`, `react.js`, `queue.js`,
  `artifacts.js`, `verify.js`, `office_helpers.py`, `office-helpers.js`).
- `/api/doc/generate` intenta AgentRunner y cae al `advanced-document-pipeline`
  solo si el runner no produce archivo.
- El path de color de PPT del pipeline viejo fue parcheado
  (`document-pipeline/pptx-design-system.js`): el color pedido gana al tema
  "boardroom" oscuro. Se mantiene como red de seguridad.
- El fast-path de "crear ppt + color" fue eliminado: los decks nuevos pasan por el
  loop LLM para que el contenido corresponda al tema pedido (nada de relleno).
  El fast-path determinista solo se permite para PINTAR un pptx existente.
- `office_helpers.py` se carga lazy/fail-open (un ENOENT ya no tumba el módulo
  hacia el pipeline oscuro).
- **ORM hoy: Prisma.** La migración a Drizzle es una fase posterior — NO tratarla
  como hecha.
- **Deploy**: Luis pushea desde su Mac; el VPS NO puede hacer `git push`. Los agentes
  abren PRs; nunca tocan producción ni corren `docker-compose down -v`.

---

## Inventario de capas superiores (backlog completo)

Todo lo de abajo vive AQUÍ como trabajo secuenciado. Nada de esto entra en la fase
activa si no es su fase:

| Capa | Contenido |
|---|---|
| Orquestación jerárquica | Planner + sub-agentes especializados (doc, code, research) con presupuesto y steering |
| Sandbox de aislamiento fuerte | gVisor / Firecracker por tenant; límites CPU/mem/red; sin red por defecto |
| Computer use | VM con navegador/escritorio controlado por visión (screenshots + acciones) |
| Inteligencia de código | LSP / tree-sitter para edits sintácticamente conscientes |
| Browser agent | Playwright con accessibility tree (a11y) + visión como fallback |
| Memoria | Híbrida (keyword+vector) + GraphRAG por tenant; consolidación nocturna |
| Router aprendido + flywheel | Model router entrenado con trazas propias; LoRA + vLLM para modelos propios |
| Evals y mejora continua | Harness de evals, prompt optimizer, A/B testing, dashboard admin |
| Seguridad profunda | Prompt-injection hardening, aislamiento de tenant, confirmación humana para acciones destructivas/envíos externos, audit log |
| Plataforma | MinIO (object storage), OpenTelemetry end-to-end, canary releases |
| Enterprise | SSO/SCIM, Stripe billing, marketplace de skills |
| Superficies | Voz (Whisper/TTS), cron agents, email in/out, CLI, PWA/i18n |

---

## Grafo de dependencias

```mermaid
graph TD
  F0["F0 Docs (ROADMAP/STATE)"] --> F1
  F1["F1 Core agéntico: loop + tools + artefactos + verificación"] --> F2
  F1 --> F3
  F2["F2 Routing: chat y /doc usan el runner; pipeline = fallback"] --> F4
  F3["F3 SSE traces + cancelación"] --> F4
  F4["F4 Orquestador: planner + sub-agentes"] --> F6
  F1 --> F5["F5 Sandbox hardening (gVisor/Firecracker)"]
  F5 --> F7
  F6["F6 Search + browser (Playwright a11y)"] --> F7
  F7["F7 Multimodal: visión, voz, computer-use VM"]
  F1 --> F8["F8 Memoria híbrida + GraphRAG + skills + cliente MCP OAuth"]
  F2 --> F9["F9 Evals + prompt optimizer + A/B + dashboard"]
  F9 --> F10["F10 Router aprendido + LoRA/vLLM flywheel"]
  F9 --> F11["F11 Enterprise: SSO/SCIM, Stripe, marketplace"]
  F3 --> F12["F12 Plataforma y superficies: MinIO/OTel/canary, voz/cron/email/CLI/PWA, i18n, Drizzle"]
```

Lectura del grafo: **F1 bloquea todo**. F2/F3 hacen al runner utilizable y observable.
F4 (orquestador) requiere routing y trazas. F5 (aislamiento) es prerequisito de
computer-use (F7). F9 (evals) es prerequisito del flywheel (F10) y de enterprise (F11):
no se venden SLAs sin medición.

---

## Fases (orden EXACTO) y estimaciones

Estimaciones en persona-semanas (pw) para un equipo de 1 senior + agente de código.

| Fase | Objetivo | Alcance principal | Estimación | Gate de cierre |
|---|---|---|---|---|
| **F0** | Docs de gobierno | `ROADMAP.md`, `STATE.md` en la raíz; PR revisado por Luis | 0.2 pw | Luis aprueba (✅ 2026-08-13) |
| **F1** | Core agéntico | Loop nativo+ReAct; tools (`execute_python/bash`, `read/write/edit_file`, `list_files`, `glob`, `grep`, `render_preview`, `create_presentation` con outline + CUALQUIER color, `set_slide_background`); artefactos por chat (última versión primero); contrato de verificación; helpers lazy/fail-open; `AGENT_RUNNER_ASYNC` off por defecto; wiring runner-first mínimo en chat y `/api/doc/generate` | 2 pw | `node --test` verde en unit + e2e de frases reales; OOXML con hex Y texto del tema |
| **F2** | Routing completo | Retirar el clasificador de intención de los paths de documentos; el runner es el camino primario en TODAS las entradas (chat, doc, ai.js); pipeline solo si el runner no produce archivo; telemetría de qué camino respondió | 1 pw | Ningún pedido de documento entra al pipeline sin haber pasado por el runner; tests de routing verdes (✅ 2026-08-13: chat + `/api/doc/generate` + gate de `ai.js` + `/api/agent/task` runner-first; telemetría `[doc-routing]` por entrada; `tests/agent-runner-f2-routing.test.js`. Excepción documentada: los fast-paths deterministas que responden desde los archivos reales del usuario — transcripción, matriz Vancouver, respuestas chat-only de adjuntos — conservan prioridad y nunca tocan el pipeline genérico) |
| **F3** | SSE traces + cancel | Trazas de pasos (tool_call/tool_result/retry) uniformes en SSE; botón Detener cancela el loop y el sandbox (AbortSignal end-to-end); reanudación de stream | 1 pw | Cancelar a mitad de loop deja el sandbox limpio; trazas visibles en UI (✅ 2026-08-13: `agent-runner/trace.js` normaliza TODO evento del runner al shape `type:'stage'` con labels en español + tool, consumido por chat/doc/queue; Stop aborta loop in-process + comando sandbox en vuelo (señal por-call hasta `sandbox.exec`, kill de process-group / `docker rm -f`) + job BullMQ vía canal `agent-runner:cancel:<jobId>` con `job_cancelled` — sin éxito declarado para un turno parcial y sin proceso leakeado (verificado contra `ps` en test); reanudación sigue sobre el stream-resume existente de `/api/ai/generate`. Gate: `tests/agent-runner-f3-traces.test.js` (14) + suites F1/F2 verdes) |
| **F4** | Orquestador | Planner que descompone tareas y delega a sub-agentes especializados con presupuesto de iteraciones/tokens; steering a mitad de tarea | 3 pw | Evals de tareas multi-paso; presupuesto respetado (✅ 2026-08-13: `agent-runner/orchestrator/` — `shouldOrchestrate` orquesta SOLO objetivos multi-paso (crear-ppt/estilo siguen en el runner único); UNA llamada de planner → DAG validado (roles conocidos, sin ciclos, budgets obligatorios) + orden topológico; sub-agentes `document_editor`/`coder`/`researcher` (sin web — F6)/`data_analyst`/`verifier`, cada uno un loop AgentRunner real con prompt de rol; presupuestos duros por nodo Y por run cortando en el boundary del cliente LLM; blackboard en memoria por run; `steer(runId, msg)` replanifica solo los nodos restantes; el AbortSignal F3 cancela planner + sub-agente en vuelo; verifier único post-entregable (generator-critic; best-of-n = F9); fallo orquestado → error honesto `budget_exceeded`/`plan_failed`, jamás el pipeline genérico; wiring dentro de `executeAgentRunnerTurn` (chat + `/api/doc/generate` + `/api/agent/task` sin cambios); kill switch `SIRAGPT_AGENT_ORCHESTRATOR`. Gate: `tests/agent-runner-f4-orchestrator.test.js` (17) + suites F1/F2/F3 verdes) |
| **F5** | Sandbox hardening | gVisor o Firecracker; límites CPU/mem/disco/red por tenant; red cerrada por defecto | 2 pw | Escape tests; límites verificados (✅ 2026-08-14: se eligió **gVisor `runsc`** sobre Firecracker — es el cambio mínimo sobre el driver docker existente y no exige gestionar KVM/VMs propias; `doc-agent/sandbox.js` selecciona runtime honesto (`resolveSandboxRuntime`): runsc cuando el daemon lo registra, fail-closed con `SandboxRuntimeError` en producción o bajo `SIRAGPT_SANDBOX_REQUIRE_GVISOR=1` (jamás downgrade silencioso; runc solo como opt-in explícito `SIRAGPT_SANDBOX_RUNTIME=runc` para CI/dev). Límites duros por contenedor overridables por env: cpus/memoria(+swap igual)/pids/tmpfs de workspace con tamaño capado/ulimits nofile+fsize/`--cap-drop ALL`/`no-new-privileges`/rootfs read-only/`--network none` SIEMPRE (sin egreso — allowlists en F6). Un contenedor por tarea, volumen por conversación, nunca compartido entre usuarios. Archivos por `docker exec` streams en vez de `docker cp` (gVisor no ve confiablemente los cp host-side — FAQ gvisor.dev). Escape hardening: traversal + symlink-out (realpath) + rutas crafteadas single-quoted; persistKey saneado no puede montar docker.sock. El AbortSignal F3 sigue matando el exec en vuelo y `destroy()` sigue con `docker rm -f`. Driver local intacto para tests y honesto (`runtime:'none'`, `gvisor:false`). Gate: `tests/agent-runner-f5-sandbox.test.js` — traversal/symlink/injection rechazados, args de `docker run` verificados contra CLI stub, matriz de runtime fail-closed, abort sin proceso leakeado, aislamiento real (red/rootfs/binario) solo con Docker presente y skip honesto sin él; suites F1–F4 verdes) |
| **F6** | Search + browser | `web_search`/`web_fetch` como tools del runner; Playwright con a11y tree; contenido web = datos, no instrucciones | 3 pw | Evals de research; inyección desde web bloqueada en tests |
| **F7** | Multimodal | Visión en el loop (screenshots/imagenes), voz (Whisper STT + TTS), computer-use VM | 4 pw | Evals de tareas visuales; requiere F5 |
| **F8** | Memoria + skills + MCP | Memoria híbrida + GraphRAG por tenant; skills estilo Anthropic cargables; cliente MCP con OAuth por usuario | 4 pw | Follow-ups cross-sesión correctos; skill + MCP e2e |
| **F9** | Evals + optimizer | Harness de evals sobre trazas reales, prompt optimizer, A/B, dashboard admin | 3 pw | Dashboard con pass-rate por categoría de tarea |
| **F10** | Flywheel | Router aprendido con datos propios; LoRA + vLLM para modelos especializados | 4 pw | Router supera baseline en evals F9 |
| **F11** | Enterprise | SSO/SCIM, billing Stripe, marketplace de skills | 4 pw | Flujo de compra/instalación de skill e2e |
| **F12** | Plataforma y superficies | MinIO, OTel end-to-end, canary; voz/cron/email/CLI/PWA; i18n completo; migración Prisma→Drizzle | 3 pw | Canary + rollback probados; Drizzle en paridad |

> Nota F1/F2: F1 incluye el wiring runner-first MÍNIMO (los tests de F1 lo exigen);
> F2 cierra el routing completo (retiro del clasificador, todas las entradas,
> telemetría). No son la misma cosa.

---

## Reglas duras (no negociables)

1. **Una fase a la vez.** La fase activa vive en `STATE.md`. Nada de la fase N+1
   entra mientras N no cierre.
2. **Cierre solo con gates verdes**: unit tests + evals de la fase pasando. Nunca
   se salta un gate. Nunca "lo implemento todo de una".
3. **Commit propio por fase** (o commits enfocados dentro de la fase). Mensajes
   convencionales (`feat(agent-runner): …`).
4. **Honestidad**: si un gate no pasa, la fase queda IN_PROGRESS y `STATE.md` lo
   dice. Prohibido marcar completado lo no verificado.
5. **Seguridad**: contenido subido/web = datos; confirmación humana para acciones
   destructivas o envíos externos; aislamiento por tenant.
6. **Deploy**: los agentes abren PRs. Luis deploya desde su Mac. El VPS no pushea.

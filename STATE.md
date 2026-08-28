# STATE — Estado del programa Frontier Agent

- **Última actualización:** 2026-08-28
- **Owner:** SiraGPT / Luis Carrera
- **Repo:** `infosiragpt-ops/SiraGPT-APP`

---

## Fase activa

**F7 — SiraComputer (multimodal + desktop VM).**
Estado: **IN_PROGRESS**. Spec: `F7_SIRACOMPUTER_MASTER_SPEC.md`.
Sub-fase activa: **F7.0** (DesktopProvider + imagen `sira-desktop` + DCP).

**F7.0:** **IN_PROGRESS** — contratos de interfaz / Dockerfile / `start.sh` /
DCP unit-testeados. El gate de provision (§22.1: `docker build` + contenedor +
`GET :9000/health` + screenshot) se **omite honestamente** en el entorno del
agente (no hay daemon Docker). CI de GitHub Actions (ubuntu-latest) SÍ tiene
Docker y debe correr el gate de verdad. No se marca COMPLETED hasta que ese
gate pase. **No se inicia F7.1.**

El orquestador live de #484 (`services/computer-orchestrator`) se conserva.
F7.0 AÑADE `backend/src/services/desktop/provider/` + `infra/desktop/`.
No se toca Caddy live, DNS, ni `computer.siragpt.com`.

---

## Fase anterior (cerrada)

**F5 — Sandbox hardening (gVisor, fail-closed, límites duros).**
Estado: **COMPLETED** — el driver
docker del sandbox del doc-agent (`backend/src/services/doc-agent/sandbox.js`)
sube de un contenedor Docker plano a aislamiento de producción: runtime
gVisor (`--runtime runsc`) cuando el daemon lo tiene registrado, con
selección HONESTA y fail-closed (`resolveSandboxRuntime`): en producción
(`NODE_ENV=production`) o con `SIRAGPT_SANDBOX_REQUIRE_GVISOR=1`, un runsc
ausente lanza `SandboxRuntimeError` en español ANTES de crear contenedor
alguno — jamás degrada en silencio a runc ni al driver local; runc queda
solo como opt-in explícito `SIRAGPT_SANDBOX_RUNTIME=runc` (CI/dev). Límites
duros por sandbox, todos overridables por env: CPU, memoria (+memory-swap
igual: sin swap), pids, tmpfs de /workspace con tamaño capado (efímero),
ulimits (nofile, fsize), `--cap-drop ALL`, `no-new-privileges`, rootfs
read-only (tmpfs /tmp, HOME=/workspace) y `--network none` SIEMPRE (sin
opt-in de egreso — los allowlists llegan con F6). Un contenedor por tarea,
nunca compartido entre usuarios. Se eliminó `docker cp` del camino de
archivos (gVisor cachea directorios y no ve escrituras host-side de docker
cp — FAQ de gvisor.dev): putFile/readFile van por streams de `docker exec`
(`cat >` / `cat` binario), la misma estrategia de `kubectl cp`. Escapes:
`resolveInWorkspace` sigue rechazando `..`/absolutos y el driver local
ahora también rechaza symlinks que apuntan fuera (check de realpath);
rutas crafteadas quedan single-quoted (nada de inyección vía nombres de
archivo). El AbortSignal de F3 sigue matando el `docker exec` en vuelo y
`destroy()` sigue haciendo `docker rm -f` con señal independiente. El
driver local sigue existiendo para tests sin Docker y NUNCA se presenta
como gVisor (`runtime:'none'`, `gvisor:false`). **Ojo deploy**: el VPS
necesita gVisor instalado (https://gvisor.dev/docs/user_guide/install/) o,
mientras tanto, `SIRAGPT_SANDBOX_RUNTIME=runc` explícito — con
NODE_ENV=production y sin runsc, los turnos del runner fallan honesto.
Tests verdes: `tests/agent-runner-f5-sandbox.test.js` (los asserts de
aislamiento real corren solo con Docker presente y se saltan honesto si
no) + suites F1/F2/F3/F4 sin cambios. Falta el merge del PR y la
verificación de CI/producción por Luis.

F4 (orquestador jerárquico): **COMPLETED** — mergeado y desplegado en
siragpt.com el 2026-08-13 (PR #283, commit `bc831cc59`).

F3 (SSE traces + cancel): **COMPLETED** — mergeado y desplegado en
siragpt.com el 2026-08-13 (PR #282, commit `692420ebe`).

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
  - **Deploy**: mergeado y desplegado en siragpt.com el 2026-08-13
    (PR #282, commit `692420ebe`).

- **F5 — Sandbox hardening (este PR).** Todo vive en
  `backend/src/services/doc-agent/sandbox.js` (+ tests); ni la UI ni el
  esquema Prisma cambian.
  - **Runtime gVisor con selección honesta** (`resolveSandboxRuntime`,
    `SIRAGPT_SANDBOX_RUNTIME=auto|runsc|runc`): runsc cuando el daemon lo
    registra; producción o `SIRAGPT_SANDBOX_REQUIRE_GVISOR=1` sin runsc →
    `SandboxRuntimeError` honesto ANTES de `docker run` (nunca downgrade
    silencioso a runc ni al driver local; `REQUIRE_GVISOR=1` deshabilita
    incluso el opt-in runc y el driver local explícito). El probe de
    runtimes (`docker info {{json .Runtimes}}`) se cachea 60s.
  - **Límites duros por contenedor** (`sandboxLimitsFromEnv` +
    `buildDockerRunArgs`, ambos puros y testeables sin daemon): `--cpus 1`,
    `--memory 1g` + `--memory-swap` igual (sin swap), `--pids-limit 256`,
    `--cap-drop ALL`, `--security-opt no-new-privileges`, `--ulimit nofile`
    + `fsize` (256MB/archivo, también capa readFile), rootfs `--read-only`
    con tmpfs `/tmp` y `HOME=/workspace`, workspace efímero = tmpfs con
    tamaño capado (512m). Envs `SIRAGPT_SANDBOX_*` documentadas en
    `backend/.env.example`; valores malformados caen al default (nada de
    inyección vía env). `seccomp=unconfined` se rechaza siempre.
  - **Red cerrada SIEMPRE** (`--network none`, no configurable): F5 no trae
    opt-in de egreso; los allowlists son de F6.
  - **Aislamiento por tarea/tenant**: un contenedor efímero por tarea con
    nombre aleatorio; los workspaces persistentes son un volumen por
    conversación (`sira-ws-<key>` con key saneada — un persistKey hostil
    no puede montar docker.sock ni rutas del host).
  - **Archivos por exec-stream, no `docker cp`**: gVisor cachea el
    contenido de directorios y NO ve confiablemente los `docker cp` del
    host (FAQ gvisor.dev; kubectl cp funciona porque copia con exec).
    putFile = `docker exec -i sh -c 'mkdir -p … && cat > …'` con el buffer
    por stdin; readFile = `docker exec cat` con stdout binario (sin
    truncado utf8 — OOXML intacto) y tope de bytes honesto. Además el
    workspace tmpfs vive DENTRO del sandbox y docker cp ni existe ahí.
  - **Escapes**: `resolveInWorkspace` sigue rechazando `..`/absolutos; el
    driver local ahora rechaza symlink-out por realpath
    (`assertRealpathInWorkspace`); en el driver docker toda ruta crafteada
    se confina bajo `/workspace` (`safeContainerRel`) y se single-quotea
    (`shQuote`) — `$(…)`/`;` en nombres de archivo quedan como datos.
  - **F3 intacto**: `opts.signal` sigue matando el `docker exec` en vuelo
    (kill de process-group) y `destroy()` sigue con `docker rm -f` y señal
    independiente; verificado contra `ps` en el gate F5.
  - **Driver local honesto**: sigue para unit tests sin Docker; reporta
    `runtime:'none'` / `gvisor:false` (y el evento `sandbox_ready` ahora
    lleva runtime+gvisor); con `REQUIRE_GVISOR=1` se niega a arrancar.
  - **Tests** (`tests/agent-runner-f5-sandbox.test.js`): traversal +
    symlink-out + lecturas de /etc/passwd rechazadas; args de `docker run`
    verificados contra un CLI stub (runsc/none/límites/cap-drop/read-only/
    tmpfs; jamás docker.sock, `--network host` ni `--privileged`); matriz
    completa de `resolveSandboxRuntime`; REQUIRE_GVISOR sin runsc falla
    antes de crear contenedor; abort sin proceso leakeado; inyección por
    rutas neutralizada; y una prueba de aislamiento REAL (red cerrada,
    rootfs read-only, round-trip binario) que corre solo con Docker
    presente y se salta honesto si no. Suites F1–F4 verdes sin cambios.

- **F4 — Orquestador jerárquico (PR #283, desplegado 2026-08-13).** Todo vive en
  `backend/src/services/agent-runner/orchestrator/` y llama al AgentRunner
  real — el stack viejo ReAct/SE (`agents/planner.js`,
  `sub-agent-orchestrator.js`, `budget.js`, `subagent-registry.js`) NO se
  toca ni se enruta.
  - **Gate `shouldOrchestrate(text, ctx)`**: orquesta SOLO objetivos
    genuinamente multi-paso (≥2 señales de rol distintas — investigar,
    analizar datos, código, redactar — más un conector secuencial o segundo
    imperativo). "crea una ppt rosada" y los follow-ups de estilo/color se
    quedan en el runner único; tests lo fijan.
  - **Director/planner** (`orchestrator/planner.js`): UNA llamada LLM
    (mockeada en tests) devuelve el DAG `{ nodes: [{ id, role, goal,
    dependsOn[], budget: { maxIterations, maxTokens } }] }`. Validación dura
    (ids únicos, roles conocidos, deps existentes, sin ciclos, budgets
    presentes, máx nodos) + orden topológico Kahn. Plan inválido →
    `plan_failed` honesto.
  - **Sub-agentes especializados** (`orchestrator/roles.js`):
    `document_editor`, `coder`, `researcher`, `data_analyst`, `verifier`.
    Cada nodo corre `runAgentRunner` completo (sandbox + tools + contrato de
    verificación) con un sufijo de system prompt por rol (param nuevo
    `systemAppend`). El researcher NO tiene web_search (eso es F6): trabaja
    con los archivos provistos. Los roles de texto corren con
    `requireFileOutput: false` (sin retry de no-output).
  - **Presupuestos duros** (`orchestrator/budget.js`): tracker por nodo Y
    por run (iteraciones + tokens, `usage.total_tokens` o estimación chars/4)
    aplicado en el boundary del cliente LLM — la llamada N+1 sobre el cap
    lanza `BudgetExceededError` y corta el loop (probado contra un mock que
    seguiría para siempre). Cap de run → toda la orquestación termina con
    error honesto `budget_exceeded`. Sin retry-forever. Env:
    `SIRAGPT_ORCHESTRATOR_MAX_NODES/_MAX_TOTAL_ITERATIONS/_MAX_TOTAL_TOKENS`.
  - **Blackboard compartido** (`orchestrator/blackboard.js`): en memoria,
    por run. Cada nodo terminado escribe texto final + outputs; los nodos
    downstream reciben ese texto en su instrucción y los archivos upstream
    como uploads reales de su sandbox. Nada se persiste fuera del run (sin
    migración Prisma).
  - **Steering**: `steer(runId, mensaje)` (exportado también como
    `steerAgentOrchestratorRun`) inyecta una nota en un run vivo; entre nodos
    se replanifica SOLO lo restante (segunda llamada al planner con
    completados + steering) y los nodos completados jamás se reinician.
  - **Cancel**: el AbortSignal de F3 corta planner y sub-agente en vuelo
    (mismo signal compuesto), una sola traza "Cancelado", registro de runs
    vivos limpio, sin loops filtrados. Nunca éxito sobre un run parcial: un
    fallo de presupuesto/402 NO persiste artefactos de nodos previos.
  - **Trazas F4** (`trace.js`): labels nuevos "Planificando" / "Plan listo" /
    "Delegando a sub-agente" / "Sub-agente listo" / "Replanificando" /
    "Presupuesto agotado" / "Instrucción recibida" — todo evento del
    orquestador pasa por `toStageEvent`, el contrato SSE `type:'stage'` no
    cambia.
  - **Wiring**: la rama orquestada vive DENTRO de `executeAgentRunnerTurn`,
    así chat, `/api/doc/generate` y el preloop de `/api/agent/task` la usan
    sin cambios y persisten outputs igual que un turno de runner único.
    Kill switch `SIRAGPT_AGENT_ORCHESTRATOR` (1=on, 0=off; unset = ON en
    producción, OFF bajo NODE_ENV=test), documentado en `backend/.env.example`.
  - **Generator-critic**: si el plan produce entregable de documento/código y
    no declara verifier, se agrega UN nodo verifier al final (pase único; el
    best-of-n / A/B es F9). Un verifier infeliz no destruye el resultado —
    su veredicto va al resumen.
  - **Fallo honesto**: razones nuevas `budget_exceeded` / `plan_failed` con
    copy en español en `AGENT_RUNNER_FAILURE_COPY`; un turno reclamado que
    falla orquestado jamás alcanza `advanced-document-pipeline` ni
    `create_document` (test de chat e2e con el orquestador real fallando).
  - **Tests** (`tests/agent-runner-f4-orchestrator.test.js`, 17): gate
    single-runner vs multi-paso; DAG en orden topológico con sub-agentes
    AgentRunner reales (LLM mockeado + sandbox local) y blackboard pasando
    texto y archivos; caps de nodo y de run cortando un loop infinito;
    steering que replanifica solo lo restante; abort a mitad de nodo y a
    mitad de planning; kill switch; fallo orquestado → error honesto en chat
    sin `create_document`. Suites F1/F2/F3 existentes verdes sin cambios.

## En progreso

- **F7.0** (SiraComputer provision): interfaz `DesktopProvider` + imagen
  `sira-desktop` + DCP `:9000`. Gate de Docker pendiente de CI / máquina con
  daemon. F7.1–F7.8 NO se inician.

## Pendiente

- **Cerrar F7.0** cuando CI (o una máquina con Docker) pase §22.1: `docker
  build` + contenedor + `/health` + `/screenshot`. Entonces marcar F7.0
  COMPLETED y dejar F7.1 como siguiente (E2B + warm pool) — sin empezarla
  en el mismo PR.
- **F7.1–F7.8**, según `F7_SIRACOMPUTER_MASTER_SPEC.md` §21.
- **F8 en adelante**, según `ROADMAP.md`: memoria/skills/MCP → evals →
  flywheel → enterprise → plataforma (MinIO/OTel/canary, Drizzle).
- **Paso de deploy F5 (Luis, VPS)**: instalar gVisor y registrar `runsc` en
  `/etc/docker/daemon.json` (https://gvisor.dev/docs/user_guide/install/);
  hasta entonces, `SIRAGPT_SANDBOX_RUNTIME=runc` explícito mantiene el
  comportamiento actual — con `NODE_ENV=production` y sin ninguna de las dos
  cosas, los turnos del runner fallan con error honesto (fail-closed por
  diseño).

## Cómo retoma una sesión futura

1. Leer `STATE.md` (este archivo) para saber la fase activa y su estado.
2. Leer `ROADMAP.md` y, si la fase es F7, `F7_SIRACOMPUTER_MASTER_SPEC.md`.
3. Implementar SOLO la sub-fase activa (hoy F7.0). No adelantar F7.1+.
4. Al cerrar: tests + gates verdes, commit propio, actualizar `STATE.md`.

## Notas operativas

- ORM actual: **Prisma** (Drizzle = fase posterior, no está hecho).
- Deploy: Luis pushea desde su Mac; el VPS no puede `git push`. Los agentes abren PRs.
- `AGENT_RUNNER_ASYNC` off por defecto (SSE in-process); BullMQ opcional via env.

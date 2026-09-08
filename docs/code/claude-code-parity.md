# /code vs Claude Code — auditoría de paridad de infraestructura

> Re-auditoría sobre `production-main@2b0866f79` (2026-07-30), hecha leyendo
> CÓDIGO REAL con 8 lectores paralelos + 38 verificadores adversariales
> (7 gaps propuestos fueron **refutados** por existir ya bajo otro nombre).
> El modelo de IA queda fuera del análisis por decisión de producto: todo lo
> aquí listado es infraestructura programable.
>
> Sustituye a `claude-code-parity.md`, que quedó obsoleto: el motor proactivo
> implementó buena parte de aquel backlog por su cuenta (tools 16 → 26,
> módulos codex 40 → 87).

## Paridad por dimensión

| Dimensión | % |
|---|---|
| Gestión de contexto largo | 88 |
| Flujo git/PR | 84 |
| Plano de herramientas | 82 |
| Mecánica del loop | 82 |
| Permisos y seguridad | 80 |
| Sesiones y persistencia | 78 |
| Memoria de proyecto | 74 |
| **Extensibilidad (MCP/hooks/plugins)** | **62** |

**Media: 79%** (era ~60% en la auditoría del 26-jul).

## Ya en paridad o por encima (verificado en código)

- **Herramientas**: 26 tools. `run_command` con background real (supervisor
  detached + `task_logs`/`task_stop`), `read_file` con offset/limit y
  `read_media` multimodal (PNG/JPEG/GIF/WebP + PDF con bloque nativo),
  `write_file`/`edit_file` con contrato file-state completo (read-before-edit
  + `changed_since_read`), `glob` vía git pathspec respetando .gitignore,
  `grep_search`, `web_fetch` con SSRF/DNS anti-rebinding, `web_search`,
  `update_plan` (≡ TodoWrite).
- **Por encima de Claude Code**: escalera de matching en `edit-matching.js`
  (exact → line-trimmed con re-indentado) que recupera ediciones que la Edit
  base fallaría; `repo_map` rankeado estilo Aider; `type_check`,
  `dev_server_check`, `browser_check`, `inspect_database`, `resolve_conflict`.
- **Contexto**: microcompact + compaction con resumen LLM + rehidratación.
- **Extensibilidad presente**: MCP por proyecto (`.sira/mcp.json`), skills de
  workspace (`.sira/skills/*.md`), subagentes custom, plugins en
  `services/agents/`.
- **Permisos**: `project-settings.js` con `commandDecision` (allow/deny por
  glob), equivalente a `acceptEdits`, y bandeja durable de aprobaciones ya
  cableada en `agent-harness/permission-manager.js`.

## Gaps confirmados (31) — ordenados por esfuerzo

### [S] Glob de Claude Code ordena por fecha de modificación (mtime, más recientes primero); el glob de codex ordena alfabéticamente y no ve archivos gitignored
- **Dimensión:** Plano de herramientas
- **Por qué importa:** El orden por mtime prioriza los archivos que el agente acaba de tocar — útil en iteración. Alfabético funciona pero pierde esa señal. Que respete .gitignore es mayormente virtud (excluye node_modules) pero oculta artefactos generados si el modelo los busca.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/safe-glob.js`
- **Enfoque:** En runSafeGlob, tras parseFileList, ejecutar opcionalmente un segundo exec ['git','log'...] no — más simple: runner.exec ['ls','-t'] no aplica a listas; lo directo es exponer un arg sortByMtime que haga stat batch via el runner (node -e con fs.statSync sobre la lista, ya hay precedente de node -e en background-tasks.js L325) y ordene por mtimeMs desc. ~25 líneas.

### [S] El transcript nunca usa bloques nativos tool_use/tool_result ni conserva los turnos assistant con tool calls (Claude Code mantiene la traza canónica con IDs pareados)
- **Dimensión:** Mecánica del loop
- **Por qué importa:** Incluso en el motor Anthropic NATIVO, los resultados vuelven como mensajes user `[TOOL_RESULT tool] …` (toolResultContent agent-loop.js:207-220, push en 2222) y los tool_use del assistant se descartan del historial (solo se conserva el narrativeText, 1874). Claude ve sus propias llamadas solo implícitas en los resultados: peor grounding del modelo, sin pareo id↔resultado, y es el prerequisito para preservar thinking interleaved (la API exige el assistant turn previo con sus bloques para continuar thinking firmado).
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/agent-loop.js`
- **Enfoque:** Cuando activeProvider === 'anthropic', anexar al transcript el turno assistant completo con sus bloques content (thinking + text + tool_use con id) y los resultados como `{ role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }`; toAnthropicMessages (anthropic-turn.js:51-108) ya acepta bloques y solo necesita dejar pasar tool_use/tool_result. Mantener la codificación textual actual como proyección para el ladder prompted (llm-turn.js ya re-serializa).

### [S] Detección de truncado ciega en el camino nativo Anthropic (el reintento anti-truncado solo existe en el camino prompted)
- **Dimensión:** Mecánica del loop
- **Por qué importa:** parseResponse (anthropic-turn.js:192-227) nunca lee `stop_reason`; anthropicTurn retorna sin campo `truncated` y llm-turn.js:151 hace return directo saltándose detectTruncatedToolCall (que además solo entiende fences prompted). Un turno Claude cortado en max_tokens con cero tool_use completos es indistinguible de 'terminé' → el loop cierra el build con el archivo sin escribir, exactamente el bug (cycle-16) que el retry prompted arregló. Mitigado por max_tokens=16384 pero no eliminado (seeds/archivos grandes).
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/anthropic-turn.js`
- **Enfoque:** En parseResponse, devolver `truncated: resp.stop_reason === 'max_tokens'` (aplicando la misma regla del loop: solo significativo con toolCalls.length === 0). El nudge de agent-loop.js:1883 ya es genérico y lo consumiría sin cambios.

### [S] Co-authoring en commits (Claude Code firma 'Co-Authored-By: Claude <noreply@anthropic.com>' y commitea con la identidad del usuario; aqui todos los commits son 'Codex Agent <codex@siragpt.local>' sin atribuir al usuario ni al agente como co-autor)
- **Dimensión:** Flujo git/PR
- **Por qué importa:** En proyectos repo-backed los commits llegan a GitHub sin atribucion del dueno del proyecto ni trailer de agente — se pierde trazabilidad humano/maquina que GitHub renderiza nativamente y que auditores esperan.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/checkpoint-service.js`
- **Enfoque:** En checkpointCommitBody (L364-381) anadir trailer 'Co-Authored-By: <owner name> <owner email>' resolviendo el dueno via project.userId (prisma.user), y/o invertir: commitear con identidad del usuario y trailer 'Co-Authored-By: Codex Agent <codex@siragpt.local>'. gitCommitAll (workspace.js L27-33) ya acepta body multi-linea, asi que basta con concatenar el trailer al final del body; opcionalmente parametrizar GIT_IDENT por proyecto.

### [S] Cuerpo de PR generado por el modelo (Claude Code redacta Summary + Test plan; aqui el body del PR es boilerplate estatico de 5 lineas y el titulo es un slice del prompt)
- **Dimensión:** Flujo git/PR
- **Por qué importa:** El PR llega a revision humana sin resumen de cambios, sin evidencia de verificacion (que gates pasaron, diffstat, checkpoint sha) — informacion que el sistema YA calcula (verification, diffstat, learnings) pero no inyecta.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/agent-loop.js`
- **Enfoque:** En la llamada a publishSelfHostedPullRequest (L2825-2833) pasar body construido con el material ya disponible en scope: resolvedSourcePrompt, diffstat, verification/projectGateVerification, checkpoint.commitSha y learnings del progress-ledger (o un turno LLM barato reutilizando generateCheckpointTitle como patron). self-hosting.js ya acepta y sanea body (cleanPullRequestBody L241, cap 60KB) — cero cambios alli.

### [M] Recuperación ante error de overflow del proveedor (Claude Code: al recibir 'prompt is too long' del API, compacta y reintenta el turno; aquí cualquier error de transporte LLM mata el run)
- **Dimensión:** Gestión de contexto largo
- **Por qué importa:** El presupuesto por chars/3 es conservador pero heurístico: un transcript denso en tokens (JSON minificado, código no-ASCII, diffs) puede superar el window real aunque esté bajo el budget en chars; hoy ese 400 del proveedor termina el run con status:error en vez de auto-repararse con una compactación extra.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/agent-loop.js`
- **Enfoque:** En el catch del llmTurn del loop (L1833-1842), detectar mensajes de context-overflow con regex (context_length_exceeded | prompt is too long | maximum context length | input length and max_tokens) — opcionalmente como patrón nuevo en error-patterns.js —, y en ese caso: reducir contextMaxChars efectivo (p.ej. *0.7), forzar el pase summariseContextWithLlm+compactMessages y reintentar el mismo step una vez (contador acotado tipo MAX_TRUNCATION_RETRIES) antes de rendirse con status:error.

### [M] Grep de Claude Code soporta líneas de contexto (-A/-B/-C), modos de salida (files_with_matches, count), filtros por glob/type y multiline; grep_search solo devuelve archivo:línea:contenido con ignoreCase
- **Dimensión:** Plano de herramientas
- **Por qué importa:** Sin contexto ni modo files-only el modelo quema turnos extra: tras cada match debe llamar read_file para ver el código alrededor, y en repos grandes 120 líneas de matches sin -l dificultan localizar archivos.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/build-tools.js`
- **Enfoque:** En grep_search (L460-487) añadir args opcionales contextLines (→ push '-C', String(n) acotado 0-10), filesOnly (→ '-l'), count (→ '-c') y glob (→ pathspec ':(top,glob)pat' en lugar del path plano). git grep ya soporta todos; son ~30 líneas + tests en codex-build-tools.

### [M] NotebookEdit (y renderizado de .ipynb en Read) no existe en ninguna forma
- **Dimensión:** Plano de herramientas
- **Por qué importa:** Importancia BAJA para el producto: el workspace de /code genera apps Vite/React/TS, no data science; nadie sube notebooks hoy. Solo cuenta como paridad literal con el toolset de Claude Code.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/build-tools.js`
- **Enfoque:** Si algún día importa: en read_file detectar extensión .ipynb y renderizar celdas (JSON.parse → source+outputs por celda) y añadir tool notebook_edit (replace/insert/delete de celda por id, escribiendo el JSON via ctx.runner.writeFiles con el mismo file-state). Alternativa razonable: declararlo fuera de alcance del producto.

### [M] WebSearch de Claude Code soporta allowed_domains/blocked_domains; web_search solo acepta query
- **Dimensión:** Plano de herramientas
- **Por qué importa:** Menor: sin filtro de dominios el modelo no puede restringir a docs oficiales (p.ej. solo vitejs.dev) y depende de que el ranking del provider lo haga. Impacto bajo porque web_fetch permite ir a la URL exacta después.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/build-tools.js`
- **Enfoque:** Añadir args allowedDomains/blockedDomains al schema de web_search (L684) y filtrar la lista de resultados por hostname antes del slice(0,5) (L695) — el filtro post-hoc no necesita soporte del provider. ~15 líneas.

### [M] Fork ejecutable: Claude Code permite reanudar una sesion forkeada como sesion viva (--resume --fork-session); aqui el fork crea artefactos muertos que ningun run puede consumir
- **Dimensión:** Sesiones y persistencia
- **Por qué importa:** El usuario puede forkear el transcript pero no puede lanzar un agente que continue desde ese fork — la feature es de solo-lectura, pierde el 90% de su valor (explorar una rama alternativa del build)
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/run-service.js`
- **Enfoque:** Anadir param sourceSessionId a createRun (L177-194): tras crear el run, llamar sessionService.forkSession({sourceSessionId, targetSessionId: run.id}) y encolar con resumeSnapshot {sessionId: run.id, cursorSeq} — el gate de run-processor.js L266 (resumeSnapshot.sessionId === run.id) ya aceptaria el snapshot clonado. Exponer el param en POST /projects/:id/runs (routes/codex.js ~L2080) y en el route de fork devolver un run listo en vez de solo artefactos

### [M] UI para fork/rewind/continue de sesion: los metodos tipados existen en el cliente pero ningun componente los invoca (Claude Code tiene Esc-Esc rewind y el picker de resume como acciones de primer nivel)
- **Dimensión:** Sesiones y persistencia
- **Por qué importa:** La infraestructura completa (API + servicio + tests) es invisible para el usuario; solo el rollback de checkpoint simple tiene boton (checkpoint-card). Nota: CLAUDE.md restringe cambios de UI salvo excepcion /code ya concedida
- **Archivo:** `/Users/luis/sira-wt-proactive/components/codex/run-timeline.tsx`
- **Enfoque:** Anadir accion 'rebobinar hasta aqui' por evento del timeline (llama codexApi.rewindSession con toSeq del evento y checkpointId del checkpoint mas cercano) y 'fork desde aqui' (codexApi.forkSession con atSeq) — los metodos ya existen en lib/codex/codex-api.ts L1006-1015

### [M] Transcript JSONL completo/exportable: el artefacto de sesion es un ring acotado (500 entradas / 1MB, entradas viejas se descartan con shift), mientras Claude Code conserva el transcript integro de la sesion
- **Dimensión:** Sesiones y persistencia
- **Por qué importa:** En runs largos (el timeout default es 15 min y hay runs proactivos multi-hora) el JSONL pierde la cabeza de la sesion; la historia completa existe en codex_events pero no hay export unificado como transcript
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/routes/codex.js`
- **Enfoque:** Gap menor/parcial: el GET /transcript (L2119) capea limit a 500 y lee el artefacto acotado. Anadir ?source=events (o /transcript/full) que pagine desde eventStore.listEvents (cap 20000, event-store.js L154-172) serializado como JSONL streaming — cero cambios de esquema, los datos ya son durables

### [M] Fidelidad parcial del resume: se rehidrata resumen-de-compaction + tail de 10 mensajes (8k chars c/u), no la lista completa de mensajes como hace Claude Code al reanudar
- **Dimensión:** Sesiones y persistencia
- **Por qué importa:** Tras un resume el agente puede perder detalle fino de decisiones tempranas (mitigado: el prompt de reanudacion le ordena reconfirmar estado real con tools, y el workspace + eventos + permisos si son integros). Es un tradeoff de ingenieria razonable, se lista por honestidad de paridad, prioridad baja
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/agent-loop.js`
- **Enfoque:** Si se quisiera fidelidad total: reconstruir messages desde el transcript completo (codex_events) en vez de tailMessages del snapshot, re-compactando con la misma logica de compactMessages — subir COMPACT_KEEP_TAIL/CONTEXT_SNAPSHOT_MESSAGE_CAP (L56-60) es el knob barato intermedio

### [M] Los subagentes NO heredan la memoria del proyecto (SIRA.md/notes/ledger) — solo reciben companySoul
- **Dimensión:** Memoria de proyecto
- **Por qué importa:** En Claude Code los subagentes corren con el contexto de CLAUDE.md; aquí un frontend_builder o db_architect delegado puede violar convenciones que el loop principal sí respeta (el bug análogo del tier ya se arregló para el modelo, línea 316-320 de agent-sdk/index.js, pero no para la memoria).
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/agent-sdk/index.js`
- **Enfoque:** En agent-loop.js (~línea 2075-2082, el bloque deps de run_subagent que ya pasa tier/projectSettings/companySoul) añadir projectNotes y progressContext ya calculados (líneas 1560/1566 — cero I/O extra); en agent-sdk/index.js:340-351 anexarlos al system prompt del subagente con caps propios (p.ej. 4000/2000).

### [M] Imports en el archivo de memoria (sintaxis @ruta de CLAUDE.md para componer memoria desde otros archivos)
- **Dimensión:** Memoria de proyecto
- **Por qué importa:** Fidelidad menor: sin imports, SIRA.md no puede referenciar docs vivos del propio workspace (p.ej. '@docs/conventions.md') y todo debe duplicarse dentro del cap de 5000 chars.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/agent-loop.js`
- **Enfoque:** En safeProjectNotes, post-procesar el contenido de SIRA.md: por cada línea que matchee /^@([\w./-]+\.md)$/ resolver runner.readFile(projectId, ruta) con presupuesto compartido (p.ej. máx 3 imports, 1200 chars c/u, sin recursión) e inline con encabezado '### import: <ruta>'.

### [M] Extended thinking nativo nunca se solicita a la API (Claude Code corre con thinking habilitado e interleaved thinking preservado como bloques nativos firmados)
- **Dimensión:** Mecánica del loop
- **Por qué importa:** El plumbing de streaming ('stream.on(thinking)' en anthropic-turn.js:294 y llm-provider.js:169) y el parseo de bloques thinking (anthropic-turn.js:199) existen, pero sin `thinking: { type: 'enabled', budget_tokens }` en el request los modelos Claude no emiten thinking — solo se manda `output_config.effort` (anthropic-turn.js:263). El razonamiento que sí llega (prompted/OpenRouter) se preserva entre turnos como TEXTO plano capado a 8K (`[REASONING_CONTEXT]`, agent-loop.js:1856-1861), no como bloques nativos: pierde fidelidad y el modelo puede confundirlo con narrativa.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/anthropic-turn.js`
- **Enfoque:** En anthropicTurn: cuando el modelo lo soporte (gate por model-capabilities/env CODEX_EXTENDED_THINKING), añadir `thinking: { type: 'enabled', budget_tokens: N }` al request mapeando effort→budget, y devolver los bloques thinking crudos (con signature) en el turn. En agent-loop.js, conservar esos bloques en la representación del transcript en lugar del mensaje textual [REASONING_CONTEXT] (requiere el gap de bloques nativos de abajo).

### [M] Cap de 4 tool calls por turno (Claude Code no limita el fan-out por turno del modelo)
- **Dimensión:** Mecánica del loop
- **Por qué importa:** DEFAULT_MAX_TOOLS_PER_TURN=4 (agent-loop.js:38, aplicado en 1878) recorta el paralelismo recién generalizado: un turno Claude que emite 8 reads paralelos ejecuta 4 y pierde un round-trip completo (con su costo de input tokens) para los otros 4, aunque el mensaje '[BUDGET]' (1945-1950) evita la mentira. El cap nació para modelos eco prompted; para el motor nativo es artificialmente bajo.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/agent-loop.js`
- **Enfoque:** Hacer el cap dependiente del motor: mantener 4 para prompted/eco y subirlo (12-16, o solo capar acciones de escritura) cuando activeProvider === 'anthropic' con tools nativas — p.ej. `readPosInt(env.CODEX_MAX_TOOLS_PER_TURN, activeProvider.provider === 'anthropic' ? 12 : DEFAULT_MAX_TOOLS_PER_TURN)` tras calcular activeProvider (1522).

### [M] Sin streaming de argumentos de tool en vivo (Claude Code muestra el archivo escribiéndose vía input_json_delta)
- **Dimensión:** Mecánica del loop
- **Por qué importa:** El file_patch/file_delta se emite DESPUÉS de completarse el write (agent-loop.js:2153-2167 lee el patch del workspace post-ejecución). Durante un write_file grande (10-30s de generación) el usuario ve solo el spinner de action_start; Claude Code streamea el diff mientras el modelo lo genera. Es el último escalón de granularidad de streaming que falta — narrativa y reasoning ya streamean por delta.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/anthropic-turn.js`
- **Enfoque:** En el camino streaming, suscribirse a los eventos content_block (input_json_delta) del SDK (`stream.on('streamEvent')`), acumular el partial_json de bloques tool_use write_file/edit_file y exponer un callback onToolInputDelta que agent-loop convierta en un evento nuevo (p.ej. action_progress con el tail del contenido) — el event-store y el timeline ya toleran kinds nuevos.

### [M] Cobertura de eventos de hooks incompleta: faltan UserPromptSubmit, SessionStart/SessionEnd, SubagentStop, PreCompact y Notification (Claude Code tiene 9+ eventos; aqui hay 3: preToolUse/postToolUse/stop)
- **Dimensión:** Extensibilidad
- **Por qué importa:** Sin UserPromptSubmit no se puede inyectar contexto o vetar prompts por politica de proyecto; sin PreCompact no se puede preservar estado critico antes de la compactacion (que el loop SI hace — CONTEXT_SUMMARY_CAP en agent-loop.js); sin SubagentStop no hay auditoria del cierre de delegaciones.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/project-hooks.js`
- **Enfoque:** Extender parseHooks (l.44-60) con las listas nuevas y disparar: userPromptSubmit en run-processor/agent-loop antes de construir messages (l.1580-1598), preCompact antes del snapshot de compactacion, subagentStop en el execute de run_subagent (build-tools.js:821) tras formatSubagentReport.

### [M] Hooks y gate de aprobacion NO se aplican dentro de los subagentes: runSubagent ejecuta tool.execute directamente sin applyPreHooks ni requiresApproval
- **Dimensión:** Extensibilidad
- **Por qué importa:** Un hook deny sobre write_file (o un requireApproval sobre run_command) se bypasea delegando en frontend_builder/debugger, que tienen esas tools en su set. En Claude Code los hooks aplican a todo tool use, incluidos subagentes.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/agent-sdk/index.js`
- **Enfoque:** Pasar hookState y project por deps desde el ctx de run_subagent (agent-loop.js ya inyecta projectSettings en ctx, l.2080) y envolver la llamada tool.execute de runSubagent (l.439) con projectHooks.applyPreHooks/applyPostHooks; para requiresApproval, negar en subagente (no hay canal de aprobacion pausable dentro de la delegacion) con mensaje claro.

### [M] Sin transporte stdio para MCP (servidores locales lanzados por comando, el modo mas comun del ecosistema MCP)
- **Dimensión:** Extensibilidad
- **Por qué importa:** El catalogo de servidores MCP instalables via npx/uvx queda fuera; solo se pueden usar servidores remotos HTTP/SSE. Para un SaaS es defendible (no hay maquina del usuario), pero es paridad perdida real.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/mcp-tools.js`
- **Enfoque:** Aceptar transport 'stdio' en normalizeServerDefinition (whitelist l.145-146) con {command, args} y ejecutarlo DENTRO del runner sandbox del proyecto (runner.exec como proceso persistente + bridge stdio↔HTTP local), nunca en el backend. Requiere tambien un connect stdio en agent-harness/mcp-client.js connectClient (l.368).

### [M] Sin MCP resources ni prompts: solo se descubren/ejecutan tools (listTools); Claude Code expone resources (@-mentions) y prompts (como slash commands)
- **Dimensión:** Extensibilidad
- **Por qué importa:** Un servidor MCP que publica documentacion o plantillas como resources/prompts es invisible para el agente; se pierde la mitad del protocolo.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/agent-harness/mcp-client.js`
- **Enfoque:** En discoverServerTools (l.672) llamar tambien client.listResources()/listPrompts() (con los mismos timeouts) y exponer en codex dos tools nuevas en build-tools.js: mcp_read_resource(uri) y mcp_get_prompt(name,args), reusando el patron de executeMcpCall en mcp-tools.js.

### [M] Sin modo nombrado tipo acceptEdits (auto-aprobar ediciones de archivos, seguir confirmando comandos)
- **Dimensión:** Permisos y seguridad
- **Por qué importa:** Es el modo intermedio mas usado de Claude Code. Hoy es emulable (mode:auto + tools.requireApproval:['run_command','install_dependencies',...]) pero exige que el usuario conozca el inventario de tools — es un gap de conveniencia, no de capacidad.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/project-settings.js`
- **Enfoque:** Anadir 'accept-edits' al set MODES (linea 5); en requiresApproval (190-194) tratar los tools de kind file_write (write_file, edit_file, resolve_conflict) como seguros en ese modo y exigir confirmacion solo para terminal/mcp; en toolDecision no cambia nada. Test en codex-parity-core.test.js.

### [M] Hooks declarativos unicamente — no pueden ejecutar comandos del usuario (los hooks de Claude Code corren shell arbitrario con veto por exit code 2 y stdout de vuelta al modelo)
- **Dimensión:** Permisos y seguridad
- **Por qué importa:** Un hook que corra el linter/tests del proyecto antes de permitir un write, o validacion custom, es imposible hoy: solo allow/deny/transform estatico por glob de nombre de tool — no puede inspeccionar contenido ni ejecutar logica.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/project-hooks.js`
- **Enfoque:** Anadir action 'run' a ALLOWED_ACTIONS (linea 8) con {cmd:[...]} validado contra commandRejectionReason del runner; ejecutar via runner.exec DENTRO del workspace sandbox (mismo aislamiento que run_command) con timeout corto (~15s); exit != 0 => deny con stderr como message. applyPreHooks/applyPostHooks pasan a async — sus call sites en agent-loop.js:2002 y 2130 ya estan en funciones async. El sandbox del runner mitiga el riesgo RCE que motiva el diseno declarativo actual.

### [M] agent-approvals.js es un servicio suelto sin cablear (codigo muerto o roadmap E23 a medio superar)
- **Dimensión:** Permisos y seguridad
- **Por qué importa:** Confunde la auditoria: el inbox durable de 24h con memory store inyectable existe pero NADIE lo usa — el chat harness espeja aprobaciones directo a la tabla Prisma AgentApproval (permission-manager.js:115-240) y codex tiene su propio mecanismo durable via waiting_approval + event store. Dos fuentes de verdad a futuro si alguien lo cablea sin saberlo.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/agent-approvals.js`
- **Enfoque:** Decidir: (a) borrarlo junto con backend/tests/agent-approvals.test.js, o (b) completar el inbox global HTTP (GET /api/agent/approvals pendientes) como capa de lectura sobre la tabla AgentApproval real en vez del memory store, y que permission-manager lo consuma como store inyectado. La opcion (a) es la honesta si el inbox UI no esta en el roadmap inmediato.

### [L] SIRA.md jerárquico por directorio (Claude Code carga CLAUDE.md del cwd, de los padres y de subdirectorios on-demand al tocar archivos allí)
- **Dimensión:** Memoria de proyecto
- **Por qué importa:** Los starters full-stack de codex ya generan subárboles (server/ con su propio package.json); convenciones específicas de backend vs frontend no pueden scoparse y compiten por el cap único de 8000 chars del root SIRA.md.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/agent-loop.js`
- **Enfoque:** En safeProjectNotes (línea 1093) descubrir SIRA.md anidados vía runner.exec(['git','ls-files','--cached','--others','--exclude-standard','**/SIRA.md']) con tope (p.ej. 5 archivos, 1500 chars c/u) y etiquetarlos '## <dir>/SIRA.md'; opción B de mayor fidelidad: en build-tools read_file/edit_file, adjuntar lazy el SIRA.md más cercano al path tocado (memoization por run).

### [L] Memoria a nivel USUARIO cruzando proyectos (equivalente a ~/.claude/CLAUDE.md global + MEMORY.md de auto-memory por usuario)
- **Dimensión:** Memoria de proyecto
- **Por qué importa:** Preferencias durables del usuario (idioma, stack favorito, convenciones de commits, tono) se re-aprenden en cada proyecto codex desde cero; el chat ya tiene active-memory.js con two-tier + promotion pero el loop de codex no la consume.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/agent-loop.js`
- **Enfoque:** En runBuildLoop, tras cargar companySoul (línea 1561), cargar best-effort la memoria del usuario reutilizando backend/src/services/active-memory.js (recall por userId=run.userId, sin query semántica o con el sourcePrompt) y añadir un bloque 'MEMORIA DEL USUARIO' en buildSystemPrompt con cap ~1500 chars; alimentarla desde generateAutoLearnings cuando el aprendizaje sea de alcance usuario y no proyecto.

### [L] Loop de resolucion de conflictos dirigido por el agente tras un merge_conflict al cierre del run (Claude Code, ante un merge/rebase conflictivo, deja el estado conflictivo y lo resuelve archivo por archivo; aqui mergeRunBranch siempre hace merge --abort y el run termina en error)
- **Dimensión:** Flujo git/PR
- **Por qué importa:** resolve_conflict existe pero es casi inalcanzable en el flujo automatico: el unico productor de estado conflictivo (el merge de cierre) lo aborta y devuelve el conflicto como datos (git-workflow.js L510-527); agent-loop solo emite 'no se fusiono' y retorna error (L3011-3023). El trabajo queda varado en run/<id> y requiere intervencion manual, cuando el agente ya tiene la herramienta para resolverlo.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/agent-loop.js`
- **Enfoque:** En el path de branchFinalization fallida con merge.code==='merge_conflict' (L2856-2870 / L3011-3023), en vez de retornar error: bajo withProjectMergeLock re-ejecutar el merge SIN abort (nuevo flag {leaveConflicts:true} en mergeRunBranch), lanzar un mini-loop acotado (patron verify-loop.js) con tools read_file/resolve_conflict/run_command restringido a los paths en conflicts[], y al quedar 0 U hacer git commit (GIT_IDENT) + re-verificar antes de dar por fusionado; fallback al abort actual si agota presupuesto.

### [L] Semantica inconsistente del gate CODEX_RUN_WORKTREES entre modulos (git-workflow: opt-in estricto default OFF; run-service featureEnabled: default ON en produccion)
- **Dimensión:** Flujo git/PR
- **Por qué importa:** En produccion sin la env definida, run-service.js considera los worktrees 'habilitados' para el calculo del cap de concurrencia mientras la maquinaria real (startRunWorktree/resolveToolPath) esta apagada. Hoy lo neutralizan los dos opt-ins explicitos adicionales (CODEX_RUN_CONCURRENCY_ENABLED + OS_ISOLATION_ATTESTED), pero es una divergencia latente que puede permitir subir el cap con el aislamiento por seam realmente inactivo.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/run-service.js`
- **Enfoque:** En configuredRunCap (L108-115) evaluar CODEX_RUN_WORKTREES con explicitlyEnabled (ya definido en L104-106) o importar runWorktreesEnabled de git-workflow.js como fuente unica de verdad; anadir un check en config-validator.js que rechace la combinacion cap>1 con runWorktreesEnabled()===false.

### [L] Los hooks no pueden ejecutar comandos externos: Claude Code ejecuta shell commands con JSON por stdin/stdout y decision allow/deny/ask desde el exit code; aqui los hooks son puramente declarativos (allow/deny/transform con args estaticos)
- **Dimensión:** Extensibilidad
- **Por qué importa:** Es el 80% del poder de los hooks de Claude Code: linters pre-write, formateo post-edit, validaciones dinamicas contra el estado real del workspace. Un transform estatico no puede decidir en funcion del contenido.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/codex/project-hooks.js`
- **Enfoque:** Anadir accion 'run' al schema (ALLOWED_ACTIONS l.8) con {command: [...]} ejecutado via runner.exec dentro del workspace sandboxed (mismo camino que run_command, sujeto a commandDecision de project-settings), timeout corto (5-10s), pasando {toolName,args} como JSON por stdin y parseando stdout como {decision, updatedArgs, message}. Cablear en applyPreHooks/applyPostHooks convirtiendolas en async y actualizando los 4 call-sites de agent-loop.js (l.2002, 2130, 1913, 2289).

### [L] Sin OAuth para servidores MCP remotos (Claude Code negocia OAuth2 con /mcp; aqui solo headers estaticos via bindings de env)
- **Dimensión:** Extensibilidad
- **Por qué importa:** Los conectores MCP comerciales (Linear, Notion, Sentry, etc.) usan OAuth; hoy solo son conectables si ofrecen API-key por header, y el binding requiere que un operador toque CODEX_MCP_SECRET_BINDINGS del servidor — el usuario final no puede autoconectar nada.
- **Archivo:** `/Users/luis/sira-wt-proactive/backend/src/services/agent-harness/mcp-client.js`
- **Enfoque:** Implementar el flujo OAuth de la spec MCP (discovery de authorization server via 401 + WWW-Authenticate, PKCE, refresh) con tokens cifrados en la tabla mcp_servers (utils/encryption ya se usa para headers), ruta de callback en routes/, y en codex un puente para que .sira/mcp.json pueda referenciar una conexion OAuth del usuario en vez de un binding de env.


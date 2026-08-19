# Cómo funcionan por dentro los agentes de código líderes — y qué copiar en SiraGPT

> Investigación: julio 2026. Fuentes: documentación oficial (code.claude.com, developers.openai.com, cursor.com/docs), repos públicos (openai/codex), análisis técnicos verificados (SWE Quiz, Dive-into-Claude-Code/VILA-Lab, decodeclaude.com) y el blog de ingeniería de Cursor.
>
> Objetivo: reporte accionable para el módulo **/code · APPS** de SiraGPT (agente LLM que genera/edita apps Vite/Next en un runner Bun con preview en vivo) y para la línea de negocio "agentes SDK para software de empresas".

---

## 1. Claude Code (Anthropic)

### 1.1 Arquitectura del loop

La filosofía es **"less scaffolding, more model"**: un solo loop `while(tool_call)` — sin DAGs, sin clasificadores de intención, sin RAG. El modelo decide todo; el harness solo ejecuta y controla permisos.

```
prompt → Claude evalúa → ¿tool calls?
   ├── sí → ejecutar tools → resultados vuelven al modelo → repetir
   └── no → respuesta final (fin del turno)
```

- Cada ciclo (respuesta con tools + ejecución + resultados) es un **turn**. El loop termina cuando el modelo responde solo con texto.
- Límites en código, no en prompt: `maxTurns` (round-trips con tools) y `maxBudgetUsd` (corte por gasto).
- **Un solo hilo principal + subagentes**: no hay multi-agente permanente; el paralelismo se logra spawneando subagentes (tool `Agent`/`Task`) con contexto fresco.

### 1.2 Herramientas (el arsenal completo es pequeño)

| Tool | Rol |
|---|---|
| `Bash` | Adaptador universal: git, tests, builds, todo lo demás |
| `Read` / `Write` / `Edit` | Archivos. `Read` devuelve líneas numeradas (`cat -n`) |
| `Grep` / `Glob` | Búsqueda por regex (ripgrep) y por patrón de nombre |
| `Agent` (Task) | Subagentes con contexto aislado |
| `TodoWrite` / `TaskCreate`/`TaskUpdate` | Lista de tareas visible + auto-recordatorio |
| `WebSearch` / `WebFetch`, `AskUserQuestion`, `Skill`, `ToolSearch` | Web, preguntas modales al usuario, skills bajo demanda, descubrimiento dinámico de tools |

Regla de diseño (documentada por Anthropic): **empezar con bash para amplitud, promover a tool dedicada** cuando se necesita gatear (seguridad), validar staleness, renderizar UI custom o paralelizar. Ejemplo: `AskUserQuestion` es una tool para poder renderizarse como modal y bloquear el loop.

**Scheduling**: tools read-only (`Read`, `Grep`, `Glob`, MCP marcadas `readOnlyHint`) corren **en paralelo** dentro de un turno; las que mutan estado (`Edit`, `Write`, `Bash`) corren en serie.

### 1.3 Edits confiables: `str_replace` exacto

El tool `Edit` (API: `text_editor_20250728` / `str_replace_based_edit_tool`) hace **reemplazo de string exacto**:

- `old_string` debe coincidir byte a byte (incluida indentación) y ser **único** en el archivo; si no es único o no coincide → error, el modelo reintenta con más contexto.
- `replace_all` opcional para renombrados.
- **Invariante read-before-edit**: el harness rechaza el edit si el archivo no fue leído en la conversación o cambió en disco desde la última lectura (staleness check). Esto es lo que hace los edits "confiables": el fallo es ruidoso y recuperable, nunca silencioso.
- No hay modelo de apply intermedio ni diffs: el modelo de frontera es lo bastante preciso para producir el string exacto, y el formato es trivial de validar.

### 1.4 Gestión de contexto: grep-first, sin índice

- **"Search, don't index"**: Anthropic descartó embeddings tras benchmarks internos — búsqueda agéntica con ripgrep dio mejor rendimiento con menos complejidad operativa (sin sincronización de índice, sin mandar código a un proveedor de embeddings). El modelo hace 2-5 greps encadenados y lee solo lo relevante.
- **CLAUDE.md** se inyecta en cada request (prompt-cacheado) → las reglas persistentes sobreviven a la compactación.
- **Compactación multicapa** (análisis de decodeclaude.com): (1) *budget reduction* trunca tool-outputs gigantes, (2) *snip* recorta antigüedad, (3) **microcompact** saca tool-results viejos a disco recuperables por path (los recientes quedan inline), (4) *context collapse* para historiales enormes, (5) **auto-compact** = resumen semántico del historial como último recurso, emitiendo un boundary (`compact_boundary`). Manual con `/compact`.
- **System reminders**: XML invisible inyectado mid-turn (~50 tipos) que le recuerda al modelo estado del plan, todos pendientes, cambios en disco, etc.
- **Subagentes como aislamiento de contexto**: el subagente lee 30 archivos, el padre solo recibe el resumen final.

### 1.5 Verificación y self-correction

No hay un "verificador" separado: la verificación **es** el loop. El modelo corre `npm test`/linter vía Bash, lee el stderr como tool-result, edita, y vuelve a correr hasta verde. El system prompt lo empuja a verificar antes de declarar éxito. Los hooks (`PostToolUse`, `Stop`) permiten validación determinista externa (p.ej. correr lint tras cada Edit e inyectar los errores).

### 1.6 Planificación

- **TodoWrite**: lista de tareas estructurada (pending/in_progress/completed) que se renderiza en la UI y se re-inyecta como system reminder — el modelo se auto-monitorea contra su propio plan.
- **Plan mode**: modo de permisos donde el agente explora (Read/Grep/Glob) pero **no puede editar**; produce un plan que el usuario aprueba antes de ejecutar. Internamente hay variantes del reminder de plan (5-fases, iterativo, con subagentes).
- **Subagentes** con `AgentDefinition` (prompt, tools acotadas, modelo/effort propios — p.ej. exploración con Haiku barato).

### 1.7 Checkpoints / rewind

- Snapshot automático de cada archivo **antes de cada Edit/Write** + checkpoint por prompt del usuario.
- `/rewind` (o Esc Esc): restaurar *código*, *conversación*, o ambos, a cualquier prompt anterior.
- Solo cubre cambios hechos con tools de edición (no `rm`/`mv` vía bash). Complementa git, no lo reemplaza. En el SDK: `enableFileCheckpointing` + `query.rewindFiles(userMessageId)`.

---

## 2. Cursor (Anysphere)

### 2.1 Arquitectura

IDE (fork de VS Code) + agente en el editor. Mismo loop ReAct básico, pero con dos apuestas contrarias a Claude Code: **modelos propios especializados** (apply, embeddings, Composer) y **índice semántico del repo**.

### 2.2 Edits: el "apply model" (fast apply + speculative edits)

Cursor separa **planear el cambio** de **materializarlo**:

1. El modelo frontier emite un *sketch* del cambio (código parcial con `// ... existing code ...`), barato de generar.
2. Un **modelo apply propio** (entrenado para la tarea, servido con **speculative edits** — variante de speculative decoding que especula tramos largos del archivo original sin cambios) reescribe el archivo completo a ~1000 tokens/s.

Ventaja: el modelo caro no gasta tokens reescribiendo lo que no cambia y no necesita producir strings exactos. Coste: infra propia de inferencia + un modelo que mantener. Para archivos con ediciones puntuales también usan search/replace estilo str_replace; el apply model brilla en ediciones dispersas por todo un archivo.

### 2.3 Contexto: embeddings + grep (híbrido)

- **Índice semántico**: chunking por función/clase, **embedding model propio** entrenado con trazas de sesiones de agente reales (qué debió recuperarse antes para acelerar la tarea → señal de entrenamiento). Vector DB remota; el código en claro no se almacena (solo embeddings + metadatos).
- El agente elige por tipo de query: símbolo exacto → **grep**; concepto/comportamiento → **semantic search, luego grep** para rematar detalles; exploración amplia → **subagente Explore** con búsquedas paralelas en contexto separado.
- Resultado medido: +12.5% de precisión en Q&A sobre el repo vs grep solo (la ganancia crece con repos de 1000+ archivos), −2.2% de follow-ups de insatisfacción.
- Lección importante: **el híbrido gana** — semantic search sola no supera a grep sola; la combinación sí.

### 2.4 Verificación

El agente corre comandos en el terminal integrado (con allowlist/denylist del usuario y auto-run opcional), lee salida y errores de linter del propio IDE (diagnósticos LSP en tiempo real — señal que las CLIs no tienen) y se autocorrige. "Bugbot" y el flujo de review agregan una pasada de revisión sobre el diff final.

### 2.5 Planificación

Plan mode explícito (genera un plan editable en markdown que el usuario aprueba), TODOs del agente visibles en el chat, y subagentes (Explore). Composer/background agents ejecutan tareas largas fuera del hilo interactivo.

### 2.6 UI / streaming

Referencia del género:

- **Timeline en el chat**: cada tool call como fila ("Reading file X", "Running npm test") con estado y resultado colapsable.
- **Diffs inline en el editor** (verde/rojo) editables antes de aceptar; Accept/Reject por archivo o por bloque; panel de review agregado de todos los archivos tocados.
- **Checkpoints automáticos por request**: botón "Restore checkpoint" en cada mensaje del chat; solo rastrean cambios del agente (no ediciones manuales) y se limpian solos.

---

## 3. Codex (OpenAI)

### 3.1 Arquitectura

CLI en **Rust** (`codex-rs`) + agente cloud + extensión IDE, todos sobre el mismo core. Tres primitivas del protocolo: **Item** (unidad atómica tipada de I/O: user message, agent message, tool execution, approval request, diff — con ciclo de vida), **Turn** (una unidad de trabajo del agente: muchas iteraciones modelo↔tools, termina siempre en un assistant message), **Thread** (contenedor persistente de sesión con historial en disco → permite reconexión). El App Server habla **JSON-RPC bidireccional (JSONL sobre stdio)** con las UIs, emitiendo eventos tipados con lifecycle (started / deltas / completed) — el mismo patrón SSE-tipado que Codex V2 de SiraGPT.

Payload por request a la Responses API: `instructions` (prompt del modelo, p.ej. `gpt-5.2-codex_prompt.md`) + `tools` (shell, `apply_patch`, `update_plan`, web search, MCP) + `input` (mensajes ordenados).

### 3.2 Edits: `apply_patch` (formato V4A)

Codex usa una tool **freeform** (no JSON) con un formato de diff propio en el que los modelos GPT están **fuertemente entrenados**, descrito por una gramática libre de contexto:

```
*** Begin Patch
*** Update File: src/app.ts
@@ function login()
-  const ok = check(user)
+  const ok = await check(user)
*** Add File: src/util/retry.ts
+export function retry() { ... }
*** Delete File: src/old.ts
*** End Patch
```

- Tres operaciones: `Add File`, `Update File` (+ opcional `*** Move to:` para renombrar), `Delete File`. Hunks introducidos por `@@` con contexto (3 líneas por defecto), **sin números de línea** — se ancla por contenido, como str_replace pero multi-hunk y multi-archivo en una sola llamada.
- El parser (`codex-rs/apply-patch`) valida y aplica de forma atómica; el fallo por hunk devuelve error legible que el modelo corrige.
- Lección clave: **el formato de edición debe coincidir con la distribución de entrenamiento del modelo**. GPT rinde mejor con V4A; Claude con str_replace. Un harness multi-modelo debería elegir el formato por familia de modelo (Warp documentó exactamente esto al integrar modelos Codex).

### 3.3 Sandbox

Enforcement nativo por SO (Seatbelt en macOS, Landlock/seccomp en Linux, mecanismos propios en WSL2/Windows): el agente trabaja dentro de límites claros (escritura solo en el workspace, red bloqueada por defecto) y por eso puede correr **autónomo** sin aprobar cada comando. Un developer-message describe el sandbox al modelo. Modos de aprobación: `read-only` / `auto` (escritura en workspace sin preguntar, escalación para lo demás) / `full-access`. Las tools MCP **no** están sandboxeadas por Codex — cada servidor es responsable.

### 3.4 Contexto y compactación

- Sin índice semántico: shell-first (`rg`, `sed`, `ls`) + `AGENTS.md` como memoria del repo (equivalente de CLAUDE.md).
- **Compactación nativa del lado del servidor**: al acercarse al límite llama a `/responses/compact`, que devuelve una lista de items más pequeña que incluye un blob **`encrypted_content`** — representación latente opaca del estado del modelo, más compacta que un resumen textual y privacy-preserving. GPT-5.2-Codex fue entrenado con "native compaction" para trabajo de horizonte largo.

### 3.5 Verificación

El sandbox convierte "correr los tests" en la acción por defecto: el harness y el prompt empujan a ejecutar la suite tras cada cambio y a iterar sobre fallos. En Codex cloud cada tarea corre en un contenedor con el repo, y el resultado incluye logs de tests + diff final; el PR solo se propone con verificación pasada.

### 3.6 Planificación

Tool **`update_plan`**: el modelo mantiene una lista de pasos con estados que la UI renderiza como checklist viva (equivalente a TodoWrite). Codex cloud descompone en fases (explorar → planear → editar → verificar) visibles en el timeline.

---

## 4. Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)

**La pieza clave para SiraGPT**: es el motor completo de Claude Code (loop, tools, permisos, compactación, subagentes, checkpoints, sesiones) empaquetado como librería TypeScript/Python para embeber en un producto propio. **No requiere la CLI instalada**; el SDK es gratis y se paga solo el consumo de la API de Anthropic (también acepta autenticación de suscripción Claude vía `ant auth login` en dev).

### 4.1 API actual (TypeScript)

```typescript
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// query() devuelve un AsyncGenerator<SDKMessage> — el stream ES el loop
for await (const message of query({
  prompt: "Arregla los tests que fallan en el módulo auth",
  options: {
    model: "claude-sonnet-4-6",
    cwd: "/workspaces/proyecto-cliente",
    allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"], // auto-aprobadas
    permissionMode: "acceptEdits",
    settingSources: ["project"],   // carga CLAUDE.md, skills y hooks del repo
    maxTurns: 30,
    maxBudgetUsd: 2.0,             // corte duro por gasto
    effort: "high",
  },
})) {
  if (message.type === "assistant") { /* texto + tool calls del turno */ }
  if (message.type === "result")    { /* message.subtype, .result, .total_cost_usd, .session_id */ }
}
```

Superficie relevante de `Options`:

| Área | Opciones |
|---|---|
| Loop | `maxTurns`, `maxBudgetUsd`, `effort` (`low`→`max`), `model`, `fallbackModel`, `thinking` |
| Tools | `allowedTools` / `disallowedTools` (con scoping `"Bash(npm *)"`), `tools`, `toolAliases` |
| Permisos | `permissionMode` (`default`/`acceptEdits`/`plan`/`dontAsk`/`auto`/`bypassPermissions`) + **`canUseTool` callback** (allow/deny programático por llamada, puede modificar el input) |
| MCP | `mcpServers` (stdio/SSE/HTTP/**in-process**), `strictMcpConfig`; tool search difiere schemas MCP por defecto |
| Sesiones | `resume`, `continue`, `forkSession`, `sessionId`, `persistSession`, `sessionStore` (backend externo); helpers `listSessions()`, `getSessionMessages()` |
| Hooks | `hooks` (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStart/Stop`, `PreCompact`) — corren en tu proceso, no gastan contexto, pueden bloquear tool calls |
| Subagentes | `agents: Record<string, AgentDefinition>` (prompt, tools, model, effort, maxTurns, background) |
| Otros | `cwd`, `env`, `additionalDirectories`, `enableFileCheckpointing` + `query.rewindFiles()`, `outputFormat` (JSON schema), `includePartialMessages` (deltas de streaming), `startup()` (pre-warm del subproceso), `abortController`, `interrupt()` |

**Tools custom in-process** (sin proceso MCP separado):

```typescript
const deployTool = tool(
  "deploy_preview", "Despliega la app del cliente a un entorno de preview",
  { projectId: z.string(), branch: z.string().default("main") },
  async ({ projectId, branch }) => {
    const url = await deployService.deploy(projectId, branch);
    return { content: [{ type: "text", text: `Preview live: ${url}` }] };
  },
  { annotations: { readOnlyHint: false } }
);

const siraServer = createSdkMcpServer({
  name: "siragpt-tools", version: "1.0.0", tools: [deployTool],
});
// options: { mcpServers: { siragpt: siraServer } }
```

### 4.2 Mensajes del stream

`SystemMessage` (`init` con session_id, `compact_boundary`), `AssistantMessage` (texto + tool_use por turno; el contenido está en `message.message.content`), `UserMessage` (tool results), `StreamEvent` (deltas token a token si `includePartialMessages`), `ResultMessage` (`success` | `error_max_turns` | `error_max_budget_usd` | `error_during_execution`, con `total_cost_usd`, `usage`, `num_turns`, `session_id`, `stop_reason`).

### 4.3 Modelos y precios vigentes (jul 2026, API Anthropic)

| Modelo | ID | Contexto | Input $/1M | Output $/1M | Uso típico en agente de código |
|---|---|---|---|---|---|
| Claude Fable 5 | `claude-fable-5` | 1M | $10 | $50 | Trabajo agéntico long-horizon extremo |
| Claude Opus 4.8 | `claude-opus-4-8` | 1M | $5 | $25 | Agente principal premium |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 1M | $3 | $15 | **Sweet spot para /code** |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200K | $1 | $5 | Subagentes de exploración, tareas rápidas |

Cache reads ~0.1×; el SDK cachea automáticamente system prompt + tools + CLAUDE.md. `effort: "xhigh"` es el default de Claude Code para coding en Opus 4.7+.

---

## 5. Tabla comparativa

| Dimensión | Claude Code | Cursor | Codex |
|---|---|---|---|
| Loop | `while(tool_call)` puro, sin scaffolding | ReAct en IDE + modelos auxiliares propios | Item/Turn/Thread sobre Responses API |
| Edits | **str_replace exacto** + read-before-edit staleness | **Apply model** propio (speculative edits, ~1000 tok/s) + search/replace | **apply_patch V4A** (diff multi-archivo anclado por contexto, freeform) |
| Búsqueda | **Grep-first, sin índice** (ripgrep) | **Híbrido**: embeddings propios + grep (+12.5%) | Shell-first (`rg`) |
| Contexto largo | Compactación multicapa (microcompact→resumen) + CLAUDE.md re-inyectado | Índice + subagente Explore + resumen | **Compactación server-side** (`encrypted_content`) + AGENTS.md |
| Verificación | Bash tests/lint en el mismo loop + hooks | Terminal + diagnósticos LSP del IDE + Bugbot | **Sandbox OS-nativo** → tests autónomos por defecto |
| Planificación | TodoWrite + plan mode + subagentes | Plan mode editable + TODOs + Explore | Tool `update_plan` (checklist viva) |
| Permisos | allow/deny/ask por tool + modos + `canUseTool` | Allowlist de comandos + auto-run | Sandbox por SO + 3 modos de aprobación |
| Checkpoints | Snapshot pre-edit + `/rewind` (código y/o conversación) | Checkpoint por request + Restore en el chat | Diffs por turno + git en contenedor |
| UI | Timeline de tools + todos + diffs en terminal | Diffs inline editables + timeline + review panel | Eventos tipados JSON-RPC → checklist + diffs |
| Embebible | **Sí — Agent SDK oficial** | No | Parcial (Codex SDK/exec, más limitado) |

**Convergencias del género** (lo que "funcionar como Claude Code" significa): (1) loop simple dirigido por el modelo con budgets en código; (2) edits por anclaje de contenido con fallo ruidoso y reintento; (3) grep-first, embeddings solo como complemento opcional; (4) verificación = correr comandos reales y leer errores dentro del mismo loop; (5) plan/todo visible y re-inyectado; (6) eventos tipados con seq para la UI; (7) checkpoints por turno con rollback.

---

## 6. Qué debemos implementar en SiraGPT

Contexto actual: `/code` APPS ya tiene motor OpenCode/host-runner con write/edit, tiers de generación (motor → streaming fenced → determinista), runner Bun con preview, y en el backend ya existen `agent-harness/` (event-stream tipado con seq, permission-manager, tool-registry, MCP), `prompted-tool-calling`, `react-agent`, y Codex V2 (`agent-loop.js`, `checkpoint-service.js` con git real, `run-timeline.tsx`). Muchas piezas existen: la brecha es **cablearlas al loop de /code** y cerrar el ciclo de verificación.

### P0 — sin esto no "funciona como Claude Code"

| # | Recomendación | Inspiración | Detalle | Esfuerzo |
|---|---|---|---|---|
| P0.1 | **Edit tool str_replace exacto con read-before-edit** en el workspace del runner | Claude Code `Edit` | Tools `read_file` (con líneas numeradas), `edit_file` (`old_string` único byte-exacto, error si no-único/no-match, `replace_all`) y `write_file`. Guardar hash del archivo al leer; rechazar edit si cambió (staleness). Error legible → el modelo reintenta. Hoy el streaming fenced reescribe archivos completos: caro y propenso a truncar. | 2-3 días |
| P0.2 | **Loop de verificación cerrado**: correr → leer errores → autocorregir | Claude Code (bash-in-loop), Codex (tests en sandbox) | Tool `run_command` acotada al workspace (bunx tsc --noEmit, bun run build, vite build) + capturar stderr del dev server/preview y devolverlo como tool-result. Budget en código: máx. N iteraciones de fix (p.ej. 3), luego reportar honesto. El system prompt exige verificar antes de declarar éxito. Ya observan runtime errors en el roadmap /code — esto lo convierte en input del modelo. | 3-5 días |
| P0.3 | **Grep/Glob en el workspace** (grep-first, sin índice) | Claude Code "Search, don't index" | `grep` (ripgrep sobre el proyecto generado, con límite de matches) y `glob`. Marcarlas read-only → paralelizables. Imprescindible cuando el usuario itera sobre una app ya generada ("cambia el color del header"): hoy el modelo no puede localizar código. NO construir índice de embeddings todavía (Cursor demuestra que solo paga en repos 1000+ archivos; las apps de /code son pequeñas). | 1-2 días |
| P0.4 | **Compactación del hilo de /code** | Claude Code multicapa, Codex nativa | Capa 1: truncar tool-results viejos (conservar los últimos 3-5 completos, resto a "resumen + recuperable por re-read"). Capa 2: al ~70% del contexto, resumir el historial preservando: objetivo, archivos tocados, decisiones, errores pendientes (checklist estilo CLAUDE.md summary instructions). Emitir evento `compact_boundary` en el timeline. | 2-4 días |

### P1 — paridad de experiencia

| # | Recomendación | Inspiración | Detalle | Esfuerzo |
|---|---|---|---|---|
| P1.1 | **Plan/Todo tool + checklist viva en la UI** | TodoWrite (Claude Code), `update_plan` (Codex) | Tool `update_plan` con items {texto, estado}; re-inyectar el plan como system-reminder cada N turnos para que el modelo no lo abandone. Codex V2 ya tiene checklist-tab y plan-mode — reutilizar componentes para /code. | 2-3 días |
| P1.2 | **Checkpoints por turno + rollback en /code** | `/rewind` (Claude Code), Restore checkpoint (Cursor) | `checkpoint-service.js` (git real, commit/rollback/diff) ya existe en Codex V2 — cablearlo al chat de /code: commit automático tras cada turno con edits, chip "Restaurar" en cada mensaje, diffstat visible. | 2-3 días |
| P1.3 | **Timeline de tool calls unificado con eventos seq** | Codex Item/Turn/Thread, AgentTrace propio | Ya existen `agent-trace.tsx` y `run-timeline.tsx` (dedupe por seq, replay SSE). Unificar: cada tool call del agente de /code como fila con args/resultado colapsable, estados started→completed, error en rojo. Mostrar diffs por archivo (antes/después del edit) como hace Cursor. | 3-4 días |
| P1.4 | **Permisos por tier en /code** | permission-manager propio + acceptEdits (SDK) | Reusar `agent-harness/permission-manager.js`: edits y comandos de build = auto (equivale a `acceptEdits` dentro del sandbox del runner); comandos fuera de allowlist (rm -rf, curl a externos, install de paquetes no whitelisted) = confirmación inline. | 1-2 días |
| P1.5 | **Formato de edit por familia de modelo** | apply_patch V4A vs str_replace | En `prompted-tool-calling`/`llm-turn`: si el modelo es GPT-family → aceptar formato patch V4A; Claude/otros → str_replace. Ya hay escalera native/prompted; esto añade la dimensión "dialecto de edición" (documentado por Warp: cada familia rinde mejor con su formato de entrenamiento). | 2-3 días |
| P1.6 | **Subagente de exploración barato** | Explore (Claude Code/Cursor) | Para "analiza este proyecto y dime cómo añadir X": subagente con solo read/grep/glob y modelo barato (FlashGPT/Haiku), que devuelve resumen al hilo principal. Ya existe `agent-collaboration.js` (fork-join). | 2-3 días |

### P2 — diferenciación / largo plazo

| # | Recomendación | Inspiración | Detalle | Esfuerzo |
|---|---|---|---|---|
| P2.1 | **Claude Agent SDK como motor enterprise** (ver §7) | Agent SDK | Tier premium de /code y producto "agente en el repo del cliente": el SDK trae loop+edits+compaction+checkpoints+permisos ya resueltos con calidad Claude Code. Nuestro backend orquesta workspaces, auth, billing y UI. | 1-2 semanas MVP |
| P2.2 | **AGENTS.md/CLAUDE.md por proyecto generado** | CLAUDE.md / AGENTS.md | Al generar una app, emitir un `AGENTS.md` (stack, convenciones, comandos build/test). Inyectarlo en cada turno de iteración (prompt-cacheable) → sobrevive compactación. | 1 día |
| P2.3 | **Sandbox endurecido del runner** | Codex sandbox OS-nativo | Hoy el runner Bun ya aísla por docker; añadir: red egress limitada (registry npm + APIs whitelisted), FS solo workspace, límites CPU/mem por run. Prerrequisito para subir autonomía sin riesgo. | 1 semana |
| P2.4 | **Búsqueda semántica opcional** | Cursor semsearch | Solo si /code empieza a operar sobre repos grandes importados (feature "conecta tu repo"). Con repos <200 archivos, grep basta — evidencia de Cursor y Anthropic coincide. | descartar por ahora |
| P2.5 | **Prompt caching disciplinado del loop** | Claude Code / SDK | Auditar el system prompt del agente de /code contra invalidadores silenciosos (timestamps, IDs por request, tools que cambian de orden). Con 30+ turnos por sesión, el ahorro es ~10× en el prefijo. | 1-2 días |

**Orden sugerido**: P0.1 → P0.3 → P0.2 → P1.3 (visibilidad) → P0.4 → P1.2 → P1.1 → resto. P0 completo ≈ 2 semanas de una persona y transforma la experiencia de "generador de scaffolds" a "agente que itera y se autocorrige".

---

## 7. Integrar el Claude Agent SDK en el backend Express (enterprise)

Escenario objetivo: un cliente empresa conecta su repo; SiraGPT levanta un workspace (clone en el runner o worktree) y expone un agente con calidad Claude Code sobre ese código, con permisos, presupuesto y auditoría controlados por nosotros.

### 7.1 Instalación y requisitos

```bash
npm install @anthropic-ai/claude-agent-sdk zod
# Node 18+. Autenticación: ANTHROPIC_API_KEY en el entorno del backend.
# El SDK lanza el runtime del agente como subproceso propio — no requiere CLI global.
```

### 7.2 Ruta Express con SSE (patrón que ya usamos en Codex V2)

```javascript
// backend/src/routes/enterprise-agent.js
const express = require('express');
const router = express.Router();

// SDK es ESM — import dinámico desde CommonJS
let sdk;
async function getSdk() {
  if (!sdk) sdk = await import('@anthropic-ai/claude-agent-sdk');
  return sdk;
}

// POST /api/enterprise-agent/runs  { workspaceId, prompt, sessionId? }
router.post('/runs', authenticate, async (req, res) => {
  const { workspaceId, prompt, sessionId } = req.body;
  const workspace = await workspaceService.resolve(req.user.id, workspaceId); // ownership + path

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const { query, tool, createSdkMcpServer } = await getSdk();
  const { z } = await import('zod');

  // Tool custom in-process: el agente puede pedir deploy de preview vía NUESTRO servicio
  const siraTools = createSdkMcpServer({
    name: 'siragpt',
    version: '1.0.0',
    tools: [
      tool(
        'deploy_preview',
        'Despliega el estado actual del workspace a un entorno de preview y devuelve la URL',
        { note: z.string().optional() },
        async () => {
          const url = await previewService.deploy(workspace.id);
          return { content: [{ type: 'text', text: `Preview: ${url}` }] };
        },
      ),
    ],
  });

  const abort = new AbortController();
  req.on('close', () => abort.abort()); // el cliente corta → interrumpimos el agente

  try {
    const run = query({
      prompt,
      options: {
        model: 'claude-sonnet-4-6',
        cwd: workspace.path,                    // el agente SOLO ve el workspace
        resume: sessionId,                      // continuidad multi-turno
        allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
        disallowedTools: ['WebSearch', 'WebFetch'], // sin egress por defecto
        permissionMode: 'default',
        settingSources: ['project'],            // respeta el CLAUDE.md del repo del cliente
        maxTurns: 40,
        maxBudgetUsd: Number(process.env.ENTERPRISE_AGENT_MAX_USD || 3),
        effort: 'high',
        enableFileCheckpointing: true,          // rollback por turno
        mcpServers: { siragpt: siraTools },
        abortController: abort,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },

        // Gate programático por tool call — nuestro permission-manager decide
        canUseTool: async (toolName, input) => {
          const verdict = await permissionPolicy.evaluate(req.user, workspace, toolName, input);
          if (verdict.allow) return { behavior: 'allow' };
          return { behavior: 'deny', message: verdict.reason };
        },

        hooks: {
          PostToolUse: [{
            hooks: [async (hookInput) => {
              await auditLog.record(req.user.id, workspace.id, hookInput); // auditoría enterprise
              return {};
            }],
          }],
        },
      },
    });

    for await (const message of run) {
      switch (message.type) {
        case 'system':
          if (message.subtype === 'init') send('session', { sessionId: message.session_id });
          if (message.subtype === 'compact_boundary') send('compacted', {});
          break;
        case 'assistant':
          for (const block of message.message.content) {
            if (block.type === 'text') send('text', { text: block.text });
            if (block.type === 'tool_use') send('tool_call', { name: block.name, input: block.input });
          }
          break;
        case 'user':
          send('tool_result', { content: message.message.content });
          break;
        case 'result':
          send('done', {
            subtype: message.subtype,          // success | error_max_turns | error_max_budget_usd | ...
            result: message.subtype === 'success' ? message.result : null,
            costUsd: message.total_cost_usd,
            turns: message.num_turns,
            sessionId: message.session_id,     // persistir para resume
          });
          break;
      }
    }
  } catch (err) {
    send('error', { message: err.message });
  } finally {
    res.end();
  }
});

module.exports = router;
```

### 7.3 Decisiones de arquitectura para el caso enterprise

- **Un workspace = un `cwd`**: el aislamiento primario es el directorio (+ el sandbox del runner). Nunca compartir `cwd` entre tenants; para repos del cliente, clonar en volumen por-tenant.
- **Sesiones**: persistir `session_id` en Postgres junto al run (como CodexRun); `resume` restaura todo el contexto (archivos leídos, decisiones). `forkSession: true` para "probar otro enfoque" sin perder la rama original. `sessionStore` permite espejar transcripts a nuestro storage para auditoría/compliance.
- **Permisos en dos capas**: `allowedTools`/`disallowedTools` como política gruesa + `canUseTool` conectado a nuestro `permission-manager` para decisiones finas por usuario/plan (y para pausar esperando confirmación humana, igual que el flujo `permission_request` que ya tenemos: se resuelve la promesa del callback cuando el usuario contesta).
- **Costes**: `maxBudgetUsd` como corte duro por run + `total_cost_usd` del `ResultMessage` alimentando el sistema de créditos (`feature-cost-estimator`). Sonnet 4.6 ($3/$15) por defecto; Opus 4.8 como tier premium; subagentes de exploración en Haiku vía `agents: { explorer: { model: 'claude-haiku-4-5', tools: ['Read','Grep','Glob'], ... } }`.
- **Streaming fino**: `includePartialMessages: true` para deltas token a token (`StreamEvent`) si la UI quiere texto vivo; sin él, se recibe turno a turno.
- **Producción**: `startup()` pre-calienta el subproceso (primer query sin latencia de arranque); `query.interrupt()` para el botón "detener"; hooks `PreToolUse` para bloquear comandos peligrosos de forma determinista además del `canUseTool`.
- **Alternativa hosted**: para no operar los contenedores, la API de **Managed Agents** de Anthropic (beta `managed-agents-2026-04-01`) corre loop + sandbox del lado de Anthropic (agent → environment → sessions con SSE, montaje de repos GitHub con git-proxy de tokens, vaults para credenciales). Trade-off: menos control/latencia de nuestra parte, cero infra. Para SiraGPT, el SDK self-hosted encaja mejor con el runner existente; Managed Agents es opción para clientes que exigen no tocar nuestra infra.

---

## 8. Fuentes principales

- Claude Code / Agent SDK: [How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop) · [TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript) · [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works) · [Checkpointing](https://code.claude.com/docs/en/checkpointing) · [Dive into Claude Code (VILA-Lab)](https://github.com/VILA-Lab/Dive-into-Claude-Code) · [Compaction deep dive](https://decodeclaude.com/compaction-deep-dive/) · [Claude Code architecture analysis](https://bits-bytes-nn.github.io/insights/agentic-ai/2026/03/31/claude-code-architecture-analysis.html)
- Cursor: [Improving agent with semantic search](https://cursor.com/blog/semsearch) · [Fast Apply con speculative decoding (Fireworks)](https://fireworks.ai/blog/cursor) · [Agent tools: search](https://cursor.com/docs/agent/tools/search) · [Checkpoints](https://cursor.com/docs/agent/chat/checkpoints) · [Reviewing code](https://cursor.com/docs/agent/review)
- Codex: [Unrolling the Codex agent loop (OpenAI)](https://openai.com/index/unrolling-the-codex-agent-loop/) · [How OpenAI built Codex (SWE Quiz)](https://www.swequiz.com/articles/openai-codex-architecture) · [apply_patch V4A instructions (repo)](https://github.com/openai/codex/blob/main/codex-rs/apply-patch/apply_patch_tool_instructions.md) · [Sandboxing](https://developers.openai.com/codex/concepts/sandboxing) · [AGENTS.md](https://developers.openai.com/codex/guides/agents-md) · [Introducing GPT-5.2-Codex](https://openai.com/index/introducing-gpt-5-2-codex/) · [Codex models in Warp (formato por familia)](https://www.warp.dev/blog/codex-models-in-warp-apply-patch-and-prompting-changes)

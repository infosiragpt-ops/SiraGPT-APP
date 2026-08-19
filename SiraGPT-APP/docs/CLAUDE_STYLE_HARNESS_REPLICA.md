# Réplica del software de Claude con cualquier modelo LLM

> Guía de arquitectura para replicar la experiencia de **claude.ai (chat)**,
> **Claude Cowork** y **Claude Code** en siraGPT, con foco en el **arnés
> agéntico model-agnostic**: que cualquier modelo (OpenRouter, DeepSeek,
> OpenAI, Gemini, Cerebras…) se sienta como Claude.
>
> Basada en fuentes primarias de Anthropic (Building Effective Agents,
> Effective Context Engineering, Writing Tools for Agents, Advanced Tool Use,
> Claude Agent SDK, Code Execution with MCP, sandboxing) y en el paper
> SWE-agent (arXiv:2405.15793, las "Agent-Computer Interfaces"), más el
> estado del arte 2025-2026 sobre agent harnesses (arXiv:2605.26112,
> arXiv:2605.18747, Confucius arXiv:2512.10398).

## 0. La tesis: el arnés ES el producto

La evidencia 2025-2026 es consistente: **el mismo modelo rinde radicalmente
distinto según el arnés**. SWE-agent subió de 3.8% → 12.47% en SWE-bench sin
tocar el modelo, solo rediseñando la interfaz agente-computadora. GPT-5.5 saltó
+25.7 puntos al cambiar de un harness a otro (Endor Labs). Claude Code son
~512k líneas de código donde la llamada al modelo es una fracción mínima.

**Agent = Model + Harness.** Como siraGPT quiere ser model-agnostic, todo el
valor diferencial vive en el arnés. Lo que el usuario percibe como "Claude" es
en realidad: el loop, las herramientas, el manejo de contexto, la verificación,
el streaming de estado y la UI de confianza (thinking, tool trace, citas).

## 1. Qué tiene el software de Claude, pieza por pieza

### 1.1 claude.ai (chat) — y su equivalente en siraGPT

| Pieza de claude.ai | Cómo lo hace Anthropic | Equivalente siraGPT |
|---|---|---|
| **Extended thinking visible** (header "Thinking…", trace colapsable, "Thought for Ns") | Bloques `thinking` de la API, streameados antes del texto; thinking firmado para reanudar tool-use | `reasoning_delta`/`reasoning_done` SSE + `ThinkingTrace` (este PR). OpenRouter normaliza el thinking de CUALQUIER proveedor en `reasoning: {effort}` |
| **Tool use trace** (pasos legibles: "Searching the web…", chips con args) | tool_use blocks + UI de timeline | `agentic-steps.tsx` (timeline de pasos) + `tool_call_delta` (este PR) |
| **Artifacts** (código/HTML interactivo en panel) | Bloque especial + sandbox iframe | `InteractiveArtifact` + `extractArtifact` (ya existe) |
| **Memoria** | Memory tool (directorio `/memories` gestionado por el cliente) | `active-memory.js` + `memory_recall` (ya existe) |
| **Citas/fuentes** | Pase de citas separado al final | `web_sources` frame + `SourcesChip` (ya existe) |
| **Projects** (contexto persistente por proyecto) | System prompt + archivos por proyecto | `project-memory.js` (ya existe) |

**Cómo se replica el thinking con cualquier modelo** (lo implementado aquí):

1. **Petición**: el router multi-proveedor decide por modelo. OpenRouter →
   `reasoning: { effort: "medium" }` solo si el modelo lo soporta (flag del
   catálogo + allowlist de familias + env `SIRAGPT_OPENROUTER_REASONING_FORCE/BLOCK`).
   DeepSeek → `thinking: {type:"enabled"}` + `reasoning_effort`. Modelos sin
   soporte → se omite el parámetro (un modelo que no lo conoce devolvería 400).
2. **Stream**: el handler SSE reenvía tipado en el mismo stream:
   `{type:"reasoning_delta", reasoning}` → `{type:"reasoning_done", durationMs}`
   → `{type:"text_delta", content}` (+ `{type:"tool_call_delta", name, argsDelta}`).
   Regla de compatibilidad: el campo del razonamiento NUNCA se llama `content`,
   así un cliente viejo lo ignora en vez de pegarlo a la respuesta.
3. **Persistencia**: columnas `reasoning` (text) y `reasoning_details` (jsonb)
   en `messages`. El array crudo `reasoning_details` de OpenRouter se reenvía
   INTACTO en el historial de turnos posteriores cuando el modelo es Anthropic
   (la cadena de thinking va firmada; romperla rompe el tool-use multiturno).
   El sanitizador de la gateway lo quita para cualquier otro proveedor.
4. **UI**: header shimmer "Pensando…" expandido mientras streamea, markdown con
   auto-scroll anclado al fondo, tool calls como timeline, y al cerrar se
   auto-colapsa a "Pensó durante 12 s · primera oración…".

### 1.2 Claude Code — el arnés de agente serio

Los componentes que lo definen (y dónde está cada uno en siraGPT):

1. **Agent loop**: gather context → take action → verify → repeat, con
   `maxTurns` y presupuesto. siraGPT: `react-agent.js` (loop ReAct con
   maxSteps=24, runtime budget 5min, finalize guard).
2. **ACI / higiene de observaciones** (las 4 reglas de SWE-agent, todas con
   impacto medido):
   - acciones simples y compactas (una tool = una operación de alto nivel);
   - feedback informativo pero conciso — **truncado explícito con instrucción
     de refinar, nunca un slice silencioso** (siraGPT: `formatObservation`);
   - colapso de observaciones viejas — solo las últimas 5 rondas verbatim
     (siraGPT: `elideStaleObservations`);
   - guardrails que validan ANTES de aplicar y devuelven el error como
     feedback (siraGPT: linter-on-edit en `host_file`, finalize guard).
3. **Context engineering**: compaction al acercarse al límite (resumir
   preservando decisiones/errores/archivos tocados), memoria en archivos,
   sub-agentes con ventana limpia que devuelven resúmenes destilados.
   siraGPT: `compactMessages` (60k chars), `session_spawn`, `conversation-summarizer`.
4. **Herramientas**: pocas y de alta señal; truncado ~25k tokens; ejemplos de
   uso en la definición (+18 pts de precisión en args); tool search/deferred
   loading cuando hay cientos (−85% tokens). siraGPT: ~50 tools en
   `agent-tools.js` + presupuestos por tool en `tool-manifest.js`.
5. **Permisos/sandbox**: clasificar cada tool por riesgo; las irreversibles
   (pagos, borrados, deploys, envíos) pausan el loop y piden confirmación
   (evento SSE `confirmation_required` + estado persistido). Ejecución de
   código solo en sandbox. siraGPT: `code-sandbox.js`, `toolGate`/clearance.
6. **Verificación**: jerarquía reglas > visual > LLM-judge. El loop
   "editar → correr tests → corregir" es el verificador dominante. siraGPT:
   `run_tests`, `verify_artifact`, quality gates del agent-task.
7. **Plan-then-execute**: modo plan explícito + todo list visible y
   actualizable (es memoria de plan, no decoración). siraGPT: parcial —
   el system prompt del ReAct ahora exige plan de una línea; falta un
   `plan_task` tool con todo list renderizada en el timeline.

### 1.3 Claude Cowork — agente para no-programadores

Patrón: el MISMO arnés de Claude Code (loop + tools + permisos) con otra capa
de presentación: workspace de archivos del usuario, tareas paralelas con
progreso visible, resultados como documentos/hojas en vez de diffs. La lección
para siraGPT: **no construyas dos agentes; construye un arnés y dos UIs**
(chat conversacional + `/code` workspace, que ya existe como Codex IDE).

## 2. El arnés model-agnostic: las 7 capas

Para que cualquier modelo "se sienta Claude", el arnés debe absorber las
diferencias de proveedor en capas bien definidas (todas existen ya en siraGPT;
esta tabla es el mapa de mantenimiento):

1. **Normalización de petición** — `litellm-gateway.buildProviderChatPayload`:
   un solo builder que conoce `thinkingFormat` (openai/deepseek/openrouter),
   campos de max tokens, response_format, y ahora `reasoning` por modelo.
2. **Normalización de stream** — `generateStream`: lee
   `delta.reasoning_content` (DeepSeek) y `delta.reasoning` (OpenRouter) y
   emite UN solo dialecto SSE tipado hacia el frontend.
3. **Tool calling en escalera** — `resolveToolCallMode`: nativo (tool_calls
   OpenAI-style) → prompted (tools descritas en system prompt, JSON parseado)
   → none. Así un modelo sin function calling sigue siendo agente.
4. **Historial portable** — el sanitizador quita campos específicos de un
   proveedor antes de mandar el historial a otro (reasoning_content,
   reasoning_details) y los conserva donde son obligatorios.
5. **Resiliencia** — circuit breaker por (provider, model), fallback chain,
   first-byte timeout, retry con backoff. El usuario nunca ve un proveedor caído.
6. **Failover de identidad** — el system prompt y el contrato de formato
   viven en el arnés, no en el modelo: cambiar de modelo no cambia la voz
   del producto.
7. **Observabilidad** — spans por turno (tokens, duración, modelo real),
   y ahora `reasoningDurationMs` por mensaje.

## 3. Hoja de ruta (prioridad por impacto medido)

1. ✅ **`update_plan` + todo list visible** (plan-then-execute): tool en
   `agents/agent-plan-verify.js`, plan fijado como step del timeline que se
   actualiza en vivo (✓ / ▸ / ·); el system prompt exige plan primero en
   tareas multi-paso.
2. ✅ **Verificación evaluator-optimizer en el finalize guard**
   (`createAnswerVerifier`): un pase de juez por run rechaza borradores que
   no responden / inventan / sub-entregan, con instrucciones de reparación;
   acotado (1 rechazo máx), fail-open, gate `SIRAGPT_AGENT_VERIFY=0`. Se
   encadena tras el gate determinista de requiredTools
   (`composeFinalizeGuards`: reglas primero, juez después).
3. ✅ **Tool search / deferred loading** (`react-agent` `deferredTools` +
   meta-tool `search_tools`): el schema arranca con el core
   (`CORE_AGENT_TOOL_NAMES` + requiredTools + media intent) y el resto se
   activa por búsqueda de capacidad; el schema (y el bloque prompted) se
   refresca al paso siguiente. Rollout con `SIRAGPT_TOOL_DEFER=1`
   (default off hasta validar en prod).
4. **Compaction estilo Claude Code**: al 80% de la ventana, resumir
   preservando decisiones arquitectónicas + bugs abiertos + últimos 5 tool
   results, y reiniciar el trace.
5. **Confirmación human-in-the-loop para tools irreversibles** vía evento
   SSE `confirmation_required` con estado persistido (patrón PreToolUse).
6. **Calibración empírica**: leer trayectorias reales (`AgentTaskEvent`),
   clasificar modos de fallo con un LLM-judge y ajustar los caps (8000 chars
   de observación, 5 rondas de aging) con datos propios — la meta-lección de
   SWE-agent es que la ACI se diseña midiendo, no opinando.

## 4. Referencias

- SWE-agent / ACI: https://arxiv.org/abs/2405.15793
- Building effective agents: https://www.anthropic.com/engineering/building-effective-agents
- Effective context engineering: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Writing tools for agents: https://www.anthropic.com/engineering/writing-tools-for-agents
- Advanced tool use (tool search, ejemplos): https://www.anthropic.com/engineering/advanced-tool-use
- Claude Agent SDK: https://claude.com/blog/building-agents-with-the-claude-agent-sdk
- Multi-agent research system: https://www.anthropic.com/engineering/multi-agent-research-system
- Code execution with MCP: https://www.anthropic.com/engineering/code-execution-with-mcp
- Sandboxing: https://www.anthropic.com/engineering/claude-code-sandboxing
- Scaling the harness: https://arxiv.org/abs/2605.26112 · Code as harness: https://arxiv.org/abs/2605.18747
- OpenRouter reasoning param: https://openrouter.ai/docs/use-cases/reasoning-tokens

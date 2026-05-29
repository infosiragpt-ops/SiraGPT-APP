/**
 * agentic-chat-stream — wraps the react-agent loop into the same SSE
 * contract the main chat route already speaks (`{content}` / `{replace}`
 * / `[DONE]`), so the chat UI can show a step trace + final answer
 * without any frontend changes beyond honoring the agent-task-state
 * sentinel it already renders.
 *
 * Why this module instead of inlining the loop in ai.js:
 *   - The chat route is huge and already juggles many concerns; this
 *     keeps the agentic path testable in isolation.
 *   - The same wrapper is reusable from any route that already speaks
 *     SSE in the same dialect (slash commands, regenerate, etc).
 *
 * SSE frames emitted by `runAgenticChat`:
 *   1. {replace, content}   — agent-task-state JSON sentinel block.
 *                              Re-emitted after every step transition
 *                              so the UI's AgenticStepsRenderer can
 *                              update its timeline in place.
 *   2. {type:'stage',label} — lightweight "buscando X" / "leyendo
 *                              fuente N de M" hints. The current chat
 *                              consumer ignores stage frames safely
 *                              (it only acts on content/replace), but
 *                              they're emitted for any future consumer
 *                              that wants the verbatim labels.
 *   3. {content}            — once the agent calls `finalize`, the
 *                              final markdown answer is streamed as
 *                              regular content chunks APPENDED to the
 *                              sentinel block, so the persisted bubble
 *                              ends up as `<sentinel>\n\n<answer>`.
 *
 * The caller is responsible for writing the `data: [DONE]\n\n` sentinel
 * itself (the chat route already does this after persisting the
 * message); pass `skipDoneSentinel: true` to keep parity with the
 * existing aiService.generateStream contract.
 */

const reactAgent = require('./react-agent');
const agentTools = require('./agents/agent-tools');
const conversationUnderstanding = require('./conversation-understanding');
const { cloneProjectTool } = require('./agents/clone-project-tool');
const { hostBashTool } = require('./agents/host-bash-tool');
const { hostFileTool } = require('./agents/host-file-tool');
const { checkCiStatusTool, monitorCiTool } = require('./agents/github-actions-tool');
const openclawCapabilityKernel = require('./openclaw-capability-kernel');
const { isAgenticActionRequest } = require('./agents/agentic-trigger');
const { detectMediaIntent, buildMediaIntentHint } = require('./agents/media-intent');
const {
  buildExecutionProfile,
  buildExecutionProfilePrompt,
  validateFinalize,
} = require('./agents/agentic-execution-profile');

const SENTINEL_FENCE_OPEN = '```agent-task-state\n';
const SENTINEL_FENCE_CLOSE = '\n```';

// Autonomous agents need more iterations for real work:
// - Repository clone + edit + test + commit + push can take 10+ steps
// - Research + web_search + read_url + verify can take 8+ steps
// - /goal tasks run until the agent decides they are done.
const DEFAULT_MAX_STEPS = 24;
// Per-turn wall clock. Extended for multi-file edits, npm install, and
// git operations that may include slow CI checks.
const DEFAULT_MAX_RUNTIME_MS = 5 * 60 * 1000;

const STAGE_LABELS = {
  web_search: (args) => `Buscando "${truncate(args?.query, 60)}"`,
  read_url:   (args) => `Leyendo ${prettyDomain(args?.url) || 'fuente'}`,
  memory_recall: (args) => `Recordando contexto sobre "${truncate(args?.query, 48)}"`,
  clone_project: (args) => `Clonando ${truncate(args?.url, 60)}`,
  host_bash: (args) => `Ejecutando ${truncate(args?.command, 60)}`,
  host_file: (args) => `Editando ${truncate(args?.path, 60)}`,
  git_commit_push: (args) => `Subiendo cambios a ${truncate(args?.branch || 'repo', 40)}`,
  git_workflow: (args) => `Git: ${truncate(args?.action || 'operación', 48)}`,
  rag_retrieve: (args) => `Consultando documentos sobre "${truncate(args?.query, 48)}"`,
  self_rag_answer: () => 'Construyendo respuesta grounded',
  docintel_analyze: () => 'Analizando documentos adjuntos',
  docintel_retrieve: () => 'Recuperando evidencia documental',
  docintel_extract_tables: () => 'Extrayendo tablas',
  docintel_compare: () => 'Comparando documentos',
  deep_analyze: () => 'Analizando contenido en profundidad',
  auto_file: () => 'Archivando contenido como documento',
  compare_documents: () => 'Comparando documentos',
  python_exec: () => 'Ejecutando Python',
  bash_exec: () => 'Ejecutando JavaScript aislado',
  create_document: (args) => `Creando ${truncate(args?.filename || 'archivo', 48)}`,
  generate_image: (args) => `Generando imagen${args?.prompt ? `: ${truncate(args.prompt, 40)}` : ''}`,
  generate_video: (args) => `Generando video${args?.prompt ? `: ${truncate(args.prompt, 40)}` : ''}`,
  generate_speech: () => 'Generando audio (voz)',
  generate_music: (args) => `Componiendo música${args?.prompt ? `: ${truncate(args.prompt, 36)}` : ''}`,
  create_chart: (args) => `Creando gráfica${args?.title ? `: ${truncate(args.title, 40)}` : ''}`,
  verify_artifact: () => 'Verificando archivo generado',
  run_tests: () => 'Ejecutando pruebas',
  npm_install: () => 'Instalando dependencias',
  commit_changes: () => 'Haciendo commit de cambios',
  push_changes: () => 'Subiendo cambios a GitHub',
  monitor_ci: () => 'Esperando verificación CI en verde',
  check_ci_status: () => 'Verificando estado de CI',
  create_pr: () => 'Creando Pull Request',
  finalize:   () => 'Componiendo respuesta',
};

function truncate(s, n) {
  if (!s) return '';
  const str = String(s);
  return str.length <= n ? str : str.slice(0, n - 1) + '…';
}

function prettyDomain(url) {
  if (!url) return '';
  try { return new URL(String(url)).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

function safeArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw || '{}')); }
  catch { return {}; }
}

function textFromMessageContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(p => (p && p.type === 'text') ? p.text : '')
      .filter(Boolean)
      .join(' ');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    try { return JSON.stringify(content); } catch { return ''; }
  }
  return '';
}

function buildThreadWorkContext(history, userQuery) {
  const normalized = conversationUnderstanding.normalizeHistory(history || []);
  const recentTurns = normalized.slice(-18).map(m => {
    const tag = m.role === 'assistant' ? 'ASSISTANT' : (m.role === 'system' ? 'SYSTEM' : 'USER');
    return `${tag}: ${truncate(m.content, 900)}`;
  }).join('\n');

  const goals = conversationUnderstanding.extractLikelyUserGoals(normalized, userQuery, 8);
  const lines = [
    'Treat this chat thread as an ongoing autonomous work session, not as an isolated Q&A turn.',
    'Infer the user intent from the full thread, including spelling mistakes and corrections. Continue the task unless an external irreversible action needs explicit confirmation.',
    'Before finalizing, check whether the request requires tool use, recent facts, repository context, or step-by-step execution. Use the available tools when they materially improve the answer.',
    'If a requested action needs a tool that is not available in this runtime, state that limitation briefly and provide the closest executable next step instead of pretending it was done.',
  ];

  if (goals.length) {
    lines.push('', 'Standing user goals inferred from this thread:', ...goals.map(goal => `- ${truncate(goal, 900)}`));
  }
  if (recentTurns) {
    lines.push('', 'Recent thread context:', recentTurns);
  }
  return lines.join('\n');
}

function stageLabelFor(toolName, args) {
  const fn = STAGE_LABELS[toolName];
  if (fn) return fn(args) || toolName;
  return `Ejecutando ${toolName}`;
}

/**
 * Whether the named provider+model supports OpenAI-style tool calling.
 * The agentic loop relies on `tool_calls` in the model response, so
 * non-function-calling models (older OSS, Anthropic without the tools
 * shim, etc.) must skip this path and fall through to plain streaming.
 *
 * We intentionally keep this allowlist conservative — being wrong here
 * means turning the feature OFF for that model, not crashing.
 */
function modelSupportsFunctionCalling(provider, model) {
  const p = String(provider || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  if (p === 'openai') {
    return /^(gpt-4|gpt-4o|gpt-4\.1|gpt-5|o3|o4|chatgpt|gpt-3\.5-turbo-1106|gpt-3\.5-turbo-0125)/i.test(m);
  }
  if (p === 'gemini') {
    return /^gemini-(1\.5|2|2\.5|3)/i.test(m);
  }
  if (p === 'deepseek') {
    return /^deepseek-(v\d|chat|reasoner)/i.test(m);
  }
  if (p === 'openrouter') {
    // OpenRouter normalises tools across providers; the safe bets are
    // the same families as above when surfaced through OpenRouter.
    return /(openai\/(gpt-4|gpt-4o|gpt-4\.1|gpt-5|o3|o4)|google\/gemini-(1\.5|2|2\.5|3)|deepseek\/|moonshotai\/kimi-k2\.6)/i.test(m);
  }
  return false;
}

const SIMPLE_CHAT_PROMPT = /^\s*(hola|hi|hello|hey|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|gracias|thanks|ok|vale|listo|perfecto|sí|si|no|test|prueba)[.!?¡¿\s]*$/i;
const AGENTIC_PROMPT_HINT = /\b(clon|repo|repositorio|github|git|commit|push|pr|pull ?request|deploy|despleg|codex|cursor|claude.?code|program|c[oó]digo|refactor|mejora|arregla|corrige|no.?funciona|no.?sirve|todav[ií]a|sigue|contin[uú]a|investiga|busca|fuentes?|cita|web|internet|actual|reciente|pdf|documento|archivo|excel|word|ppt|tabla|analiza|compara|genera.?archivo|descargable|aut[oó]nom|background|segundo.?plano|meses?|semanas?|\b\/goal\b|\b\/plan\b)\b/i;

/**
 * Decide whether a normal chat turn should enter the expensive agentic
 * loop. The loop is useful for repo work, current research, documents
 * and autonomous follow-ups; it is the wrong path for greetings and
 * simple Q&A because some providers can finish without a `finalize`
 * tool call, which previously surfaced the generic "no verificable"
 * fallback instead of a normal answer.
 */
function shouldUseAgenticChat({ prompt, history = [], files = [] } = {}) {
  const text = String(prompt || '').trim();
  if (!text) return false;
  if (SIMPLE_CHAT_PROMPT.test(text)) return false;
  if (Array.isArray(files) && files.length > 0) return true;
  if (/^\s*\/(goal|plan)\b/i.test(text)) return true;
  if (AGENTIC_PROMPT_HINT.test(text)) return true;
  // Bilingual create/transform detector — routes "genera una imagen",
  // "hazme un organigrama", "create a chart", "diseña una presentación",
  // etc. into the agentic runtime so the artifact tools actually fire.
  // AGENTIC_PROMPT_HINT covered repo/research/doc work but missed many
  // visual deliverables (images, charts, org charts, diagrams, slides).
  if (isAgenticActionRequest(text)) return true;

  const recent = Array.isArray(history)
    ? history.slice(-8).map((m) => textFromMessageContent(m && m.content)).join('\n')
    : '';
  if (recent && /\b(repo|github|commit|deploy|despleg|archivo|documento|pdf|excel|word|investiga|fuentes?|no.?funciona|todav[ií]a)\b/i.test(recent)) {
    return /\b(sigue|contin[uú]a|hazlo|dale|arregla|corrige|eso|todav[ií]a|no.?funciona|no.?sirve)\b/i.test(text);
  }

  return false;
}

function buildChatFinalizeProfile({ userQuery, fileIds = [], availableToolNames = new Set() } = {}) {
  const profile = buildExecutionProfile({ goal: userQuery, fileIds });
  if (SIMPLE_CHAT_PROMPT.test(String(userQuery || '').trim())) {
    return {
      ...profile,
      requiredTools: [],
      minimumToolCalls: {},
      qualityGates: [],
    };
  }
  const available = availableToolNames instanceof Set
    ? availableToolNames
    : new Set(Array.from(availableToolNames || []));
  const requiredTools = (profile.requiredTools || []).filter((tool) => available.has(tool));
  const minimumToolCalls = Object.fromEntries(
    Object.entries(profile.minimumToolCalls || {}).filter(([tool]) => requiredTools.includes(tool))
  );
  return {
    ...profile,
    requiredTools,
    minimumToolCalls,
  };
}

/**
 * Build the initial agent-task-state JSON the frontend's
 * AgenticStepsRenderer knows how to consume. Mirrors the shape used by
 * lib/agent-task-service.ts `initialAgentState` so the existing
 * reducers / renderers work without modification.
 */
function freshState(toolNames = ['web_search', 'read_url']) {
  return {
    meta: { goal: '', model: '', tools: toolNames },
    steps: [],
    artifacts: [],
    approvals: [],
    checkpoints: [],
    qualityGates: [],
    repairs: [],
    finalText: '',
    done: false,
  };
}

function serializeSentinel(state) {
  // The renderer round-trips this through JSON.parse, so we deliberately
  // cap the payload — long observation strings would otherwise inflate
  // the persisted message body without helping the UI.
  return SENTINEL_FENCE_OPEN + JSON.stringify(state) + SENTINEL_FENCE_CLOSE;
}

async function writeSse(res, payload) {
  if (res.writableEnded) return;
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    /* socket gone */
  }
}

/**
 * Run an agentic chat turn end-to-end and stream the result over `res`.
 *
 * @param {object}  opts
 * @param {object}  opts.openai     — instantiated OpenAI client (provides chat.completions.create)
 * @param {string}  opts.model      — concrete model id, e.g. "gpt-4o-mini"
 * @param {string}  opts.userQuery  — the user's prompt for this turn
 * @param {Array}   opts.history    — prior chat messages [{role,content}]
 * @param {object}  opts.res        — express Response, already SSE-headered
 * @param {AbortSignal} [opts.signal]
 * @param {number}  [opts.maxSteps=24]
 * @param {number}  [opts.maxRuntimeMs=300000]
 * @param {boolean} [opts.skipDoneSentinel=true]
 * @param {object}  [opts.toolsOverride] — for tests; defaults to
 *                                          the production chat toolset.
 * @param {object}  [opts.toolContext]   — per-request context passed to tools.
 * @returns {Promise<{finalAnswer:string, stoppedReason:string, steps:Array}>}
 */
async function runAgenticChat(opts) {
  const {
    openai,
    model,
    userQuery,
    history = [],
    res,
    signal,
    maxSteps = DEFAULT_MAX_STEPS,
    maxRuntimeMs = DEFAULT_MAX_RUNTIME_MS,
    skipDoneSentinel = true,
    toolsOverride = null,
    toolContext = {},
  } = opts || {};

  if (!openai) throw new Error('runAgenticChat: openai client is required');
  if (!model)  throw new Error('runAgenticChat: model is required');
  if (!userQuery) throw new Error('runAgenticChat: userQuery is required');
  if (!res) throw new Error('runAgenticChat: res is required');

  const tools = toolsOverride || buildDefaultTools({ userQuery });
  const availableToolNames = new Set(tools.map((tool) => tool && tool.name).filter(Boolean));
  // Bilingual media-intent detection: when the user asks to create an
  // image / video / audio / music in the chat bar, this pre-extracts the
  // specs (duration, aspect ratio, count, style/genre) and lets us inject a
  // directive so the agent reliably calls the matching tool with them.
  const mediaIntent = detectMediaIntent(userQuery);
  const executionProfile = buildChatFinalizeProfile({
    userQuery,
    fileIds: Array.isArray(toolContext.fileIds) ? toolContext.fileIds : [],
    availableToolNames,
  });
  const openclawProfile = openclawCapabilityKernel.buildCapabilityProfile({
    prompt: userQuery,
    userId: toolContext.userId || null,
    chatId: toolContext.chatId || null,
    attachmentCount: Array.isArray(toolContext.fileIds) ? toolContext.fileIds.length : 0,
    toolNames: tools.map((tool) => tool.name),
    recentTurnCount: Array.isArray(history) ? history.length : 0,
    model,
    context: {
      history,
      documents: Array.isArray(toolContext.fileIds)
        ? toolContext.fileIds.map((id) => ({ id, source: 'chat_attachment' }))
        : [],
      memoryFacts: Array.isArray(toolContext.memoryFacts) ? toolContext.memoryFacts : [],
      toolResults: [],
    },
  });
  const openclawRuntimeBlock = openclawCapabilityKernel.buildOpenClawPromptBlock(openclawProfile);

  const state = freshState(tools.map((tool) => tool.name));
  state.meta.goal = truncate(userQuery, 160);
  state.meta.model = model;
  state.meta.runtime = {
    name: 'openclaw-level',
    version: openclawProfile.version,
    reason: openclawProfile.routing.reason,
    capabilities: openclawProfile.capabilities,
  };
  state.meta.executionProfile = {
    version: executionProfile.version,
    requiredTools: executionProfile.requiredTools,
    minimumToolCalls: executionProfile.minimumToolCalls,
  };

  // Initial sentinel — gives the UI an immediate step indicator even
  // before the first model call returns.
  state.steps.push({
    id: 'agentic-start',
    label: 'Analizando la pregunta',
    icon: 'thought',
    status: 'running',
    toolCalls: [],
  });
  await writeSse(res, { replace: true, content: serializeSentinel(state) });

  // Build the prompt: prior chat history (already context-fit by the
  // caller) becomes the agent's extraSystem so the loop sees the
  // conversation but doesn't re-stream every turn.
  const historyForPrompt = (history || [])
    .filter(m => m && typeof m === 'object' && typeof m.content !== 'undefined')
    .slice(-18)
    .map(m => {
      const role = String(m.role || '').toLowerCase();
      const tag = role === 'assistant' ? 'ASSISTANT' : (role === 'system' ? 'SYSTEM' : 'USER');
      const txt = textFromMessageContent(m.content);
      return `${tag}: ${truncate(txt, 800)}`;
    })
    .join('\n');

  const isGoalCommand = /^\s*(\/goal|\/plan)\b/i.test(userQuery);
  const isRepoTask = /\b(clon|repo|github|git|commit|push|pr|pull ?request|deploy|despleg|codex|cursor|claude.?code|program|c[oó]digo|refactor|mejora|arregla|corrige)\b/i.test(userQuery);
  const isAutonomous = isGoalCommand || isRepoTask || /\b(meses?|semanas?|sin.?detene|no.?pare?s|background|segundo.?plano|auto.?ejecut|contin[uú]a.?trabajando|trabaja.?por.?meses|no.?funciona.?a[uú]n|todav[ií]a.?no.?funciona)\b/i.test(userQuery);

  const maxStepsOverride = isAutonomous ? Math.max(maxSteps, isGoalCommand ? 60 : 30) : maxSteps;
  const maxRuntimeOverride = isAutonomous ? Math.max(maxRuntimeMs, 15 * 60 * 1000) : maxRuntimeMs;

  const extraSystem = [
    'Responde SIEMPRE en español, con tono profesional y cercano. No uses emojis.',
    mediaIntent.kind ? buildMediaIntentHint(mediaIntent) : '',
    openclawRuntimeBlock,
    buildExecutionProfilePrompt(executionProfile),
    buildThreadWorkContext(history, userQuery),
    'Este hilo es una sesion agentica autónoma: decide, usa herramientas, observa resultados, corrige y finaliza solo cuando tengas una respuesta verificable o la tarea esté completa.',
    'Si el usuario dice "todavía no funciona", "sigue", "arregla", "no sirve", o similar, revisa TODO el historial del hilo para entender qué se pidió antes, qué se hizo, qué falló, y continúa desde donde se quedó. No empieces de cero.',
    'Cuando detectes que el usuario quiere hacer operaciones de repositorio (clonar, editar, commit, push, PR, deploy, CI), actúa como un coding agent completo:',
    '  1. Clona o localiza el repositorio usando `clone_project` o `host_bash` con git.',
    '  2. Comprende la estructura del proyecto.',
    '  3. Realiza los cambios necesarios editando archivos con `host_file` para cambios de texto y `host_bash` solo para comandos.',
    '  4. Ejecuta `npm test` o la suite de pruebas respectiva para verificar.',
    '  5. Si las pruebas pasan, haz `git add`, `git commit`, `git push` al repositorio.',
    '  6. Usa `check_ci_status` o `monitor_ci` para verificar GitHub Actions hasta verde; si CI falla, informa el fallo exacto y no afirmes que quedó en verde.',
    'Usa `memory_recall` cuando el pedido dependa de preferencias o contexto persistente del usuario.',
    'Usa `rag_retrieve`, `self_rag_answer` o `docintel_*` cuando el usuario mencione archivos, documentos, PDFs, tablas o conocimiento privado.',
    'Cuando la pregunta requiera información reciente, hechos verificables o cifras concretas, usa `web_search` y luego `read_url` sobre las mejores fuentes. Cita esas fuentes con enlaces markdown.',
    'Para calculos, transformaciones de datos o verificacion deterministica, usa `python_exec`. Cuando generes codigo no trivial, usa `run_tests` antes de finalizar.',
    'Cuando el usuario pida un archivo descargable, usa `create_document` y despues `verify_artifact`; no finalices si la verificacion muestra un archivo vacio o incorrecto.',
    'Cuando el usuario pida editar su Word/Excel/PPT/PDF subido, trata el archivo original como solo lectura: crea una nueva copia en el mismo formato, conserva estructura/logos/tablas/formulas/hojas/encabezados/diseño tanto como sea posible, y modifica solo lo solicitado.',
    'No afirmes que modificaste repositorios, GitHub o el filesystem local si ninguna herramienta disponible lo hizo realmente.',
    historyForPrompt ? `\nConversación previa (recortada):\n${historyForPrompt}` : '',
  ].filter(Boolean).join('\n');

  // Surface artifacts produced by media/visual/document tools into the
  // agent-task-state sentinel so generated images, videos, audio and music
  // render as downloadable, playable assets inside the chat bubble — without
  // any frontend change (the existing AgenticStepsRenderer already reads
  // state.artifacts). Tools emit `file_artifact` via ctx.onEvent.
  const seenArtifactIds = new Set();
  const upstreamOnEvent = typeof toolContext.onEvent === 'function' ? toolContext.onEvent : null;
  function onEvent(evt) {
    if (upstreamOnEvent) { try { upstreamOnEvent(evt); } catch (_) { /* best-effort */ } }
    try {
      if (!evt || evt.type !== 'file_artifact' || !evt.artifact || !evt.artifact.downloadUrl) return;
      const a = evt.artifact;
      const key = String(a.id || a.downloadUrl);
      if (seenArtifactIds.has(key)) return;
      seenArtifactIds.add(key);
      state.artifacts.push({
        id: String(a.id || key),
        filename: a.filename || 'archivo',
        mime: a.mime || 'application/octet-stream',
        format: a.format || null,
        sizeBytes: Number(a.sizeBytes) || 0,
        downloadUrl: a.downloadUrl,
        previewHtml: a.previewHtml || null,
        validation: a.validation || null,
      });
      writeSse(res, { replace: true, content: serializeSentinel(state) });
    } catch (_) { /* never let UI plumbing crash a tool */ }
  }

  let stepCounter = 0;
  const result = await reactAgent.run(openai, {
    query: userQuery,
    tools,
    model,
    maxSteps: maxStepsOverride,
    maxRuntimeMs: maxRuntimeOverride,
    extraSystem,
    ctx: { ...toolContext, signal, onEvent },
    finalizeGuard: executionProfile.requiredTools.length
      ? ({ steps }) => validateFinalize(executionProfile, steps)
      : null,
    onStepStart: async (stepRec) => {
      stepCounter += 1;
      // Mark the previous synthetic step done.
      const last = state.steps[state.steps.length - 1];
      if (last && last.status === 'running') last.status = 'done';

      // Project each tool call as its own visible step so the timeline
      // reads "buscando X → leyendo fuente N → componiendo respuesta".
      const actions = Array.isArray(stepRec?.actions) ? stepRec.actions : [];
      if (actions.length === 0) {
        state.steps.push({
          id: `step-${stepCounter}-think`,
          label: 'Pensando',
          icon: 'thought',
          status: 'running',
          toolCalls: [],
        });
      } else {
        actions.forEach((a, idx) => {
          const args = safeArgs(a?.args);
          const label = stageLabelFor(a?.tool, args);
          state.steps.push({
            id: `step-${stepCounter}-${idx}`,
            label,
            icon: 'thought',
            status: 'running',
            toolCalls: [{ tool: a?.tool || 'unknown' }],
          });
          // Lightweight stage event for any consumer that listens.
          writeSse(res, { type: 'stage', label, tool: a?.tool || 'unknown' });
        });
      }
      await writeSse(res, { replace: true, content: serializeSentinel(state) });
    },
    onStepDone: async (stepRec) => {
      // Walk the actions in reverse and attach status to the most-recent
      // matching running step so an output lines up with its start.
      const actions = Array.isArray(stepRec?.actions) ? stepRec.actions : [];
      for (let i = actions.length - 1; i >= 0; i--) {
        const a = actions[i];
        for (let j = state.steps.length - 1; j >= 0; j--) {
          const s = state.steps[j];
          if (s.status !== 'running') continue;
          if ((s.toolCalls[0] && s.toolCalls[0].tool) !== a?.tool) continue;
          const obs = a?.observation || {};
          const ok = !obs?.error;
          s.status = ok ? 'done' : 'error';
          s.toolCalls[0].output = { ok };
          break;
        }
      }
      await writeSse(res, { replace: true, content: serializeSentinel(state) });
    },
  });

  // Mark any leftover running steps as done — react-agent guarantees a
  // finalize on the last step, but defensive coding keeps stale running
  // states from leaking into the persisted sentinel.
  for (const s of state.steps) if (s.status === 'running') s.status = 'done';
  state.done = true;

  const finalAnswer = (result?.finalAnswer || '').trim()
    || 'No pude generar una respuesta verificable. Intenta reformular la pregunta.';
  state.finalText = finalAnswer;

  // Emit the final sentinel + the answer body in two frames so the UI
  // shows the completed timeline AND the streamed answer below it.
  await writeSse(res, {
    replace: true,
    content: serializeSentinel(state) + '\n\n' + finalAnswer,
  });

  if (!skipDoneSentinel) {
    if (!res.writableEnded) {
      try { res.write('data: [DONE]\n\n'); } catch { /* socket gone */ }
    }
  }

  return {
    finalAnswer,
    stoppedReason: result?.stoppedReason || 'finalized',
    steps: result?.steps || [],
  };
}

/**
 * Adapt an entry from `agent-tools` ({name, schema, handler}) to the
 * shape react-agent expects ({name, description, parameters, execute}).
 *
 * We supply explicit JSON Schemas here (rather than reading from the
 * skill manifest) because react-agent's OpenAI tool adapter expects
 * a full schema and the agent-tools entries only carry hint strings.
 */
function adaptAgentTool(tool, jsonSchema) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: jsonSchema,
    execute: async (args, _ctx) => tool.handler(args, _ctx),
  };
}

function baseWebTools() {
  return [
    // react-agent expects {name,description,parameters,execute(args,ctx)};
    // agent-tools entries use {schema,handler}. Adapt them inline.
    adaptAgentTool(agentTools.web_search, {
      type: 'object',
      properties: {
        query:      { type: 'string', description: 'Search query, 2-12 keywords.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 15, description: 'How many hits to return. Default 5.' },
        locale:     { type: 'string', description: 'BCP-47 hint, e.g. "es-es".' },
      },
      required: ['query'],
      additionalProperties: false,
    }),
    adaptAgentTool(agentTools.read_url, {
      type: 'object',
      properties: {
        url:      { type: 'string', description: 'Absolute http(s) URL to read.' },
        maxChars: { type: 'integer', minimum: 500, maximum: 50000, description: 'Markdown cap. Default 12000.' },
      },
      required: ['url'],
      additionalProperties: false,
    }),
  ];
}

function loadTaskTools() {
  try {
    // Lazy-load: document/media helpers are heavy and should not be
    // imported unless the agentic chat path actually runs.
    // eslint-disable-next-line global-require
    const taskTools = require('./agents/task-tools').INTERNAL;
    return [
      taskTools.memoryRecall,
      taskTools.ragRetrieve,
      taskTools.selfRagAnswer,
      taskTools.docintelAnalyze,
      taskTools.docintelRetrieve,
      taskTools.docintelExtractTables,
      taskTools.docintelCompare,
      taskTools.deepAnalyze,
      taskTools.autoFile,
      taskTools.compareDocuments,
      taskTools.pythonExec,
      taskTools.bashExec,
      taskTools.createDocument,
      taskTools.verifyArtifact,
      taskTools.runTests,
    ].filter(Boolean);
  } catch (err) {
    try { console.warn('[agentic-chat] task tools unavailable:', err && err.message); } catch (_) {}
    return [];
  }
}

/**
 * Lazily load the visual (image/video/chart/diagram) + audio (speech/music)
 * creation tools. These modules are heavy (visual-media-tools is ~8k lines)
 * so they are only required when a turn actually wants to create media.
 */
function loadMediaTools() {
  const out = [];
  try {
    // eslint-disable-next-line global-require
    const { VISUAL_MEDIA_TOOLS } = require('./agents/visual-media-tools');
    if (Array.isArray(VISUAL_MEDIA_TOOLS)) out.push(...VISUAL_MEDIA_TOOLS);
  } catch (err) {
    try { console.warn('[agentic-chat] visual media tools unavailable:', err && err.message); } catch (_) {}
  }
  try {
    // eslint-disable-next-line global-require
    const { AUDIO_MEDIA_TOOLS } = require('./agents/audio-media-tools');
    if (Array.isArray(AUDIO_MEDIA_TOOLS)) out.push(...AUDIO_MEDIA_TOOLS);
  } catch (err) {
    try { console.warn('[agentic-chat] audio media tools unavailable:', err && err.message); } catch (_) {}
  }
  return out;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.userQuery] when the turn is a create/transform/media
 *   request, the visual + audio/music creation tools are appended so the
 *   agent can actually produce the image/video/audio/music/chart the user
 *   asked for. For non-create turns (repo work, research) the toolset stays
 *   lean. Calling with no args keeps the legacy base toolset.
 */
function buildDefaultTools(opts = {}) {
  const base = [...baseWebTools(), ...loadTaskTools(), cloneProjectTool, hostBashTool, hostFileTool, checkCiStatusTool, monitorCiTool];
  const userQuery = opts && typeof opts.userQuery === 'string' ? opts.userQuery : '';
  const wantsMedia = !!userQuery && (isAgenticActionRequest(userQuery) || !!detectMediaIntent(userQuery).kind);
  const tools = wantsMedia ? [...base, ...loadMediaTools()] : base;
  const seen = new Set();
  return tools.filter((tool) => {
    if (!tool || !tool.name || seen.has(tool.name)) return false;
    seen.add(tool.name);
    return true;
  });
}

/**
 * Read the runtime feature flag for the agentic chat path. Agentic chat
 * is now the default for tool-capable models because otherwise normal
 * chat silently behaves like a plain completion. Operators can still
 * disable it without a deploy by setting either flag to false/0/off/no.
 */
function isEnabled() {
  const explicit = process.env.SIRAGPT_AGENTIC_CHAT_ENABLED;
  const legacy = process.env.AGENTIC_TOOLS_IN_CHAT;
  const raw = explicit != null ? explicit : legacy;
  if (raw == null || String(raw).trim() === '') return true;
  const v = String(raw).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

module.exports = {
  runAgenticChat,
  isEnabled,
  shouldUseAgenticChat,
  modelSupportsFunctionCalling,
  // Exposed for tests:
  _internal: {
    freshState,
    serializeSentinel,
    stageLabelFor,
    buildThreadWorkContext,
    adaptAgentTool,
    baseWebTools,
    buildDefaultTools,
    SENTINEL_FENCE_OPEN,
    SENTINEL_FENCE_CLOSE,
  },
};

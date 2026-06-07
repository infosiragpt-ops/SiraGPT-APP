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
  const { listDirTool, globFilesTool, codeGrepTool } = require('./agents/host-code-search-tool');
  const { checkCiStatusTool, monitorCiTool } = require('./agents/github-actions-tool');
  const openclawCapabilityKernel = require('./openclaw-capability-kernel');
  const { runToolWithRetry } = require('./agents/tool-call-retry');
  const { liveSubagentsEnabled } = require('./agents/subagent-guard');
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
    web_extract: (args) => `Extrayendo ${prettyDomain(args?.url) || 'fuente'}`,
    session_search: (args) => `Buscando sesiones sobre "${truncate(args?.query, 48)}"`,
    session_list: () => 'Revisando tus sesiones recientes',
    session_history: (args) => `Abriendo sesión ${truncate(args?.sessionId, 32)}`,
    session_send: (args) => `Enviando a sesión ${truncate(args?.sessionId, 24)}`,
    session_spawn: (args) => `Lanzando sub-agente: ${truncate(args?.title || args?.prompt, 40)}`,
    browser_navigate: (args) => `Navegando a ${prettyDomain(args?.url) || 'sitio'}`,
    browser_click: (args) => `Click en ${truncate(args?.selector, 48)}`,
    browser_type: (args) => `Escribiendo en ${truncate(args?.selector, 48)}`,
    browser_scroll: () => 'Desplazando navegador',
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

const PROFESSIONAL_MINIMAL_COGNITION_RULES = Object.freeze([
  'Professional minimal cognition profile:',
  '- Start from the user intent, not from typos. Normalize noisy Spanish/English internally before choosing tools, scope, or output format.',
  '- Put the direct answer or next action first. Then include only the evidence, files, commands, blockers, or tradeoffs needed to trust it.',
  '- Avoid filler, performative process narration, generic disclaimers, repeated summaries, and vague hedging.',
  '- If uncertain, name the exact missing input and continue with the safest useful next step.',
  '- For repo, runtime, document, image, or local-app work, inspect real artifacts, logs, tools, or tests before making conclusions.',
  '- Do not claim execution, edits, verification, external research, or local state unless a tool result actually supports it.',
  '- Keep the final answer calm, compact, and professional: no emojis, no decorative framing, no invented internal steps.',
]);

const COGNITION_UPGRADE_ACTION = /\b(mejor\w*|optimiz\w*|elev\w*|refin\w*|profesionaliz\w*|hardening|upgrade)\b/i;
const COGNITION_UPGRADE_TARGET = /\b(cerebro|brain|ia|ai|inteligencia|razonamiento|contexto|memoria|agentes?|sistema|runtime|orquestador)\b/i;

function isCognitionUpgradeRequest(text) {
  const normalized = String(text || '');
  return COGNITION_UPGRADE_ACTION.test(normalized) && COGNITION_UPGRADE_TARGET.test(normalized);
}

function buildProfessionalMinimalCognitionBlock({ userQuery = '', goals = [] } = {}) {
  const lines = [...PROFESSIONAL_MINIMAL_COGNITION_RULES];
  const goalText = Array.isArray(goals) ? goals.join('\n') : '';
  if (isCognitionUpgradeRequest(`${userQuery}\n${goalText}`)) {
    lines.push(
      '- This turn asks to improve the AI brain/context. Treat it as runtime behavior hardening: extend the existing architecture, ship a small verifiable change, and avoid broad rewrites unless evidence requires them.'
    );
  }
  return lines.join('\n');
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
    '',
    buildProfessionalMinimalCognitionBlock({ userQuery, goals }),
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
  // OSS/efficient model families that expose OpenAI-style tool_calls on every
  // OpenAI-compatible host we route to (Cerebras free tier, Groq, OpenRouter).
  // Checked before the per-provider allowlist so the DEFAULT FREE model
  // (Cerebras "FlashGPT" / llama-3.1-8b) and its cross-plan fallback actually
  // reach the agentic loop — regardless of how the provider string is labeled.
  // Without this, most users were silently kept on plain streaming.
  if (/(?:^|[/_-])(?:llama-?[34]|qwen|gpt-oss|kimi-k2)/i.test(m)) return true;
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
const AGENTIC_PROMPT_HINT = /\b(clon|repo|repositorio|github|git|commit|push|pr|pull ?request|deploy|despleg|codex|cursor|claude.?code|program|c[oó]digo|refactor|mejora|arregla|corrige|no.?funciona|no.?sirve|todav[ií]a|sigue|contin[uú]a|investiga|busca|fuentes?|cita|web|internet|actual|reciente|pdf|documento|archivo|excel|word|ppt|tabla|analiza|compara|genera.?archivo|descargable|aut[oó]nom|background|segundo.?plano|meses?|semanas?|historial|sesiones?|conversaci[oó]n(?:es)?|navegador|browser|naveg|scrap|rasp|extrae.?web|click|clic|scroll|desplaz|\b\/goal\b|\b\/plan\b)\b/i;

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
  if (isCognitionUpgradeRequest(text)) return true;
  if (AGENTIC_PROMPT_HINT.test(text)) return true;
  // Auto web-search routing: send freshness / live-data / factual-lookup
  // questions into the agentic loop (which owns web_search) even when the
  // user uses no explicit search verb. This is what lets the assistant
  // decide on its own that it must search the internet to answer.
  try {
    const { detectWebSearchIntent } = require('./web-search-intent');
    // Lean aggressive (threshold 0.30 vs the 0.35 default) so borderline
    // freshness/factual questions still reach the loop; NEGATIVE_PATTERNS
    // still suppress creative-writing and pure-math prompts.
    if (detectWebSearchIntent(text, { threshold: 0.30 }).needsWebSearch) return true;
  } catch (_) { /* detector is best-effort, never block chat */ }
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
  function freshState(toolNames = ['web_search', 'read_url', 'web_extract', 'session_search', 'session_list', 'session_history']) {
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
      selection = null,
    } = opts || {};

    if (!openai) throw new Error('runAgenticChat: openai client is required');
    if (!model)  throw new Error('runAgenticChat: model is required');
    if (!userQuery) throw new Error('runAgenticChat: userQuery is required');
    if (!res) throw new Error('runAgenticChat: res is required');

    const tools = toolsOverride || buildDefaultTools({ userQuery, selection });
    const availableToolNames = new Set(tools.map((tool) => tool && tool.name).filter(Boolean));
    // Bilingual media-intent detection: when the user asks to create an
    // image / video / audio / music in the chat bar, this pre-extracts the
    // specs (duration, aspect ratio, count, style/genre) and lets us inject a
    // directive so the agent reliably calls the matching tool with them.
    const mediaIntent = detectMediaIntent(userQuery);
    let initialToolChoice = mediaIntent?.tool && mediaIntent.confidence === 'high' && availableToolNames.has(mediaIntent.tool)
      ? mediaIntent.tool
      : null;
    // Aggressive auto-search: when the question clearly needs fresh/live/factual
    // web data and no media tool was force-selected, force the FIRST step to be
    // a web_search so the model cannot answer "no tengo información" from stale
    // memory. The model still controls every step after the first.
    if (!initialToolChoice && availableToolNames.has('web_search')) {
      try {
        const { detectWebSearchIntent } = require('./web-search-intent');
        const wsi = detectWebSearchIntent(userQuery);
        if (wsi.needsWebSearch && wsi.confidence >= 0.5) {
          initialToolChoice = 'web_search';
        }
      } catch (_) { /* best-effort; fall back to model-driven tool choice */ }
    }
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
      initialToolChoice ? buildMediaIntentHint(mediaIntent) : '',
      openclawRuntimeBlock,
      buildExecutionProfilePrompt(executionProfile),
      buildThreadWorkContext(history, userQuery),
      'Este hilo es una sesion agentica autónoma: decide, usa herramientas, observa resultados, corrige y finaliza solo cuando tengas una respuesta verificable o la tarea esté completa.',
      'Estándar de calidad (nivel experto): en tareas difíciles piensa antes de actuar (descompón el problema, explicita supuestos y casos límite, verifica cada paso); responde con la conclusión primero; distingue lo que SABES de lo que INFIERES de lo que NO SABES y NUNCA inventes datos, cifras, citas, fuentes ni APIs; cuando dudes, verifica con una herramienta en vez de adivinar; admite y corrige tus errores directamente, sin adular.',
      'Si el usuario dice "todavía no funciona", "sigue", "arregla", "no sirve", o similar, revisa TODO el historial del hilo para entender qué se pidió antes, qué se hizo, qué falló, y continúa desde donde se quedó. No empieces de cero.',
      'Cuando detectes que el usuario quiere hacer operaciones de repositorio (clonar, editar, commit, push, PR, deploy, CI), actúa como un coding agent completo:',
      '  1. Clona o localiza el repositorio usando `clone_project` o `host_bash` con git.',
      '  2. Comprende la estructura del proyecto: usa `list_dir` para explorar el árbol, `glob_files` para localizar archivos por patrón (ej. "**/*.ts") y `code_grep` para buscar dónde se define o se usa un símbolo/cadena antes de editar.',
      '  3. Realiza los cambios necesarios editando archivos con `host_file` para cambios de texto y `host_bash` solo para comandos.',
      '  4. Ejecuta `npm test` o la suite de pruebas respectiva para verificar.',
      '  5. Si las pruebas pasan, haz `git add`, `git commit`, `git push` al repositorio.',
      '  6. Usa `check_ci_status` o `monitor_ci` para verificar GitHub Actions hasta verde; si CI falla, informa el fallo exacto y no afirmes que quedó en verde.',
      'Usa `memory_recall` cuando el pedido dependa de preferencias o contexto persistente del usuario.',
      'Para continuidad entre conversaciones (el usuario dice "lo que hablamos antes", "retoma", "¿en qué quedamos?", "mis chats", "la sesión de ayer"): usa `session_list` para ver sus sesiones recientes, `session_search` para encontrar un tema concreto, y `session_history` para abrir una sesión por su id y leer el hilo completo antes de continuar. Solo accedes a sesiones del propio usuario.',
      'Usa `rag_retrieve`, `self_rag_answer` o `docintel_*` cuando el usuario mencione archivos, documentos, PDFs, tablas o conocimiento privado.',
      'Si la respuesta depende de hechos que pueden haber cambiado, datos en tiempo real, cifras, fechas, precios, noticias, o de cualquier cosa que no sepas con certeza absoluta, DEBES usar `web_search` (y luego `web_extract` o `read_url` sobre las mejores fuentes) ANTES de responder. Nunca respondas "no tengo información", "no tengo acceso a internet" o "mis datos llegan hasta cierta fecha" sin haber ejecutado primero `web_search`. Cita las fuentes con enlaces markdown.',
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

    // Authorization chokepoint for the interactive chat. Without this the
    // high-risk host tools (host_bash/host_file/clone_project) ran fail-open
    // for any ai:generate user. Low-risk tools are allow-by-default so the
    // ~80 web/RAG/visual tools keep working untouched.
    const { createChatToolGate } = require('./agents/chat-tool-policy');
    const toolGate = createChatToolGate({
      onAudit: (info) => { try { onEvent({ type: 'tool_authorized', tool: info.tool }); } catch (_) { /* noop */ } },
    });

    let stepCounter = 0;
    const result = await reactAgent.run(openai, {
      query: userQuery,
      tools,
      model,
      maxSteps: maxStepsOverride,
      maxRuntimeMs: maxRuntimeOverride,
      extraSystem,
      initialToolChoice,
      ctx: {
        ...toolContext,
        signal,
        onEvent,
        toolGate,
        toolAuthCtx: {
          userId: toolContext.userId || null,
          clearance: toolContext.clearance || null,
        },
      },
      finalizeGuard: executionProfile.requiredTools.length
        ? ({ steps, unavailableTools }) => validateFinalize(executionProfile, steps, { unavailableTools })
        : null,
      onCompact: ({ step, removedMessages, chars }) => {
        try { console.log(`[agentic-chat] trace compacted at step ${step}: -${removedMessages} msgs, ${chars} chars`); } catch (_) {}
      },
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

    // Non-blocking honesty check: flag completion claims in the answer that
    // no executed tool supports (e.g. "creé el archivo" with no document tool
    // run, "busqué en la web" with no search). Emitted as a trace event for
    // observability + telemetry; it never blocks or rewrites the answer.
    try {
      // eslint-disable-next-line global-require
      const { verifyClaims } = require('./agents/completion-claim-verifier');
      // eslint-disable-next-line global-require
      const { successfulToolCalls } = require('./agents/agentic-execution-profile');
      const counts = successfulToolCalls(Array.isArray(result?.steps) ? result.steps : state.steps);
      const executed = counts && typeof counts.keys === 'function' ? Array.from(counts.keys()) : [];
      const honesty = verifyClaims(finalAnswer, executed);
      if (!honesty.ok) {
        const kinds = honesty.unsupported.map((c) => c.kind);
        try { onEvent({ type: 'honesty_check', severity: honesty.severity, unsupportedClaims: kinds, executedTools: executed }); } catch (_) { /* noop */ }
        console.warn(`[agentic-chat-stream] honesty_check severity=${honesty.severity} unsupported=${kinds.join(',')} executedTools=${executed.length}`);
      }
    } catch (_) { /* honesty check must never break the response */ }

    // Emit the final sentinel + the answer body. Phase 5: when
    // SIRAGPT_AGENTIC_STREAM_FINAL is enabled, token-stream the answer
    // progressively (the agentic path otherwise dumps the whole answer in one
    // frame). Default off → original single-frame behavior. Hard fallback so
    // streaming can never break the response.
    try {
      // eslint-disable-next-line global-require
      const finalStreamer = require('./agentic-final-streamer');
      await finalStreamer.streamFinalAnswer({
        res,
        writeSse,
        prefix: serializeSentinel(state),
        finalAnswer,
        signal,
      });
    } catch (_finalStreamErr) {
      await writeSse(res, {
        replace: true,
        content: serializeSentinel(state) + '\n\n' + finalAnswer,
      });
    }

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
      // Bounded, classifier-driven retry so a transient network blip while
      // calling a tool does not abort an otherwise-correct multi-step run.
      // Transparent on success; only THROWN transient errors are retried,
      // deterministic `{error}` responses are passed straight through.
      execute: async (args, _ctx) => runToolWithRetry(
        (a, c) => tool.handler(a, c),
        args,
        _ctx,
        { label: tool.name },
      ),
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
          freshness:  { type: 'string', description: 'Recency window for fresh/news queries: pd|pw|pm|py (day/week/month/year). Honoured by Brave.' },
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
      adaptAgentTool(agentTools.web_extract, {
        type: 'object',
        properties: {
          url:      { type: 'string', description: 'Absolute http(s) URL to extract as readable markdown.' },
          maxChars: { type: 'integer', minimum: 500, maximum: 50000, description: 'Markdown cap. Default 12000.' },
        },
        required: ['url'],
        additionalProperties: false,
      }),
      adaptAgentTool(agentTools.session_search, {
        type: 'object',
        properties: {
          query:           { type: 'string', description: 'Terms to search in the user’s past chat messages.' },
          limit:           { type: 'integer', minimum: 1, maximum: 25, description: 'How many matching snippets to return. Default 8.' },
          sessionId:       { type: 'string', description: 'Optional chat/session id to restrict the search.' },
          includeArchived: { type: 'boolean', description: 'Include archived sessions. Default false.' },
        },
        required: ['query'],
        additionalProperties: false,
      }),
      adaptAgentTool(agentTools.session_list, {
        type: 'object',
        properties: {
          limit:           { type: 'integer', minimum: 1, maximum: 50, description: 'How many recent sessions to return, newest first. Default 10.' },
          includeArchived: { type: 'boolean', description: 'Include archived sessions. Default false.' },
        },
        additionalProperties: false,
      }),
      adaptAgentTool(agentTools.session_history, {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Chat/session id to open (e.g. from session_list or session_search).' },
          limit:     { type: 'integer', minimum: 1, maximum: 50, description: 'How many recent messages to return, in chronological order. Default 20.' },
        },
        required: ['sessionId'],
        additionalProperties: false,
      }),
      // Sub-agent tools are cost-bearing (they run a full sandboxed agent)
      // so they are opt-in via SIRAGPT_LIVE_SUBAGENTS and depth/budget-guarded.
      ...(liveSubagentsEnabled() ? [
        adaptAgentTool(agentTools.session_send, {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'Target chat/session id (must belong to the user).' },
            message:   { type: 'string', description: 'Content to append to that session.' },
            runAgent:  { type: 'boolean', description: 'If true, run a sandboxed sub-agent on the message. Default false (just leaves a note).' },
            thinking:  { type: 'string', enum: ['low', 'medium', 'high'], description: 'Thinking level when runAgent is true.' },
          },
          required: ['sessionId', 'message'],
          additionalProperties: false,
        }),
        adaptAgentTool(agentTools.session_spawn, {
          type: 'object',
          properties: {
            prompt:   { type: 'string', description: 'Self-contained task for the sub-agent (it does not see this chat\u2019s history).' },
            title:    { type: 'string', description: 'Short title for the new session (<= 80 chars).' },
            thinking: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Thinking level for the sub-run. Default low.' },
          },
          required: ['prompt'],
          additionalProperties: false,
        }),
      ] : []),
      adaptAgentTool(agentTools.browser_navigate, {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL to open in the active browser session.' },
        },
        required: ['url'],
        additionalProperties: false,
      }),
      adaptAgentTool(agentTools.browser_click, {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector to click in the active browser session.' },
        },
        required: ['selector'],
        additionalProperties: false,
      }),
      adaptAgentTool(agentTools.browser_type, {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the input/textarea target.' },
          text:     { type: 'string', description: 'Text to type into the target.' },
        },
        required: ['selector', 'text'],
        additionalProperties: false,
      }),
      adaptAgentTool(agentTools.browser_scroll, {
        type: 'object',
        properties: {
          y:        { type: 'integer', description: 'Vertical pixel delta. Default 800 when selector is omitted.' },
          selector: { type: 'string', description: 'CSS selector to scroll into view.' },
        },
        additionalProperties: false,
      }),
      // SUNAT / RENIEC Perú lookup. The logic lives in the filesystem skill
      // (backend/src/skills/sunat_peru) so the same handler is reachable both
      // here (main agentic chat) and via the skills registry; we only declare
      // the OpenAI-style JSON Schema inline because react-agent needs a full
      // schema, not the manifest's hint strings.
      (() => {
        // eslint-disable-next-line global-require
        const sunat = require('../skills/sunat_peru/handler');
        return {
          name: 'sunat_peru',
          description:
            'Consulta datos OFICIALES del Perú en tiempo real: RUC de empresas en SUNAT (razón social, estado, condición, dirección), DNI de personas en RENIEC (nombres y apellidos) y el tipo de cambio del dólar SUNAT/SBS. Úsalo ante un RUC (11 dígitos), un DNI (8 dígitos) o una pregunta por el tipo de cambio del dólar en Perú. Devuelve datos reales verificados — nunca los inventes.',
          parameters: {
            type: 'object',
            properties: {
              tipo: {
                type: 'string',
                enum: ['ruc', 'dni', 'tipo_cambio'],
                description: "Tipo de consulta: 'ruc' (empresa, 11 dígitos), 'dni' (persona, 8 dígitos) o 'tipo_cambio' (dólar SUNAT/SBS).",
              },
              numero: {
                type: 'string',
                description: 'RUC de 11 dígitos o DNI de 8 dígitos. Omitir cuando tipo = tipo_cambio.',
              },
            },
            required: ['tipo'],
            additionalProperties: false,
          },
          execute: async (args) => sunat.execute(args),
        };
      })(),
      adaptAgentTool(agentTools.github_search, {
        type: 'object',
        properties: {
          query:    { type: 'string', description: 'Keywords, optionally with GitHub qualifiers.' },
          type:     { type: 'string', enum: ['repositories', 'code', 'issues', 'users', 'topics'], description: 'Corpus to search. Default repositories.' },
          limit:    { type: 'integer', minimum: 1, maximum: 50, description: 'How many hits. Default 10.' },
          language: { type: 'string', description: 'Restrict by language, e.g. "python".' },
          sort:     { type: 'string', description: 'stars|forks|updated (repos) or comments|reactions|updated (issues).' },
          minStars: { type: 'integer', minimum: 0, description: 'Minimum star count for repositories.' },
          repo:     { type: 'string', description: 'owner/name to scope code/issue search.' },
        },
        required: ['query'],
        additionalProperties: false,
      }),
      adaptAgentTool(agentTools.scientific_search, {
        type: 'object',
        properties: {
          query:     { type: 'string', description: 'Research topic or keywords.' },
          limit:     { type: 'integer', minimum: 1, maximum: 25, description: 'Per-provider cap. Default 8.' },
          providers: { type: 'array', items: { type: 'string' }, description: 'Subset like ["arxiv","pubmed"]. Default all.' },
        },
        required: ['query'],
        additionalProperties: false,
      }),
      adaptAgentTool(agentTools.x_search, {
        type: 'object',
        properties: {
          query:      { type: 'string', description: 'What to search on X (Twitter): topic, person, event or $ticker.' },
          maxResults: { type: 'integer', minimum: 1, maximum: 30, description: 'How many X posts to retrieve. Default 15.' },
          handles:    { type: 'array', items: { type: 'string' }, description: 'Restrict to specific X handles (without @).' },
          fromDate:   { type: 'string', description: 'ISO date YYYY-MM-DD lower bound for posts.' },
          toDate:     { type: 'string', description: 'ISO date YYYY-MM-DD upper bound for posts.' },
        },
        required: ['query'],
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
    const base = [...baseWebTools(), ...loadTaskTools(), cloneProjectTool, hostBashTool, hostFileTool, listDirTool, globFilesTool, codeGrepTool, checkCiStatusTool, monitorCiTool];
    const userQuery = opts && typeof opts.userQuery === 'string' ? opts.userQuery : '';
    const wantsMedia = !!userQuery && (isAgenticActionRequest(userQuery) || !!detectMediaIntent(userQuery).kind);
    const tools = wantsMedia ? [...base, ...loadMediaTools()] : base;
    const seen = new Set();
    const deduped = tools.filter((tool) => {
      if (!tool || !tool.name || seen.has(tool.name)) return false;
      seen.add(tool.name);
      return true;
    });

    // A1: per-turn tool selection. Hand the model a small, relevant subset
    // instead of all ~37-73 tools (which degrades tool-choice accuracy, esp. on
    // the free model). Conservative: keeps a core + intent-relevant tools, and
    // falls back to the FULL set on broad/unknown intent. On unless
    // SIRAGPT_TOOL_SELECTION=0. Fail-open → full set on any error.
    const sel = opts && opts.selection;
    if (sel && String(process.env.SIRAGPT_TOOL_SELECTION || '').trim().toLowerCase() !== '0'
      && String(process.env.SIRAGPT_TOOL_SELECTION || '').trim().toLowerCase() !== 'off') {
      try {
        const toolSelector = require('./agents/tool-selector');
        const picked = toolSelector.selectTools({
          tools: deduped,
          userQuery,
          decision: sel.decision || null,
          intent: sel.intent || (sel.decision && sel.decision.intent) || null,
          signals: sel.signals || {},
          maxTools: sel.maxTools,
        });
        if (picked && picked.applied && Array.isArray(picked.tools) && picked.tools.length >= 4) {
          console.log(`[tool-selector] ${picked.reason}: ${picked.keptCount}/${deduped.length} tools (dropped ${picked.droppedCount})`);
          return picked.tools;
        }
      } catch (selErr) {
        console.warn('[tool-selector] selection failed (using full set):', selErr && selErr.message);
      }
    }
    return deduped;
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

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
  const { projectReadTool, projectWriteTool, projectExecTool } = require('./agents/project-workspace-tools');
  const { projectCloneRepoTool, projectPreviewStartTool, projectPreviewStatusTool, projectPreviewStopTool } = require('./agents/project-preview-tools');
  const { projectChangesTool, projectOpenPullRequestTool, projectPullRequestChecksTool } = require('./agents/project-changes-tools');
  const { decideWithJevTool } = require('./agents/typesafe-decision-tool');
  const openclawCapabilityKernel = require('./openclaw-capability-kernel');
  const { prepareAgentPluginLifecycle } = require('./agents/agent-plugin-lifecycle');
  const { runToolWithRetry } = require('./agents/tool-call-retry');
  const { statusForAgentStopReason } = require('./agents/react-run-outcome');
  const { liveSubagentsEnabled } = require('./agents/subagent-guard');
  const { isAgenticActionRequest, isArtifactDeliverableRequest, isDocumentEditRequest } = require('./agents/agentic-trigger');
  const { detectMediaIntent, detectMediaIntents, buildMediaIntentsHint } = require('./agents/media-intent');
  const {
    buildExecutionProfile,
    buildExecutionProfilePrompt,
    classifyAttachmentKinds,
    validateFinalize,
  } = require('./agents/agentic-execution-profile');
  const {
    buildSkillExecutionPrompt,
    inferRecommendedSkills,
    resolveCustomGptAgentPolicy,
  } = require('./agents/custom-gpt-agent-policy');
  const {
    buildArtifactDeliveryContract,
    buildArtifactDeliveryPrompt,
    validateArtifactDelivery,
    validateSavXlsxDelivery,
  } = require('./agents/artifact-delivery-contract');
  const {
    isSoftwareBuildRequest,
    isExplicitDocumentRequest,
  } = require('./agents/software-build-intent');
  const {
    isGithubPrRequest,
    isGithubLocalPreviewRequest,
    isGithubRepoWorkRequest,
    extractGithubHttpsUrl,
    extractOwnerRepo,
    extractPreferredPort,
    buildLocalPreviewReadyMessage,
    buildLocalPreviewErrorMessage,
  } = require('./agents/github-pr-intent');

  const SENTINEL_FENCE_OPEN = '```agent-task-state\n';
  const SENTINEL_FENCE_CLOSE = '\n```';

  // Autonomous agents need more iterations for real work:
  // - Repository clone + edit + test + commit + push can take 10+ steps
  // - Research + web_search + read_url + verify can take 8+ steps
  // - /goal tasks run until the agent decides they are done.
  const DEFAULT_MAX_STEPS = Number(process.env.AGENTIC_MAX_STEPS) || 24;
  // Per-turn wall clock. Extended for multi-file edits, npm install, and
  // git operations that may include slow CI checks.
  const DEFAULT_MAX_RUNTIME_MS = 5 * 60 * 1000;

  // Tools that always stay in the model-visible schema when deferred tool
  // loading is ON (SIRAGPT_TOOL_DEFER=1). Everything else is discoverable
  // through `search_tools`. Required tools from the execution profile and a
  // media-intent initialToolChoice are force-included at run time.
  const CORE_AGENT_TOOL_NAMES = [
    'update_plan',
    'web_search', 'read_url', 'web_extract', 'deep_search',
    'memory_recall', 'rag_retrieve', 'self_rag_answer',
    'memory_read_topic', 'memory_search', 'memory_write', 'memory_forget', 'chat_history_search', 'connector_search',
    'python_exec', 'run_tests',
    'create_document', 'verify_artifact', 'document_edit',
    'run_skill', 'run_skill_pipeline',
    'session_search', 'session_list', 'session_history',
    'computer_screenshot', 'computer_click', 'computer_type', 'computer_navigate',
  ];

const STAGE_LABELS = {
    update_plan: () => 'Actualizando el plan',
    search_tools: (args) => `Buscando herramientas: "${truncate(args?.query, 50)}"`,
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
    computer_screenshot: () => 'Capturando la computadora',
    computer_click: () => 'Clic en la computadora',
    computer_type: () => 'Escribiendo en la computadora',
    computer_navigate: (args) => `Abriendo ${prettyDomain(args?.url) || 'sitio'} en la computadora`,
    memory_recall: (args) => `Recordando contexto sobre "${truncate(args?.query, 48)}"`,
    memory_read_topic: (args) => `Abriendo memoria: ${truncate(args?.topic, 32)}`,
    memory_search: (args) => `Buscando en tu memoria "${truncate(args?.query, 48)}"`,
    memory_write: (args) => `Guardando en memoria: ${truncate(args?.text, 48)}`,
    memory_forget: () => 'Olvidando un recuerdo',
    chat_history_search: (args) => `Buscando en chats anteriores "${truncate(args?.query, 48)}"`,
    connector_search: (args) => `Buscando en tus fuentes conectadas "${truncate(args?.query, 48)}"`,
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
    run_skill: (args) => `Aplicando skill ${truncate(args?.skillId || 'especializada', 44)}`,
    run_skill_pipeline: (args) => `Aplicando ${Array.isArray(args?.steps) ? args.steps.length : 'varias'} skills`,
    run_tests: () => 'Ejecutando pruebas',
    npm_install: () => 'Instalando dependencias',
    commit_changes: () => 'Haciendo commit de cambios',
    push_changes: () => 'Subiendo cambios a GitHub',
    monitor_ci: () => 'Esperando verificación CI en verde',
    check_ci_status: () => 'Verificando estado de CI',
    create_pr: () => 'Creando Pull Request',
  finalize:   () => 'Componiendo respuesta',
};

const CUSTOM_GPT_DOCUMENT_TOOL_NAMES = new Set([
  'rag_retrieve',
  'self_rag_answer',
  'docintel_analyze',
  'docintel_retrieve',
  'docintel_extract_tables',
  'docintel_compare',
  'deep_analyze',
  'auto_file',
  'compare_documents',
  'search_docs',
  'create_document',
  'verify_artifact',
  'document_edit',
]);

// Web lookups and page reads per agentic turn. A news question ran 22
// searches in 6 steps (74 s) although the route had already injected 10
// fresh results; once searches were capped, 11 page reads still took ~46 s.
const WEB_LOOKUP_TOOLS = new Set(['web_search', 'deep_search', 'x_search', 'scientific_search']);
// browse_page (Cowork) opens the page in a real browser: the slowest read of all
// (~9 s each in production), so it shares the page-read budget.
const WEB_READ_TOOLS = new Set(['read_url', 'web_fetch', 'web_extract', 'browse_page']);

function positiveEnvInt(env, name, fallback) {
  const value = Math.floor(Number(env[name]));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function webSearchBudget({ preGroundedSources = 0, env = process.env } = {}) {
  const limit = positiveEnvInt(env, 'SIRAGPT_AGENTIC_WEB_SEARCH_BUDGET', 8);
  return preGroundedSources > 0 ? Math.min(limit, 2) : limit;
}

function webReadBudget({ preGroundedSources = 0, env = process.env } = {}) {
  const limit = positiveEnvInt(env, 'SIRAGPT_AGENTIC_WEB_READ_BUDGET', 12);
  return preGroundedSources > 0 ? Math.min(limit, 3) : limit;
}

/** Copies of the tools in `names` that stop after `limit` calls this turn. */
function withToolBudget(tools, names, limit, exhaustedMessage) {
  let used = 0;
  return (Array.isArray(tools) ? tools : []).map((tool) => {
    if (!tool || !names.has(tool.name) || typeof tool.execute !== 'function') return tool;
    const inner = tool.execute;
    return {
      ...tool,
      execute: async (args, ctx) => {
        if (used >= limit) return { ok: false, budgetExhausted: true, error: exhaustedMessage };
        used += 1;
        return inner(args, ctx);
      },
    };
  });
}

/**
 * Per-turn image guard: once edit_image refuses (no provider / unsupported /
 * no source), generate_image is refused too — a text-only fallback would
 * replace the user's image with an unrelated one.
 */
function withImageEditGuard(tools) {
  let refusal = null;
  const refused = new Set();
  const guard = { refusedTools: () => Array.from(refused) };
  const wrapped = (Array.isArray(tools) ? tools : []).map((tool) => {
    if (!tool || !['edit_image', 'generate_image'].includes(tool.name) || typeof tool.execute !== 'function') return tool;
    const inner = tool.execute;
    return {
      ...tool,
      execute: async (args, ctx) => {
        if (refused.has(tool.name) && refusal) {
          return { ok: false, code: refusal.code, error: refusal.error, refusedAfterEdit: true };
        }
        const result = await inner(args, ctx);
        if (tool.name === 'edit_image' && result && result.ok === false) {
          if (result.code === 'image_edit_unsupported' || result.code === 'NO_PROVIDER') {
            refusal = { code: result.code, error: result.error };
            refused.add('edit_image');
            refused.add('generate_image');
          } else if (result.code === 'image_source_required') {
            refusal = {
              code: result.code,
              error: 'No encontré la imagen que quieres editar; adjúntala o selecciónala para continuar. No voy a generar una imagen nueva para no perder tu imagen.',
            };
            refused.add('generate_image');
          }
        }
        return result;
      },
    };
  });
  return { tools: wrapped, guard };
}

/**
 * Same budgets enforced where every tool call is dispatched (react-agent's
 * `ctx.checkToolBudget`, prefetch and sequential paths alike). The per-tool
 * wrappers stay as a second layer; in production a news turn still completed
 * one page read more than its cap.
 */
function checkWebToolBudget(name, usage, limits) {
  const group = WEB_LOOKUP_TOOLS.has(name) ? 'searches' : WEB_READ_TOOLS.has(name) ? 'reads' : null;
  if (!group) return { ok: true };
  const members = group === 'searches' ? WEB_LOOKUP_TOOLS : WEB_READ_TOOLS;
  let used = 0;
  for (const member of members) used += Number(usage && usage[member]) || 0;
  const limit = limits[group];
  if (used < limit) return { ok: true };
  return {
    ok: false,
    reason: group === 'searches'
      ? `Límite de ${limit} búsquedas web en este turno alcanzado. Responde ya con las fuentes que tienes y cítalas.`
      : `Límite de ${limit} lecturas de página en este turno alcanzado. Responde ya con lo que leíste y los resultados que tienes, y cítalos.`,
  };
}

function withWebSearchBudget(tools, limit) {
  return withToolBudget(tools, WEB_LOOKUP_TOOLS, limit,
    `Límite de ${limit} búsquedas web en este turno alcanzado. Responde ya con las fuentes que tienes y cítalas.`);
}

function withWebReadBudget(tools, limit) {
  return withToolBudget(tools, WEB_READ_TOOLS, limit,
    `Límite de ${limit} lecturas de página en este turno alcanzado. Responde ya con lo que leíste y los resultados que tienes, y cítalos.`);
}

function applyCustomGptCapabilityGates(tools, capabilities) {
  const source = Array.isArray(tools) ? tools : [];
  const capGate = String(process.env.SIRAGPT_GPT_CAPABILITIES_GATING || '').trim().toLowerCase();
  if (!capabilities || typeof capabilities !== 'object' || capGate === '0' || capGate === 'off') {
    return source;
  }

  const blocked = new Set();
  if (capabilities.webBrowsing === false) {
    ['web_search', 'web_fetch', 'read_url', 'web_extract', 'deep_search', 'x_search'].forEach((name) => blocked.add(name));
  }
  if (capabilities.imageGeneration === false) {
    ['generate_image', 'generate_video', 'generate_speech', 'generate_music'].forEach((name) => blocked.add(name));
  }
  if (capabilities.codeInterpreter === false) {
    ['run_javascript', 'run_code', 'code_sandbox', 'python_exec', 'bash_exec'].forEach((name) => blocked.add(name));
  }
  if (capabilities.skillsEnabled === false) {
    ['run_skill', 'run_skill_pipeline'].forEach((name) => blocked.add(name));
  }

  return source.filter((tool) => {
    const name = tool && typeof tool.name === 'string' ? tool.name : '';
    if (!name || blocked.has(name)) return false;
    if (capabilities.documents === false && CUSTOM_GPT_DOCUMENT_TOOL_NAMES.has(name)) return false;
    if (capabilities.dataAnalysis === false && name.startsWith('create_') && name !== 'create_document') return false;
    return true;
  });
}

function truncate(s, n) {
  if (!s) return '';
  const str = String(s);
  return str.length <= n ? str : str.slice(0, n - 1) + '…';
}

// ── Live progress of the agentic loop (sentinel steps + agent_model rows) ──
const turnProgressLib = require('./turn-progress');
const LIVE_DETAIL_MAX = 200;
const LIVE_TICK_REASONING_MS = 12000;
const LIVE_TICK_SLOW_MS = 30000;

function capitalizeFirst(text) {
  const s = String(text || '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// What the model decided to do next, in plain Spanish («buscar en la web y
// leer 2 páginas»). Unknown tools are counted, never named by their id.
const LIVE_DECISION_VERBS = {
  web_search: ['buscar en la web', (n) => `hacer ${n} búsquedas en la web`],
  deep_search: ['investigar a fondo en la web', (n) => `hacer ${n} investigaciones en la web`],
  scientific_search: ['buscar artículos científicos', (n) => `hacer ${n} búsquedas científicas`],
  read_url: ['leer una página', (n) => `leer ${n} páginas`],
  web_fetch: ['leer una página', (n) => `leer ${n} páginas`],
  transcribe_url: ['transcribir el audio de un enlace', (n) => `transcribir ${n} enlaces`],
  automations: ['programar una automatización', (n) => `gestionar ${n} automatizaciones`],
  search_skills_marketplace: ['buscar skills en el marketplace', (n) => `hacer ${n} búsquedas en el marketplace de skills`],
  install_skill: ['instalar una skill', (n) => `instalar ${n} skills`],
  web_extract: ['extraer una página', (n) => `extraer ${n} páginas`],
  rag_retrieve: ['consultar tus documentos', (n) => `consultar tus documentos ${n} veces`],
  docintel_retrieve: ['consultar tus documentos', (n) => `consultar tus documentos ${n} veces`],
  docintel_analyze: ['analizar tus documentos', () => 'analizar tus documentos'],
  memory_recall: ['consultar tu memoria', () => 'consultar tu memoria'],
  memory_search: ['consultar tu memoria', () => 'consultar tu memoria'],
  python_exec: ['ejecutar Python', (n) => `ejecutar Python ${n} veces`],
  create_document: ['crear un archivo', (n) => `crear ${n} archivos`],
  document_edit: ['editar tu documento', () => 'editar tu documento'],
  verify_artifact: ['verificar el archivo', (n) => `verificar ${n} archivos`],
  generate_image: ['generar una imagen', (n) => `generar ${n} imágenes`],
  create_chart: ['crear una gráfica', (n) => `crear ${n} gráficas`],
  update_plan: ['actualizar el plan', () => 'actualizar el plan'],
  finalize: ['responder', () => 'responder'],
};

function joinSpanish(parts) {
  if (parts.length <= 1) return parts[0] || '';
  return `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`;
}

function describeLiveDecision(toolNames, took) {
  const counts = new Map();
  for (const name of toolNames || []) {
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  if (counts.size === 0) return took ? `Respondió en ${took}` : 'Respondió';
  if (counts.size === 1 && counts.has('finalize')) return took ? `Listo en ${took}` : 'Listo';
  const phrases = [];
  let others = 0;
  for (const [name, n] of counts) {
    const verbs = LIVE_DECISION_VERBS[name];
    if (!verbs) { others += n; continue; }
    const phrase = n > 1 ? verbs[1](n) : verbs[0];
    if (!phrases.includes(phrase)) phrases.push(phrase);
  }
  if (others) phrases.push(others === 1 ? 'usar otra herramienta' : `usar ${others} herramientas más`);
  const what = joinSpanish(phrases.slice(0, 4));
  return took ? `Decidió en ${took}: ${what}` : `Decidió: ${what}`;
}

function liveSearchQuery(value) {
  try {
    // The query the search really runs: URLs reduced to their origin.
    return require('../orchestration/gateway-adapter').sanitizeWebSearchQuery(value);
  } catch (_) {
    return String(value || '').replace(/https?:\/\/\S+/gi, '[URL]');
  }
}

// The one argument that says what a tool call is about, when its label does
// not already show it (a web domain, a path, a file name…). Never code or
// secrets: a URL is reduced to its domain (a signed URL, `?token=` or an
// OAuth `?code=&state=` callback never reaches the timeline) and a query is
// sanitized and capped at 60 chars.
function liveArgsDetail(args, label) {
  if (!args || typeof args !== 'object') return '';
  const shown = String(label || '');
  for (const key of ['url', 'path', 'filename', 'query', 'title']) {
    const value = args[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    let text;
    if (key === 'url') text = prettyDomain(value.trim());
    else if (key === 'query') text = truncate(liveSearchQuery(value).replace(/\s+/g, ' ').trim(), 60);
    else text = truncate(value.replace(/\s+/g, ' ').trim(), 120);
    if (!text) return '';
    if (shown.includes(text.replace(/…$/, ''))) return '';
    return text;
  }
  return '';
}

function domainCount(list) {
  const domains = new Set();
  for (const item of list) {
    const url = item && (item.url || item.link || item.href);
    if (typeof url !== 'string') continue;
    try { domains.add(new URL(url).hostname.replace(/^www\./, '')); } catch (_) { /* not a URL */ }
  }
  return domains.size;
}

// A short fact about what a tool returned («12 resultados · 3 dominios»).
function liveResultDetail(obs) {
  if (!obs || typeof obs !== 'object') return '';
  const results = Array.isArray(obs.results) ? obs.results
    : (Array.isArray(obs.sources) ? obs.sources : (Array.isArray(obs.hits) ? obs.hits : null));
  if (results) {
    const n = results.length;
    if (!n) return 'Sin resultados';
    const d = domainCount(results);
    return `${turnProgressLib.fmtInt(n)} ${n === 1 ? 'resultado' : 'resultados'}${d > 1 ? ` · ${d} dominios` : ''}`;
  }
  return '';
}

// A failed tool, by category — the full cause stays in the step reasoning.
function liveErrorCategory(text) {
  const t = String(text || '');
  if (/time ?out|timed out|tiempo agotado|ETIMEDOUT/i.test(t)) return 'tiempo agotado';
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|permission|permiso|denied|denegad/i.test(t)) return 'sin permiso';
  if (/\b404\b|not found|no encontr/i.test(t)) return 'no encontrado';
  if (/ECONN|ENOTFOUND|network|fetch failed|socket hang up|conexi[oó]n/i.test(t)) return 'conexión fallida';
  if (/budget|l[ií]mite|limit|exhausted|agotad/i.test(t)) return 'límite alcanzado';
  return 'falló la ejecución';
}

function guardCategoryEs(category) {
  switch (String(category || '')) {
    case 'missing_tools': return 'faltan pasos requeridos';
    case 'E_VERIFICATION_REJECTED': return 'la respuesta no cumplía lo pedido';
    case 'E_VERIFICATION_TIMEOUT': return 'la verificación tardó demasiado';
    case 'E_CANCELLED': return 'verificación cancelada';
    default: return 'la verificación pidió ajustes';
  }
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

const SOURCE_PRESERVING_VALIDATION_FAILURE_MESSAGE =
  'No entregué el documento editado porque ninguna copia generada superó la validación de integridad. Conservé el archivo original y no generé un documento sustituto.';

// A follow-up edit of a document generated earlier in the chat that no
// editor could complete. Honest: no HTML preview or script as a substitute.
const GENERATED_DOCUMENT_EDIT_FAILURE_MESSAGE =
  'No pude editar el documento que generé antes en este chat: no logré cargar la última versión del archivo. '
  + 'No lo reemplacé por una vista HTML ni por un script. Vuelve a intentarlo o adjunta el archivo y lo edito sobre esa versión.';

// Office formats a follow-up edit can target, from the words of the request.
const OFFICE_EDIT_FORMAT_RULES = [
  { format: 'pptx', re: /\b(?:pptx?|ppts|powerpoint|presentaci[oó]n(?:es)?|diapositivas?|l[aá]minas?|slides?|deck)\b|\.pptx?\b/i },
  { format: 'docx', re: /\b(?:docx?|word)\b|\.docx?\b/i },
  { format: 'xlsx', re: /\b(?:xlsx?|excel|hoja\s+de\s+c[aá]lculo|planilla)\b|\.xlsx?\b/i },
];
const OFFICE_EDIT_FORMATS = new Set(['pptx', 'pptm', 'potx', 'docx', 'docm', 'dotx', 'xlsx', 'xlsm', 'xltx']);
// What the loop produced INSTEAD of the document (incident: .html + .py).
const OFFICE_SUBSTITUTE_FORMATS = new Set(['html', 'htm', 'py', 'js', 'ts', 'md', 'markdown', 'txt', 'json', 'svg', 'png', 'jpg', 'jpeg', 'csv', 'sh']);

function officeFormatsNamedIn(text = '') {
  const t = String(text || '');
  return OFFICE_EDIT_FORMAT_RULES.filter((rule) => rule.re.test(t)).map((rule) => rule.format);
}

// pptm → pptx, dotx → docx…: the family the honesty check accepts.
function officeEditFamily(format) {
  const f = String(format || '').toLowerCase().replace(/^.*\./, '');
  if (!OFFICE_EDIT_FORMATS.has(f)) return null;
  return f.startsWith('ppt') || f === 'potx' ? 'pptx' : f.startsWith('doc') || f === 'dotx' ? 'docx' : 'xlsx';
}

// A generated artifact the chat loop cannot edit (no upload to mount): the
// follow-up goes to the AgentRunner or ends honestly.
const GENERATED_EDIT_TARGET_FORMATS = new Set([...OFFICE_EDIT_FORMATS, 'pdf']);

// The user explicitly asks for ANOTHER format or a derived output (a
// dashboard, a page, markdown, a summary…): not a same-file Office edit, so
// create_artifact stays and html / md / csv outputs are the deliverable.
const NON_OFFICE_DELIVERABLE_RE = /\b(?:html?|p[aá]gina\s+web|sitio\s+web|landing|dashboard|tablero|markdown|md|csv|json|png|jpe?g|svg|script|python)\b|\b(?:convi[eé]rt\w*|convert\w*|exp[oó]rta\w*|export|transforma\w*|pasa(?:lo|la|los|las|r)?\s+a|p[aá]sa(?:lo|la|los|las)\s+a|guarda(?:lo|la|r)?\s+como|res[uú]m(?:e|es|ir|elo|ela|eme|emelo|id[oa])|extr[aá](?:e|er|elo|ela|igas?)|extract\w*|summari[sz]\w*)\b/i;
function requestsNonOfficeDeliverable(text = '') {
  return NON_OFFICE_DELIVERABLE_RE.test(String(text || ''));
}

function isQuestionOrAdviceTurn(text = '') {
  try {
    return require('./agent-runner').isQuestionOrAdviceRequest(text);
  } catch (_) {
    return /\?\s*$/.test(String(text || '').trim());
  }
}

function artifactFormatOf(artifact = {}) {
  const fromFormat = String(artifact.format || '').toLowerCase().replace(/^\./, '');
  if (fromFormat) return fromFormat;
  const name = String(artifact.filename || artifact.name || '');
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function officeEditSubstituteMessage(formats = []) {
  const noun = formats.length === 1
    ? ({ pptx: 'la presentación', docx: 'el documento de Word', xlsx: 'el libro de Excel' }[formats[0]] || 'el documento')
    : 'el documento';
  return `No pude editar ${noun} en este turno, así que no lo doy por terminado: no lo reemplazo por una página HTML ni por un script. `
    + 'El archivo original no se modificó. Vuelve a intentarlo y lo edito sobre la última versión.';
}

function sourcePreservingResultValidation(item) {
  return item?.validation || item?.artifact?.validation || null;
}

function isValidatedSourcePreservingResult(item) {
  return Boolean(item?.artifact?.id && sourcePreservingResultValidation(item)?.passed === true);
}

function isSourcePreservingValidationError(err) {
  return Boolean(
    err?.validationOnlyFailure
    || err?.code === 'DOCUMENT_BATCH_EDIT_FAILED'
    || err?.code === 'SOURCE_PRESERVING_VALIDATION_FAILED'
  );
}

// Turn the model's per-step "thought" into a clean, user-facing reasoning
// line for the chat timeline (Claude-style transparency). Strips code fences,
// tool-state/JSON blobs and tool-call syntax, collapses whitespace, and caps
// the length so the narration stays a tidy 1-2 sentences.
const REASONING_MAX_CHARS = Number(process.env.AGENTIC_REASONING_MAX_CHARS) || 280;
function sanitizeReasoning(raw) {
  let s = String(raw == null ? '' : raw);
  if (!s.trim()) return '';
  s = s.replace(/```[\s\S]*?```/g, ' ');           // drop fenced blocks
  s = s.replace(/\{[\s\S]*\}/g, ' ');               // drop JSON-ish blobs
  s = s.replace(/<\/?[^>]+>/g, ' ');                // drop stray tags
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // Skip lines that are still just an identifier / tool name.
  if (/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+$/i.test(s)) return '';
  if (s.length > REASONING_MAX_CHARS) s = `${s.slice(0, REASONING_MAX_CHARS - 1).trim()}…`;
  return s;
}

// Normalise a failed tool observation's error into a short, single-line,
// user-facing message. A tool failure (web_fetch timeout, python_exec raise,
// bad args, permission denied…) should tell the user WHY it failed instead of
// rendering a bare red badge with no detail — Claude-style transparency.
// Handles string | Error | { error|message|detail|reason } observation shapes.
function extractObservationError(obs) {
  if (!obs || typeof obs !== 'object') return '';
  let raw = obs.error != null ? obs.error : obs.message;
  if (raw == null) return '';
  if (raw instanceof Error) {
    raw = raw.message || String(raw);
  } else if (typeof raw === 'object') {
    raw = raw.message || raw.error || raw.detail || raw.reason
      || (() => { try { return JSON.stringify(raw); } catch { return ''; } })();
  }
  const s = String(raw).replace(/\s+/g, ' ').trim();
  if (!s || s === '[object Object]') return '';
  return truncate(s, 200);
}

const { buildAgentHistoryBlock, textFromMessageContent, AGENT_HISTORY_MAX_CHARS } = require('./agents/conversation-history');

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


function buildThreadWorkContext(history, userQuery, { includeTranscript = true } = {}) {
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

  if (includeTranscript && goals.length) {
    lines.push('', 'Standing user goals inferred from this thread:', ...goals.map(goal => `- ${truncate(goal, 900)}`));
  }
  if (includeTranscript && recentTurns) {
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
  // kimi-k2 included: Moonshot Kimi K2.6 (via OpenRouter) emits tool calls in
  // its native `<|tool_call_begin|>functions.x` token format rather than OpenAI
  // `tool_calls`. react-agent now PARSES that native format (parseNativeToolCalls)
  // so the agentic loop drives Kimi correctly instead of leaking raw markup.
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
    // moonshotai/kimi-k2.6 included — its native tool-token format is parsed by
    // react-agent (parseNativeToolCalls). anthropic/claude + x-ai/grok support
    // OpenAI-normalised tool_calls via OpenRouter, so they reach the loop too.
    return /(openai\/(gpt-4|gpt-4o|gpt-4\.1|gpt-5|o3|o4)|google\/gemini-(1\.5|2|2\.5|3)|deepseek\/|moonshotai\/kimi-k2\.6|anthropic\/claude|x-ai\/grok)/i.test(m);
  }
  return false;
}

function envFlagEnabled(raw, defaultOn = true) {
  if (raw == null || String(raw).trim() === '') return defaultOn;
  const v = String(raw).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** Prompted tool-calling (models without native function calling) — default ON. */
function promptedToolsEnabled() {
  return envFlagEnabled(process.env.SIRAGPT_PROMPTED_TOOLS, true);
}

/** Optional agent-first chat (every non-trivial turn enters the agentic loop). */
function agentFirstEnabled() {
  return envFlagEnabled(process.env.SIRAGPT_AGENT_FIRST, false);
}

/**
 * Tool-calling fallback ladder: how should THIS provider+model drive the
 * agentic loop?
 *   'native'   — OpenAI-style tool_calls (allowlisted families).
 *   'prompted' — tools described in the system prompt, fenced-JSON calls
 *                parsed back (any other chat-completions model).
 *   'none'     — prompted mode disabled by env → keep the legacy hard gate.
 */
function resolveToolCallMode(provider, model) {
  // The harness capability registry (per-family table seeded as a superset
  // of the legacy allowlist + SIRAGPT_MODEL_CAPS_OVERRIDES / settings
  // overrides) is the AUTHORITATIVE verdict — overrides can force a model
  // onto the prompted ladder both ways. The legacy regex allowlist only
  // backs it up if the registry itself fails to load.
  try {
    const caps = require('./agent-harness/model-capabilities');
    if (caps.supportsNativeToolTransport(provider, model)) return 'native';
  } catch (_) {
    if (modelSupportsFunctionCalling(provider, model)) return 'native';
  }
  return promptedToolsEnabled() ? 'prompted' : 'none';
}

const SIMPLE_CHAT_PROMPT = /^\s*(hola|hi|hello|hey|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|gracias|thanks|ok|vale|listo|perfecto|sí|si|no|test|prueba)[.!?¡¿\s]*$/i;
const DIRECT_ONLY_PROMPT = /^\s*(?:responde|contesta|reply|answer)\s+(?:únicamente|unicamente|solo|solamente|only)\s*:?[\s\S]{1,120}$/i;
const AGENTIC_PROMPT_HINT = /\b(clon|repo|repositorio|github|git|commit|push|pr|pull ?request|deploy|despleg|codex|cursor|claude.?code|program|c[oó]digo|refactor|mejora|arregla|corrige|no.?funciona|no.?sirve|todav[ií]a|sigue|contin[uú]a|investiga|busca|fuentes?|cita|web|internet|actual|reciente|pdf|documento|archivo|excel|word|ppt|tabla|analiza|compara|genera.?archivo|descargable|aut[oó]nom|background|segundo.?plano|meses?|semanas?|historial|sesiones?|conversaci[oó]n(?:es)?|navegador|browser|naveg|scrap|rasp|extrae.?web|click|clic|scroll|desplaz|\b\/goal\b|\b\/plan\b)\b/i;

// Stop reasons that already delivered a user-facing answer (and often
// file_artifact cards). /api/ai/generate MUST keep these — treating them as
// "degraded" wiped the edited Office file and let the plain LLM invent
// "No puedo crear la presentación debido a limitaciones técnicas".
const HANDLED_AGENTIC_STOP_REASONS = new Set([
  'finalized',
  'plain_text_finalize',
  'finalized_last_step_guard_override',
  'source_preserving_document_edit',
  'source_preserving_document_validation_failed',
  'source_preserving_document_edit_failed',
  'image_edit_clarification_needed',
  'agent_runner',
  // The AgentRunner claimed the turn but could not deliver a verified file
  // (credits/model/verification). The honest Spanish error IS the final
  // answer — never fall through to the plain stream or the generic pipeline.
  'agent_runner_failed',
  'generated_artifact_read_failed',
  // A direct byte comparison has already produced the final, verified result
  // (or an honest read error). The HTTP route must not ask a model to replace it.
  'generated_artifact_compare_verified',
  'generated_artifact_compare_failed',
  // GitHub CONSTRUIR pre-loop (OAuth CTA or isolated open). Falling through
  // to the plain stream was collapsing these into «Conexión no disponible».
  'github_open_repo',
  'github_repo_connect',
  'github_connection_required',
  'github_repo_preloop_error',
  'project_clone_repo',
  'project_preview_start',
  'project_preview_error',
]);

/**
 * True when the agentic turn already finished honestly and the chat route
 * must persist that answer instead of falling through to the plain stream.
 *
 * @param {{ stoppedReason?: string, finalAnswer?: string } | null} result
 * @returns {boolean}
 */
/**
 * The AgentRunner's preflight E_PROVIDER for a picked model whose provider
 * has no connection: «No pude generar el documento. <modelo> no pudo
 * responder: su conexión no está configurada. …» (owner policy: the model by
 * its display name and the exact cause). null for any other failure.
 */
async function runnerUnconfiguredAnswer(failure, provider, model, prisma = null) {
  if (!failure || failure.reason !== 'E_PROVIDER') return null;
  try {
    const runner = require('./agent-runner');
    if (typeof runner.runnerUnconfiguredFailureMessage !== 'function') return null;
    return (await runner.runnerUnconfiguredFailureMessage(runner.runnerModelSpec(provider, model), { prisma })) || null;
  } catch (_) {
    return null;
  }
}

function isHandledAgenticChatResult(result) {
  if (!result || typeof result !== 'object') return false;
  const reason = String(result.stoppedReason || '').trim();
  if (!reason) return false;
  const answer = typeof result.finalAnswer === 'string' ? result.finalAnswer.trim() : '';
  if (!answer || answer === '(agent returned empty message)') return false;
  if (HANDLED_AGENTIC_STOP_REASONS.has(reason)) return true;
  return reason.startsWith('finalized_guard_breaker')
    || reason.split(':', 1)[0] === 'verification_failed'
    || reason === 'invalid_resume_checkpoint'
    || reason === 'resume_budget_exhausted';
}

/**
 * Decide whether a normal chat turn should enter the agentic loop.
 *
 * Tool-intent routing keeps ordinary conversation on the lower-latency plain
 * stream and enters the agent only when the request needs search, tools,
 * artifacts, files, browser work, or an explicit operator opt-in:
 *   - greetings / trivial smalltalk (SIMPLE_CHAT_PROMPT),
 *   - exact short-answer directives (DIRECT_ONLY_PROMPT),
 *   - plain Q&A over an attached document (its text is already injected
 *     into the prompt; the loop adds latency without adding capability).
 * Operators can restore agent-first behavior with SIRAGPT_AGENT_FIRST=1.
 */
function shouldUseAgenticChat({ prompt, history = [], files = [], customGptCapabilities = null, hasPriorArtifacts = false, chip = null } = {}) {
  const text = String(prompt || '').trim();
  if (!text) return false;
  try {
    const { routeTurn } = require('./turn-router');
    const decision = routeTurn({ text: prompt, attachments: files, chip });
    if (decision.trivial === true || decision.rule_id === 'R_TRIVIAL' || decision.rule_id === 'R_CHIP') {
      return false;
    }
  } catch (_) { /* optional at load */ }
  const hasFiles = Array.isArray(files) && files.length > 0;
  if (SIMPLE_CHAT_PROMPT.test(text) && !hasFiles && !chip) return false;
  try {
    const { isTrivialChatTurn } = require('./trivial-turn');
    if (isTrivialChatTurn(text, { attachments: files, chip })) return false;
  } catch (_) { /* optional at load */ }
  if (DIRECT_ONLY_PROMPT.test(text)) return false;
  try {
    const { shouldRunAgentRunner } = require('./agent-runner');
    if (shouldRunAgentRunner({ files, text, hasPriorArtifacts })) return true;
  } catch (_) { /* agent-runner optional at load */ }
  const customGptPolicy = resolveCustomGptAgentPolicy({
    prompt: text,
    capabilities: customGptCapabilities,
  });
  if (/^\s*\/(goal|plan)\b/i.test(text)) return true;
  if (isCognitionUpgradeRequest(text)) return true;
  // ── Attachment turns ──────────────────────────────────────────────────
  // A doc is attached: its text is ALREADY injected into the prompt
  // (`Attached files:` / RAG evidence), so the answer comes FROM the doc.
  // Only escalate to the agentic loop when the user wants a tool-backed
  // DELIVERABLE built from it (Word/PDF/Excel/table/chart/diagram/slides…).
  // Plain Q&A and summaries answer DIRECTLY via the reliable plain stream —
  // fast, no "Analizando solicitud" stall (the old `files.length>0 → true`
  // sent every doc turn through the react-agent loop, which on weak
  // tool-callers like Kimi stalls until the 90s timeout and forced the user
  // to hit Regenerate). The gate requires a creation verb AND an artifact noun
  // ("genera una tabla en Excel", "conviértelo a PDF"); a bare reference word
  // ("qué dice el documento", "el presupuesto") or a doc-SUBJECT word
  // ("investigación", "análisis") stays on the plain stream — so a simple
  // "cuál es el título de la investigación?" answers directly, fast.
  if (Array.isArray(files) && files.length > 0) {
    // Edit requests ("edita mi documento", "corrige el excel") also need the
    // loop: that's where document_edit (Cowork editing) lives. Merge requests
    // ("combina estos 2 words en 1") equally — the deterministic docx merge
    // fast-path lives inside document_edit.
    try {
      const { isDocumentMergeRequest } = require('./agents/document-merge');
      if (isDocumentMergeRequest(text, { fileCount: files.length })) return true;
    } catch (_) { /* detector is best-effort */ }
    // An attached picture + an edit / reference-guided image request lives in
    // the loop (edit_image): the plain stream would drop the reference pixels.
    const hasImageAttachment = files.some((f) => f && (/^image\//i.test(String(f.mimeType || f.type || f.contentType || '')) || f.attachmentKind === 'image'));
    if (hasImageAttachment) {
      try {
        if (detectMediaIntents(text, { hasImageAttachment: true })
          .some((i) => i && (i.kind === 'image-edit' || (i.tool === 'generate_image' && i.confidence === 'high')))) return true;
      } catch (_) { /* detector is best-effort */ }
    }
    return isArtifactDeliverableRequest(text)
      || isDocumentEditRequest(text)
      || customGptPolicy.requiresSkill;
  }
  if (isGithubRepoWorkRequest(text)) return true;
  if (AGENTIC_PROMPT_HINT.test(text)) return true;
  // Typo-tolerant media detection (canonicalised text): «cre aun aimgen de
  // un gato» must reach the loop where generate_image lives.
  try {
    if (detectMediaIntent(text).confidence === 'high') return true;
  } catch (_) { /* detector is best-effort */ }
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
  if (recent
      && /\b(repo|github|commit|deploy|despleg|archivo|documento|pdf|excel|word|investiga|fuentes?|no.?funciona|todav[ií]a)\b/i.test(recent)
      && /\b(sigue|contin[uú]a|hazlo|dale|arregla|corrige|eso|todav[ií]a|no.?funciona|no.?sirve)\b/i.test(text)) {
    return true;
  }

  // Custom GPTs can opt into an automatic agent runtime. This routes every
  // non-trivial turn through the bounded ReAct loop while still letting the
  // model decide whether a skill is actually necessary. Greetings, exact
  // short-answer directives and simple attachment Q&A remain on the fast path.
  if (customGptPolicy.routeNonTrivial) return true;

  // Normal chat stays on the plain stream unless the operator explicitly
  // opts into agent-first behavior.
  return agentFirstEnabled();
}

  function isStandaloneSavXlsxMatrixRequest(userQuery, matrix) {
    if (!matrix) return false;
    const normalized = String(userQuery || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/\s+/g, ' ').trim();
    // This complete-request grammar covers the simple two-file request only.
    // Any additional clause or output, however phrased, keeps the model's
    // python_exec gate; a file parity check cannot prove an extra analysis.
    const match = normalized.match(/^(?:dame|crea(?:me)?|genera(?:me)?|prepara(?:me)?|hazme)\s+un(?:os)?\s+(?:documentos?|archivos?)\s+de\s+spss\s+con\s+una\s+muestra\s+de\s+(\d{1,5})\s+de\s+(\d{1,3})\s+preguntas?\s+y\s+un\s+excel(?:[.!?]\s*usa\s+solo\s+datos\s+sinteticos)?[.!?]?$/);
    return !!match
      && Number(match[1]) === matrix.rows
      && Number(match[2]) === matrix.columns;
  }

  function buildChatFinalizeProfile({
    userQuery,
    fileIds = [],
    fileMetadata = [],
    hasImageAttachment = false,
    hasRecentImage = false,
    availableToolNames = new Set(),
    artifactDeliveryContract = null,
  } = {}) {
    const kinds = classifyAttachmentKinds(fileMetadata);
    const imageOnlyFallback = hasImageAttachment === true
      && Array.isArray(fileIds) && fileIds.length > 0
      && kinds.documentCount === 0;
    const effectiveMetadata = kinds.total > 0
      ? fileMetadata
      : (imageOnlyFallback
        ? fileIds.map((id) => ({ id, mimeType: 'image/*' }))
        : []);
    const profile = buildExecutionProfile({ goal: userQuery, fileIds, fileMetadata: effectiveMetadata, hasImageAttachment, hasRecentImage });
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
    // Read-only Q&A over an attachment ("dame un resumen en un solo párrafo")
    // is answered from the already-injected document text. Requiring
    // docintel_analyze/rag_retrieve as a HARD finalize gate turned judge-proof
    // summaries into verification_failed dead-ends: #715 fail-opened the
    // answer verifier, but this gate runs FIRST in the composed guard and
    // blocked before that fail-open was ever consulted. The tools stay
    // available and the quality gates keep recommending them — only the hard
    // block is waived, and only for read-only intents (create/search/edit
    // queries never classify as read-only).
    let gateTools = profile.requiredTools || [];
    try {
      const { isReadOnlyQaIntent } = require('./agents/completion-claim-verifier');
      if (isReadOnlyQaIntent(userQuery)) {
        gateTools = gateTools.filter((tool) => tool !== 'docintel_analyze' && tool !== 'rag_retrieve');
      }
    } catch (_) { /* fail-open to legacy gating */ }
    // SAV/XLSX matrix delivery is checked against the actual file bytes by
    // validateSavXlsxDelivery. That server-side comparison performs the
    // computation, but is not a model tool step; requiring an additional
    // python_exec call would reject a fully verified pair before it is read.
    // Independent calculations requested alongside the files still need
    // their own execution proof; comparing matrices cannot prove those.
    if (artifactDeliveryContract?.active
      && artifactDeliveryContract.savXlsxMatrix
      && isStandaloneSavXlsxMatrixRequest(userQuery, artifactDeliveryContract.savXlsxMatrix)) {
      gateTools = gateTools.filter((tool) => tool !== 'python_exec');
    }
    const requiredTools = gateTools.filter((tool) => available.has(tool));
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

  function buildPersistedContent(state, finalAnswer) {
    const answer = String(finalAnswer || '').trim();
    const artifacts = Array.isArray(state?.artifacts) ? state.artifacts : [];
    if (artifacts.length === 0) return answer;

    // The live sentinel contains the complete, frequently-updated timeline.
    // History already hydrates that timeline from agent_metadata, so persist
    // only the deliverables required to rebuild preview/download cards after a
    // reload. This keeps the message compact and avoids billing UI state as
    // model output tokens.
    const persistedState = {
      meta: state?.meta || {},
      steps: [],
      artifacts,
      approvals: [],
      checkpoints: [],
      qualityGates: [],
      repairs: [],
      finalText: answer,
      done: true,
    };
    return `${serializeSentinel(persistedState)}\n\n${answer}`;
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
  /**
   * Wrapper: whatever path the turn takes (throw, abort, early return), the
   * Cowork run created for it must not stay `running` and hold one of the
   * plan's concurrency slots. finishRun is idempotent on terminal rows, so
   * the normal completion/failure paths inside remain the source of truth.
   */
  async function runAgenticChat(opts) {
    const toolContext = (opts && opts.toolContext) || null;
    let outcome = 'completed';
    try {
      return await runAgenticChatInner(opts);
    } catch (err) {
      outcome = (opts && opts.signal && opts.signal.aborted) || /cancel|abort/i.test(String((err && (err.code || err.message)) || ''))
        ? 'cancelled'
        : 'failed';
      await closeDanglingCoworkRun(toolContext, outcome, err);
      throw err;
    } finally {
      if (toolContext && toolContext.__coworkHeartbeat) {
        try { clearInterval(toolContext.__coworkHeartbeat); } catch (_) { /* noop */ }
        toolContext.__coworkHeartbeat = null;
      }
      if (outcome === 'completed') await closeDanglingCoworkRun(toolContext, 'completed', null);
    }
  }

  async function closeDanglingCoworkRun(toolContext, status, err) {
    if (!toolContext || !toolContext.coworkRunId || !toolContext.prisma || !toolContext.userId) return;
    try {
      const controlPlane = require('./cowork/control-plane');
      const run = await controlPlane.getOwnedRun(toolContext.prisma, { runId: toolContext.coworkRunId, userId: toolContext.userId });
      if (controlPlane.TERMINAL_STATUSES.has(run.status)) return;
      // A normal return only closes a run the loop left `running`/`queued`;
      // paused / waiting_approval runs are the user's, not a leak.
      if (status === 'completed' && run.status !== 'running' && run.status !== 'queued') return;
      await controlPlane.finishRun(toolContext.prisma, {
        runId: toolContext.coworkRunId,
        userId: toolContext.userId,
        status,
        lastEvent: err
          ? String((err && err.message) || err).slice(0, 4000)
          : 'Turno terminado (cierre de seguridad)',
      });
    } catch (_) { /* best-effort: the stale-run reaper is the backstop */ }
  }

  async function runAgenticChatInner(opts) {
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
      toolCallMode = 'native',
      provider = null,
      // Composer "Esfuerzo" level forwarded to every loop step (see
      // react-agent thinkingLevel).
      thinkingLevel = null,
      thinkingLevelExplicit = false,
      // Extracted text of the user's attached documents (already budget-capped
      // by the caller). Injected directly into the system prompt so the agentic
      // loop ALWAYS sees the content — rag_retrieve becomes a fallback for deep
      // search, not the only path. Empty string when there are no attachments.
      attachedDocuments = '',
      // Custom-GPT persona block (the "CUSTOM GPT EXECUTION CONTRACT" already
      // built by the caller via masterPrompt.buildCustomGptPromptBlock). The
      // agentic loop used to drop it entirely, so a selected GPT didn't follow
      // its own instructions. Injected at the TOP of extraSystem for primacy.
      customGptPersona = '',
      // RLCD × Jev web-search judgement for this turn: { need, tool, freshness,
      // force, suggest }. force → the loop opens with the search tool; suggest →
      // the model is told the answer needs current sources; freshness → default
      // recency window when the model omits it.
      webSearchIntent = null,
      // { sources } when the route already injected fresh web results
      // («Fresh Web Context») into this turn's system prompt.
      webGrounding = null,
      // Per-GPT tool capability toggles (null = legacy GPT → no gating).
      customGptCapabilities = null,
      // Semantic skill-plan ids from the preflight router. These are advisory
      // and are mapped to concrete filesystem skills by the custom-GPT policy.
      customGptSkillPlan = null,
      // Creator-defined external API Actions (CustomGpt.actions, stored shape
      // WITH the encrypted auth secret). Built into agent tools below.
      customGptActions = null,
      // U3: optional turn-policy snapshot (observe/enforce). Observe mode only
      // attaches telemetry + shadow diffs; never changes tool/routing behaviour.
      turnPolicy = null,
      // RLHF phase-2 few-shot block (already retrieved by /generate). Empty
      // string when steering missed or was skipped. Fail-open: never required.
      preferenceBlock = '',
      // Agent Skills the user activated in the composer («+ → Skills»),
      // already rendered by chat-skills.buildSelectedSkillsBlock. Optional.
      selectedSkillsBlock = '',
      // Live progress of the turn (services/turn-progress, owned by the
      // route): the loop's model calls become `agent_model` rows. Optional.
      progress = null,
      // Request brief of the turn (services/request-brief publicRequestBrief)
      // and its rendered system block. The brief settles the two follow-up
      // cases the regex claims get wrong: an edit aimed at the previous
      // ANSWER never goes to the document editor / runner; a style edit
      // aimed at the generated Office file always does.
      requestBrief = null,
      requestBriefBlock = '',
    } = opts || {};
    const briefTargetsPreviousAnswer = Boolean(requestBrief && requestBrief.target && requestBrief.target.kind === 'previous_answer'
      && ['edit', 'transform', 'continue', 'analyze'].includes(requestBrief.action));
    const briefTargetsGeneratedOffice = Boolean(requestBrief && requestBrief.target && requestBrief.target.kind === 'generated_artifact'
      && /^(?:docx|pptx|xlsx|pdf)$/.test(String(requestBrief.target.format || ''))
      && ['edit', 'transform'].includes(requestBrief.action));

    if (!openai) throw new Error('runAgenticChat: openai client is required');
    if (!model)  throw new Error('runAgenticChat: model is required');
    if (!userQuery) throw new Error('runAgenticChat: userQuery is required');
    if (toolContext && typeof toolContext === 'object') {
      toolContext.userQuery = toolContext.userQuery || userQuery;
      toolContext.goal = toolContext.goal || userQuery;
    }
    const { historyHasRecentImage } = require('./media/image-followup-context');
    const imageAttached = toolContext.hasImageAttachment === true
      || (Array.isArray(toolContext.fileMetadata) && toolContext.fileMetadata.some((f) => f && /^image\//i.test(String(f.mimeType || f.type || ''))));
    const recentImage = !imageAttached && historyHasRecentImage(history);
    let imageEditTurn = false;
    try {
      imageEditTurn = (imageAttached || recentImage)
        && detectMediaIntents(userQuery, { hasImageAttachment: imageAttached, hasRecentImage: recentImage })
          .some((i) => i && i.kind === 'image-edit');
    } catch (_) { /* detector is best-effort */ }
    toolContext.hasRecentImage = recentImage;
    const githubHandoffModule = require('./github/github-chat-handoff');
    const githubHandoff = githubHandoffModule.createGithubChatHandoff({
      userId: toolContext.userId, chatId: toolContext.chatId, signal,
      emit: payload => writeSse(res, payload),
    });
    const codingWorkspace = Boolean(toolContext.codingWorkspace?.projectId);
    const softwareBuildTurn = !codingWorkspace && isSoftwareBuildRequest(userQuery) && !isExplicitDocumentRequest(userQuery);
    const githubPrTurn = !codingWorkspace && isGithubPrRequest(userQuery);
    const githubLocalPreviewTurn = !codingWorkspace && isGithubLocalPreviewRequest(userQuery);
    if (!res) throw new Error('runAgenticChat: res is required');

    // DETERMINISTIC EDIT PRE-LOOP (mirrors agent-task-runner): when the user
    // attached a document and asked to edit it, run the surgical
    // source-preserving editor BEFORE the LLM loop. Without this, weak models
    // answer in prose / call create_document / docintel and the user never gets
    // an edited copy of THEIR file.
    // Fail-open ONLY for unexpected errors. Known "needle not found" errors
    // surface a clear Spanish message so the user can rephrase — never route
    // a clear edit request into docintel analysis.
    const preloopFileIds = Array.isArray(toolContext.fileIds)
      ? toolContext.fileIds.map(String).filter(Boolean)
      : [];
    const explicitGithubConnectRequest = preloopFileIds.length === 0 && githubHandoffModule.isGithubConnectRequest(userQuery);
    const generatedArtifactRefs = !codingWorkspace && preloopFileIds.length === 0
      ? await require('./agents/generated-artifact-followup').resolveChatGeneratedArtifactFollowup(
        toolContext.prisma,
        { userId: toolContext.userId, chatId: toolContext.chatId, providedFileIds: [], goal: userQuery },
      )
      : [];
    if (generatedArtifactRefs.length) toolContext.generatedArtifactRefs = generatedArtifactRefs;
    const redactGeneratedArtifactText = (value) => {
      let safe = String(value || '');
      if (!generatedArtifactRefs.length) return safe;
      for (const ref of generatedArtifactRefs) safe = safe.split(String(ref.id)).join('[identificador interno]');
      return safe.replace(/\/?(?:app\/)?uploads\/agent-artifacts\/[^\s)\]}]+/g, '[ruta interna]');
    };
    const redactGeneratedArtifactPayload = (value) => {
      if (!generatedArtifactRefs.length) return value;
      if (typeof value === 'string') return redactGeneratedArtifactText(value);
      if (Array.isArray(value)) return value.map(redactGeneratedArtifactPayload);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactGeneratedArtifactPayload(item)]));
      }
      return value;
    };
    const safeHistory = generatedArtifactRefs.length
      ? history.map((message) => ({
        ...message,
        content: redactGeneratedArtifactText(textFromMessageContent(message?.content)
          .replace(/^```agent-task-state\n[\s\S]*?\n```\s*/, '')),
      }))
      : history;
    if (
      !codingWorkspace && preloopFileIds.length === 0 && generatedArtifactRefs.length === 0
      && toolContext.prisma
      && toolContext.userId
      && toolContext.chatId
    ) {
      try {
        const recoveredIds = await require('./message-attachments').resolveChatDocumentFileIds(
          toolContext.prisma,
          {
            userId: toolContext.userId,
            chatId: toolContext.chatId,
            providedFileIds: [],
          },
        );
        if (Array.isArray(recoveredIds) && recoveredIds.length > 0) {
          preloopFileIds.push(...recoveredIds.map(String).filter(Boolean));
          toolContext.fileIds = [...preloopFileIds];
          toolContext.recoveredFileIds = recoveredIds.map(String).filter(Boolean);
        }
      } catch (_) { /* recovery is best-effort */ }
    }
    let documentEditPreloopAttempted = false;
    let wantsNewDeckDeliverable = false;
    try {
      const { wantsNewPresentationDeliverable } = require('./agents/document-delivery-policy');
      wantsNewDeckDeliverable = wantsNewPresentationDeliverable(userQuery);
    } catch (_) { /* best-effort */ }
    // Edición milimétrica (SPEC §7 D.3): the stage timeline of an AgentRunner
    // turn, persisted with the message so a reload shows the same steps.
    let agentRunnerTrace = null;
    // Fase G: the document-edit pre-step (docx engine / office engine) streams
    // the same stage v2 timeline and persists it the same way.
    let documentEditTrace = null;
    const finishSourcePreservingPreloop = (stoppedReason, answer, artifacts = []) => {
      const finalAnswer = String(answer || '').trim();
      const reason = String(stoppedReason || '');
      let agentActivityTrace = null;
      const turnTrace = (reason === 'agent_runner' || reason === 'agent_runner_failed')
        ? agentRunnerTrace
        : (reason.startsWith('source_preserving_document') ? documentEditTrace : null);
      if (turnTrace) {
        try { agentActivityTrace = turnTrace.toMetadata(); } catch (_) { agentActivityTrace = null; }
      }
      const preloopTool = reason === 'github_connection_required' ? null : reason.startsWith('github_')
        ? 'github_open_repo'
        : reason.startsWith('project_preview')
          ? 'project_preview_start'
          : reason.startsWith('project_')
            ? 'project_clone_repo'
            : reason.startsWith('generated_artifact_compare')
              ? 'python_exec'
              : 'document_edit';
      // Turn failure tracker: an honest failure answer is still a failed
      // turn for the admin log (the user did not get the edit/preview).
      if (/(_failed|_error)$/.test(reason)) {
        try {
          require('./observability/turn-failures').noteTurn('tool_failure', {
            tool: reason.startsWith('agent_runner') ? 'agent_runner' : preloopTool,
            reason,
            fatal: true,
            message: finalAnswer.slice(0, 300),
          });
        } catch (_) { /* advisory */ }
      }
      return {
        finalAnswer,
        persistedContent: buildPersistedContent({
          meta: reason.startsWith('generated_artifact_compare')
            ? { goal: userQuery, execution: 'deterministic_python', tools: [preloopTool] }
            : { goal: userQuery, model, tools: preloopTool ? [preloopTool] : [] },
          steps: [],
          artifacts,
          approvals: [],
          checkpoints: [],
          qualityGates: [],
          repairs: [],
          finalText: finalAnswer,
          done: true,
        }, finalAnswer),
        stoppedReason,
        artifacts,
        ...(agentActivityTrace ? { agentActivityTrace } : {}),
      };
    };
    if (explicitGithubConnectRequest) {
      if (await githubHandoff.request()) {
        await writeSse(res, { replace: true, content: githubHandoffModule.GITHUB_HANDOFF_MESSAGE });
        return finishSourcePreservingPreloop('github_connection_required', githubHandoffModule.GITHUB_HANDOFF_MESSAGE);
      }
    }
    // A read-only comparison of the .sav and .xlsx just delivered is fully
    // determined by their bytes. The selected provider may take minutes or
    // decline a forced function call; neither should block this exact audit.
    // The existing Python tool rechecks owner/chat/validation and hydrates R2.
    if (generatedArtifactRefs.length) {
      const followup = require('./agents/generated-artifact-followup');
      if (followup.isGeneratedSavXlsxComparison(userQuery, generatedArtifactRefs)) {
        await writeSse(res, { type: 'stage', label: 'Comparando archivos SPSS y Excel', tool: 'python_exec' });
        const comparison = await followup.compareGeneratedSavXlsx({
          refs: generatedArtifactRefs,
          goal: userQuery,
          userId: toolContext.userId,
          chatId: toolContext.chatId,
        });
        await writeSse(res, { replace: true, content: comparison.answer });
        return finishSourcePreservingPreloop(
          comparison.ok ? 'generated_artifact_compare_verified' : 'generated_artifact_compare_failed',
          comparison.answer,
        );
      }
    }
    if (githubLocalPreviewTurn && toolContext.userId) {
      try {
        const previewTools = require('./agents/project-preview-tools');
        const svc = (toolContext.projectTools && toolContext.projectTools.previewService)
          || require('./codex/chat-preview.service');
        const deps = previewTools._internal.depsFromCtx(toolContext);
        const repoRef = extractGithubHttpsUrl(userQuery) || extractOwnerRepo(userQuery);
        if (!repoRef) {
          const answer = 'Indica el repositorio como https://github.com/owner/repo para clonarlo en el servidor y darte la vista previa.';
          await writeSse(res, { replace: true, content: answer });
          return finishSourcePreservingPreloop('project_preview_error', answer, []);
        }
        const repoUrl = repoRef.url || `https://github.com/${repoRef.owner}/${repoRef.repo}`;
        const preferredPort = extractPreferredPort(userQuery);
        await writeSse(res, { type: 'stage', label: 'Clonando el repositorio', tool: 'project_clone_repo' });
        const cloned = await svc.cloneRepoForChat({
          userId: toolContext.userId,
          chatId: toolContext.chatId,
          repoUrl,
        }, deps);
        if (!cloned || cloned.ok !== true) {
          const waiting = await githubHandoff.observe('project_clone_repo', cloned);
          const answer = waiting ? githubHandoffModule.GITHUB_HANDOFF_MESSAGE : buildLocalPreviewErrorMessage(cloned);
          await writeSse(res, { replace: true, content: answer });
          return finishSourcePreservingPreloop('project_clone_repo', answer, []);
        }
        await writeSse(res, { type: 'stage', label: 'Levantando la vista previa', tool: 'project_preview_start' });
        const preview = await svc.startPreviewForChat({
          userId: toolContext.userId,
          chatId: toolContext.chatId,
          preferredPort,
        }, deps);
        const answer = buildLocalPreviewReadyMessage({ cloned, preview, preferredPort });
        await writeSse(res, { replace: true, content: answer });
        return finishSourcePreservingPreloop(
          preview && preview.ok ? 'project_preview_start' : 'project_preview_error',
          answer,
          [],
        );
      } catch (previewPreErr) {
        if (signal?.aborted) throw previewPreErr;
        const answer = buildLocalPreviewErrorMessage({
          code: 'internal',
          message: String((previewPreErr && previewPreErr.message) || previewPreErr || 'No se pudo levantar la vista previa.'),
        });
        try {
          await writeSse(res, { replace: true, content: answer });
          return finishSourcePreservingPreloop('project_preview_error', answer, []);
        } catch (_) { /* continue the LLM loop */ }
      }
    } else if (githubPrTurn && toolContext.userId) {
      try {
        const { classifyGenerateError } = require('./ai/generate-sse-close');
        const mvp = require('./construir-mvp');
        await writeSse(res, { type: 'stage', label: 'Abriendo el repositorio', tool: 'github_open_repo' });
        const opened = await mvp.openRepo({
          userId: toolContext.userId,
          chatId: toolContext.chatId,
          userQuery,
          prompt: userQuery,
          modelAlias: model,
          fetchImpl: toolContext.fetchImpl,
          resolveToken: toolContext.resolveGithubToken,
          sandbox: toolContext.repoSandbox,
          execImpl: toolContext.repoExecImpl,
          env: toolContext.env || process.env,
        });
        if (!opened || opened.ok !== true) {
          const classified = classifyGenerateError(opened || { code: 'E_GITHUB_CONNECT' });
          const waiting = await githubHandoff.observe('github_open_repo', opened);
          const answer = waiting ? githubHandoffModule.GITHUB_HANDOFF_MESSAGE : classified.message;
          await writeSse(res, { replace: true, content: answer });
          return finishSourcePreservingPreloop('github_repo_connect', answer, []);
        }
        toolContext.githubRepoWorkspace = opened;
      } catch (githubPreErr) {
        if (signal?.aborted) throw githubPreErr;
        try {
          const { classifyGenerateError } = require('./ai/generate-sse-close');
          const classified = classifyGenerateError(githubPreErr);
          const answer = classified.message;
          await writeSse(res, { replace: true, content: answer });
          return finishSourcePreservingPreloop('github_repo_preloop_error', answer, []);
        } catch (_) { /* continue the LLM loop */ }
      }
    }
    // F2 telemetry: one structured line per document turn stating which path
    // served it. Best-effort — never breaks the turn.
    const logDocRouting = (routePath, reason) => {
      try {
        require('./agent-runner/telemetry').logDocumentRouting({
          entry: 'chat',
          path: routePath,
          reason,
          chatId: toolContext.chatId || null,
        });
      } catch (_) { /* telemetry is best-effort */ }
    };
    // Generic AgentRunner: create/edit any document without hardcoded routes
    // ("crea una ppt rosada", "ponlas blancas", follow-up "ahora rosadas").
    // When the runner CLAIMS the turn there are exactly two outcomes: a
    // verified file, or an honest error (agentRunnerFailure below). The
    // surgical source-preserving editor may still rescue an EDIT turn, but a
    // claimed turn never falls through to the LLM loop / generic document
    // pipeline — that silent fallback produced the 8-slide template decks.
    let agentRunnerClaimedTurn = false;
    let agentRunnerFailure = null;
    // The chat already holds a generated document (GeneratedArtifact row or
    // artifact metadata). Read again below: an edit of a GENERATED file has
    // no upload, so the loop's document_edit tool cannot reach it.
    let prior = false;
    // Names of this turn's uploads (format of an attached Office file).
    const uploadedFileRefs = Array.isArray(toolContext.fileMetadata)
      ? toolContext.fileMetadata.filter((file) => file && file.name)
      : [];
    // Format of the artifact this follow-up edits (latest, or the one the
    // request names): 'pptx' / 'docx' / 'xlsx' route to the runner; an html
    // page, a script or an image stays with the chat loop.
    let priorArtifactFormat = null;
    // Runs the AgentRunner on this turn. Returns the finished turn when it
    // delivered (or failed with a partial delivery); otherwise records
    // agentRunnerFailure and returns null.
    const invokeAgentRunner = async () => {
      agentRunnerClaimedTurn = true;
      try {
        const { executeAgentRunnerTurn } = require('./agent-runner');
        try {
          const { createActivityTraceCollector, createArtifactThumbSaver } = require('./agent-runner/activity-trace');
          agentRunnerTrace = createActivityTraceCollector({
            saveThumb: createArtifactThumbSaver({ userId: toolContext.userId }),
          });
        } catch (_) { agentRunnerTrace = null; }
        const runnerStartStage = { type: 'stage', label: 'Agente trabajando', tool: 'agent_runner' };
        if (agentRunnerTrace) agentRunnerTrace.push(runnerStartStage);
        await writeSse(res, runnerStartStage);
        const ran = await executeAgentRunnerTurn({
          prisma: toolContext.prisma,
          userId: toolContext.userId,
          chatId: toolContext.chatId || null,
          fileIds: preloopFileIds,
          instruction: userQuery,
          model,
          // Keep document generation on the model and provider picked in the composer.
          pickedModel: require('./agent-runner').runnerModelSpec(provider, model),
          signal,
          onEvent: (ev) => {
            Promise.resolve((async () => {
              if (ev.type === 'file_artifact' && ev.artifact) {
                await writeSse(res, { type: 'file_artifact', artifact: ev.artifact });
                return;
              }
              // F3: uniform trace — every runner step (tool_call / tool_result
              // / retry / thought / cancelled / error) becomes one canonical
              // `type: 'stage'` SSE event with a Spanish label + tool name.
              const stage = require('./agent-runner/trace').toStageEvent(ev);
              if (stage) {
                if (agentRunnerTrace) agentRunnerTrace.push(stage);
                await writeSse(res, stage);
              }
            })()).catch(() => {});
          },
        });
        if (ran && ran.ok && Array.isArray(ran.artifacts) && ran.artifacts.length) {
          await writeSse(res, { replace: true, content: ran.summary });
          logDocRouting('agent_runner');
          return finishSourcePreservingPreloop('agent_runner', ran.summary, ran.artifacts);
        }
        if (ran?.stoppedReason === 'requested_artifact_missing') {
          // The runner may have produced a useful Excel while failing to make
          // the requested SAV. Keep that card, but never claim the pair is done.
          await writeSse(res, { replace: true, content: ran.summary });
          logDocRouting('agent_runner_failed', 'requested_artifact_missing');
          return finishSourcePreservingPreloop('agent_runner_failed', ran.summary, ran.artifacts || []);
        }
        agentRunnerFailure = {
          reason: ran?.stoppedReason || 'no_output',
          detail: ran?.errorMessage || null,
        };
      } catch (agentRunnerErr) {
        if (signal?.aborted) throw agentRunnerErr;
        try { console.warn('[agentic-chat] agent-runner failed:', agentRunnerErr && agentRunnerErr.message || agentRunnerErr); } catch (_) {}
        agentRunnerFailure = {
          reason: 'exception',
          detail: agentRunnerErr?.message || String(agentRunnerErr),
        };
      }
      return null;
    };
    try {
      const {
        shouldRunAgentRunner,
        hasConversationArtifacts,
        getConversationArtifactFormat,
      } = require('./agent-runner');
      if (toolContext.prisma && toolContext.userId && toolContext.chatId) {
        try {
          prior = await hasConversationArtifacts(toolContext.prisma, {
            userId: toolContext.userId,
            chatId: toolContext.chatId,
          });
        } catch (_) { prior = false; }
        if (prior && typeof getConversationArtifactFormat === 'function') {
          try {
            priorArtifactFormat = await getConversationArtifactFormat(toolContext.prisma, {
              userId: toolContext.userId,
              chatId: toolContext.chatId,
              instruction: userQuery,
            });
          } catch (_) { priorArtifactFormat = null; }
        }
      }
      const imageIds = new Set(uploadedFileRefs
        .filter((f) => f && /^image\//i.test(String(f.mimeType || f.type || '')))
        .map((f) => String(f.id)));
      const runnerClaim = !codingWorkspace && !briefTargetsPreviousAnswer && (shouldRunAgentRunner({
        files: uploadedFileRefs,
        fileIds: preloopFileIds.filter((id) => !imageIds.has(String(id))),
        hasPriorArtifacts: prior,
        priorArtifactFormat,
        text: userQuery,
      }) || (briefTargetsGeneratedOffice && prior && uploadedFileRefs.length === 0));
      if (runnerClaim && !imageEditTurn) {
        const finished = await invokeAgentRunner();
        if (finished) return finished;
      }
    } catch (agentRunnerErr) {
      if (signal?.aborted) throw agentRunnerErr;
      try { console.warn('[agentic-chat] agent-runner failed:', agentRunnerErr && agentRunnerErr.message || agentRunnerErr); } catch (_) {}
    }
    // A DESIGN upgrade («agrégale más diseño», «hazla más profesional») is
    // not something the surgical quick editor can do: it read «agregarle un
    // poco más» as «add one slide» and appended a filler «— ampliación»
    // slide marked as done. Those turns belong to the AgentRunner only.
    let officeEditFormats = [];
    let designUpgradeTurn = false;
    let designTarget = null;
    try {
      const { isDesignUpgradeRequest, resolveDesignTarget } = require('./agent-runner');
      designTarget = resolveDesignTarget(userQuery, { priorArtifactFormat, files: uploadedFileRefs });
      designUpgradeTurn = Boolean(designTarget) && isDesignUpgradeRequest(userQuery, { officeTarget: designTarget });
    } catch (_) { designUpgradeTurn = false; }
    // A request that ALSO reads as a professional rewrite of the text («hazlo
    // más bonito y profesional el word») keeps the quick editor's
    // professional_edit as a rescue.
    let skipQuickEditorForDesign = designUpgradeTurn;
    if (skipQuickEditorForDesign) {
      try {
        const { requestWantsProfessionalEditing } = require('./source-preserving-document-edit');
        if (typeof requestWantsProfessionalEditing === 'function' && requestWantsProfessionalEditing(userQuery)) {
          skipQuickEditorForDesign = false;
        }
      } catch (_) { /* keep the skip */ }
    }
    if (
      // fileIds may be empty on a follow-up that only names ## file.pptx —
      // tryGenerate recovers the recent chat attachment via chatId.
      !codingWorkspace && (preloopFileIds.length > 0 || Boolean(toolContext.chatId))
      && toolContext.prisma
      && toolContext.userId
      && customGptCapabilities?.documents !== false
      && isDocumentEditRequest(userQuery)
      // «agrega 2 ejemplos más a tu explicación»: an edit of the answer, not
      // of a file — the surgical editor must not claim it.
      && !briefTargetsPreviousAnswer
      // Never short-circuit "realiza una ppt de 30 slides de la tesis.pdf" into
      // source-preserving PDF annex editing — that must create a fresh .pptx.
      && !wantsNewDeckDeliverable
      && !skipQuickEditorForDesign
    ) {
      try {
        const {
          isSourcePreservingEditRequest,
          tryGenerateSourcePreservingDocumentEdit,
        } = require('./source-preserving-document-edit');
        if (isSourcePreservingEditRequest(userQuery, preloopFileIds)) {
          documentEditPreloopAttempted = true;
          try {
            const { createActivityTraceCollector, createArtifactThumbSaver } = require('./agent-runner/activity-trace');
            documentEditTrace = createActivityTraceCollector({
              saveThumb: createArtifactThumbSaver({ userId: toolContext.userId }),
            });
          } catch (_) { documentEditTrace = null; }
          const editStartStage = { type: 'stage', label: 'Editando documento original', tool: 'document_edit' };
          if (documentEditTrace) documentEditTrace.push(editStartStage);
          await writeSse(res, editStartStage);
          const preserved = await tryGenerateSourcePreservingDocumentEdit({
            prisma: toolContext.prisma,
            userId: toolContext.userId,
            chatId: toolContext.chatId || null,
            fileIds: preloopFileIds,
            prompt: userQuery,
            displayPrompt: userQuery,
            signal,
            llm: { client: openai, model, provider, toolCallMode },
            onEvent: (stage) => {
              if (!stage || !stage.label) return;
              // Stage v2 frames (a tool call of the editor) keep their tool and
              // pairing fields; legacy frames stay document_edit stages.
              const frame = stage.callId
                ? { ...stage, type: 'stage' }
                : { type: 'stage', label: stage.label, ...(stage.detail ? { detail: stage.detail } : {}), tool: 'document_edit' };
              if (documentEditTrace) { try { documentEditTrace.push(frame); } catch (_) { /* trace never breaks the edit */ } }
              writeSse(res, frame).catch(() => {});
            },
          });
          if (preserved?.clarification) {
            const answer = String(preserved.content || '').trim();
            await writeSse(res, {
              replace: true,
              content: answer,
            });
            return finishSourcePreservingPreloop('image_edit_clarification_needed', answer, []);
          }
          const preservedResults = Array.isArray(preserved?.results) && preserved.results.length
            ? preserved.results
            : (preserved ? [preserved] : []);
          const validatedResults = preservedResults.filter(isValidatedSourcePreservingResult);
          const rejectedResultCount = preservedResults.length - validatedResults.length;
          const artifactEvents = validatedResults
            .map((item) => ({
              id: item.artifact.id,
              filename: item.artifact.filename,
              format: item.artifact.format,
              mime: item.artifact.mime,
              sizeBytes: item.artifact.sizeBytes,
              downloadUrl: item.artifact.downloadUrl,
              previewHtml: item.previewHtml || null,
              validation: sourcePreservingResultValidation(item),
              sourceFileId: item.sourceFileId || item.version?.sourceFileId || null,
              documentVersion: item.version || null,
            }));
          if (artifactEvents.length) {
            for (const artifact of artifactEvents) {
              await writeSse(res, { type: 'file_artifact', artifact });
            }
            const fallbackAnswer = artifactEvents.length > 1
              ? `Listo. Conservé los documentos originales y apliqué la edición solicitada en ${artifactEvents.length} archivos.`
              : 'Listo. Conservé el documento original y apliqué la edición solicitada.';
            const answer = rejectedResultCount > 0
              ? `Listo. Entregué ${artifactEvents.length} archivo(s) que superaron la validación. No entregué ${rejectedResultCount} archivo(s) inválido(s).`
              : String(preserved.content || fallbackAnswer).trim();
            await writeSse(res, { replace: true, content: answer });
            logDocRouting('source_preserving_edit', agentRunnerFailure ? `rescued_after_${agentRunnerFailure.reason}` : undefined);
            return finishSourcePreservingPreloop(
              'source_preserving_document_edit',
              answer,
              artifactEvents,
            );
          }
          if (preservedResults.length) {
            // The source-preserving editor handled the request but could not
            // prove any output safe. Never fall through to the LLM/tool loop:
            // that path can regenerate a plausible but different document.
            await writeSse(res, { replace: true, content: SOURCE_PRESERVING_VALIDATION_FAILURE_MESSAGE });
            logDocRouting('source_preserving_edit', 'validation_failed');
            return finishSourcePreservingPreloop(
              'source_preserving_document_validation_failed',
              SOURCE_PRESERVING_VALIDATION_FAILURE_MESSAGE,
              [],
            );
          }
        }
      } catch (preErr) {
        const code = preErr && preErr.code;
        const message = String(preErr && preErr.message || preErr || '').slice(0, 500);
        try {
          const validationNote = preErr && preErr.validation && Array.isArray(preErr.validation.failures)
            ? ` — ${preErr.validation.failures.slice(0, 3).map((f) => (f && (f.summary || f.label || f.code)) || '').filter(Boolean).join('; ')}`
            : '';
          console.warn('[agentic-chat] source-preserving pre-loop failed:', code ? `${code} — ${message}${validationNote}` : message);
        } catch (_) { /* noop */ }
        // Surgical not-found / ambiguous edit: tell the user instead of letting
        // a weak model call docintel_analyze and "analyze" the attachment.
        if (isSourcePreservingValidationError(preErr)) {
          const answer = SOURCE_PRESERVING_VALIDATION_FAILURE_MESSAGE;
          await writeSse(res, { replace: true, content: answer });
          logDocRouting('source_preserving_edit', 'validation_failed');
          return finishSourcePreservingPreloop(
            'source_preserving_document_validation_failed',
            answer,
            [],
          );
        }
        if (
          String(code || '').startsWith('DOCX_EDIT_')
          || code === 'REPLACE_TEXT_NOT_FOUND'
          || code === 'REPLACE_TEXT_UNSPECIFIED'
          || code === 'DOCUMENT_TITLE_NOT_FOUND'
          || code === 'DOCUMENT_TITLE_UNSPECIFIED'
          || code === 'DELETE_TEXT_NOT_FOUND'
        ) {
          const answer = message
            || 'No pude aplicar el cambio en el documento adjunto. Indica el texto exacto a reemplazar (entre comillas) y lo edito de forma quirúrgica.';
          await writeSse(res, { replace: true, content: answer });
          logDocRouting('source_preserving_edit', 'edit_failed');
          return finishSourcePreservingPreloop(
            'source_preserving_document_edit_failed',
            answer,
            [],
          );
        }
        // The editor was interrupted (TTFB watchdog / Stop / provider drop) or
        // crashed while it owned the turn. Falling through to the LLM loop
        // produced a plain answer that ECHOED the document (prod, 2026-09-25):
        // an edit turn either delivers a verified file or says it could not.
        // (Other editor errors keep the legacy loop, where document_edit is
        // still available; the route no longer "recovers" such turns with the
        // document text, so the loop cannot echo it either.)
        if (documentEditPreloopAttempted && (Boolean(signal?.aborted) || /\babort/i.test(message))) {
          const answer = 'La edición del documento se interrumpió antes de terminar (tiempo de espera o cancelación). El original no se modificó; vuelve a intentarlo.';
          await writeSse(res, { replace: true, content: answer });
          logDocRouting('source_preserving_edit', 'interrupted');
          return finishSourcePreservingPreloop('source_preserving_document_edit_failed', answer, []);
        }
      }
    }

    // Follow-up edit of a GENERATED document (no upload in this turn) that
    // the quick editor could not deliver (source not found, intent it cannot
    // plan). The loop below has no editor for generated files — document_edit
    // only mounts uploads and create_document / docintel are banned on edit
    // turns — so it used to answer with an .html preview and a .py script.
    // The AgentRunner loads the artifact (R2 included) and edits it; when it
    // cannot, the turn ends with an honest error.
    if (
      !codingWorkspace
      && documentEditPreloopAttempted
      && prior
      && preloopFileIds.length === 0
      // Only an Office / PDF artifact: follow-ups on an html page, a script,
      // a csv or an image keep the loop, which can edit those.
      && GENERATED_EDIT_TARGET_FORMATS.has(String(priorArtifactFormat || '').toLowerCase())
      // «revisa el documento y dime qué corregir» is answered in the chat.
      && !isQuestionOrAdviceTurn(userQuery)
    ) {
      if (!agentRunnerClaimedTurn) {
        const finished = await invokeAgentRunner();
        if (finished) return finished;
      }
      let answer = null;
      try {
        answer = agentRunnerFailure
          ? ((await runnerUnconfiguredAnswer(agentRunnerFailure, provider, model, toolContext.prisma || null))
            || require('./agent-runner').buildAgentRunnerFailureMessage(agentRunnerFailure.reason, agentRunnerFailure.detail))
          : null;
      } catch (_) { answer = null; }
      answer = answer || GENERATED_DOCUMENT_EDIT_FAILURE_MESSAGE;
      await writeSse(res, { replace: true, content: answer });
      logDocRouting('agent_runner_failed', `generated_document_edit_${agentRunnerFailure ? agentRunnerFailure.reason : 'no_source'}`);
      return finishSourcePreservingPreloop(
        agentRunnerFailure ? 'agent_runner_failed' : 'source_preserving_document_edit_failed',
        answer,
        [],
      );
    }

    // HARD STOP: the AgentRunner claimed this DOCUMENT turn (create-a-doc or
    // style/color follow-up) but did not deliver a file, and the surgical
    // editor above did not rescue it either. Continuing into the LLM loop
    // lets create_document fabricate a generic filler deck — exactly the
    // silent 8-slide-template fallback F1 removes. Honest Spanish error
    // instead. (Edit turns claimed via attached files keep the loop: the
    // forced document_edit path edits the user's REAL file and never touches
    // the generic document pipeline.)
    if (agentRunnerFailure) {
      let runnerOnly = true;
      let answer = null;
      try {
        const { isRunnerOnlyDocumentTurn, buildAgentRunnerFailureMessage } = require('./agent-runner');
        runnerOnly = isRunnerOnlyDocumentTurn(userQuery, { priorArtifactFormat, files: uploadedFileRefs });
        // A picked model without a connection: its name and «no configurada».
        answer = (await runnerUnconfiguredAnswer(agentRunnerFailure, provider, model, toolContext.prisma || null))
          || buildAgentRunnerFailureMessage(agentRunnerFailure.reason, agentRunnerFailure.detail);
      } catch (_) {
        answer = 'No pude generar el documento con el agente (créditos/modelo/verificación). '
          + 'Para no entregarte contenido de relleno, NO voy a usar la plantilla genérica en su lugar. Inténtalo de nuevo.';
      }
      // A full / slow document sandbox is transient infrastructure, not a
      // broken tool: the admin tracker files it as «Cancelado por el
      // sistema» (capacity) so it does not pollute «Herramienta fallida».
      if (agentRunnerFailure.reason === 'sandbox_capacity' || agentRunnerFailure.reason === 'sandbox_timeout') {
        try {
          require('./observability/turn-failures').noteTurn('tool_failure', {
            tool: 'agent_runner',
            reason: agentRunnerFailure.reason,
            category: 'capacity',
            retryable: true,
            fatal: true,
            message: String(agentRunnerFailure.detail || answer).slice(0, 300),
          });
        } catch (_) { /* advisory */ }
      }
      if (runnerOnly || agentRunnerFailure.reason === 'E_PROVIDER' || agentRunnerFailure.reason === 'E_QUOTA') {
        await writeSse(res, { replace: true, content: answer });
        logDocRouting('agent_runner_failed', agentRunnerFailure.reason);
        return finishSourcePreservingPreloop('agent_runner_failed', answer, []);
      }
      // Claimed EDIT turn continuing into the loop: document_edit (surgical)
      // stays available, but the failed-runner turn must never fabricate a
      // NEW generic document. Telemetry only — the tool ban happens below
      // once the toolset is assembled.
      logDocRouting('agent_runner_failed', `${agentRunnerFailure.reason}_edit_continues_loop`);
    }

    const customGptAgentPolicy = resolveCustomGptAgentPolicy({
      prompt: userQuery,
      capabilities: customGptCapabilities,
      semanticSkillIds: Array.isArray(customGptSkillPlan?.selectedSkillIds)
        ? customGptSkillPlan.selectedSkillIds
        : [],
    });
    const allowedSkillSet = Array.isArray(customGptAgentPolicy.allowedSkillIds)
      ? new Set(customGptAgentPolicy.allowedSkillIds)
      : null;
    let runtimeRecommendedSkillIds = Array.from(new Set([
      ...(customGptAgentPolicy.recommendedSkillIds || []),
      ...inferRecommendedSkills(userQuery, customGptSkillPlan?.selectedSkillIds || []),
    ])).filter((skillId) => !allowedSkillSet || allowedSkillSet.has(skillId));
    // RLCD × Jev skill picker (fase 2b): one Choice over the visible skill
    // catalogue; Jev's picks go first as RECOMENDADA. Fail-open, ≤1.5 s.
    try {
      const skillPicker = require('./rlcd/jev-skill-picker');
      if (skillPicker.isSkillPickerEnabled()) {
        const skillRunnerMod = require('./agents/skill-runner');
        const descriptors = typeof skillRunnerMod.listSkillDescriptors === 'function'
          ? skillRunnerMod.listSkillDescriptors({ clearance: (opts && opts.clearance) || null, ...(allowedSkillSet ? { allowedSkillIds: Array.from(allowedSkillSet) } : {}) })
          : [];
        const picked = await skillPicker.pickSkills({
          query: userQuery,
          descriptors,
          history: Array.isArray(safeHistory) ? safeHistory.slice(-2) : [],
          chatId: toolContext.chatId || null,
          ledger: require('./rlcd').ledger,
        });
        if (picked && picked.recommended.length) {
          runtimeRecommendedSkillIds = Array.from(new Set([...picked.recommended, ...runtimeRecommendedSkillIds]))
            .filter((skillId) => !allowedSkillSet || allowedSkillSet.has(skillId));
        }
      }
    } catch (_) { /* advisory */ }
    const runtimeSkillPolicy = {
      ...customGptAgentPolicy,
      recommendedSkillIds: runtimeRecommendedSkillIds,
    };
    const artifactDeliveryContract = buildArtifactDeliveryContract(codingWorkspace ? '' : userQuery, customGptAgentPolicy);

    if (toolContext?.prisma && toolContext?.userId) {
      try {
        const appRuntime = require('./apps');
        const mentionedIds = appRuntime.resolveMentionedApps(
          userQuery,
          toolContext.mentionedApps,
        );
        // Persistent pins behave like implicit mentions on every turn: the
        // user pinned the app in the composer rail, so its tools stay loaded
        // until unpinned. Only connected, available apps survive validation
        // (classifyMentions drops the rest), so a revoked token never leaks
        // a tool into the model.
        const pinnedIds = Array.isArray(toolContext.pinnedAppIds)
          ? toolContext.pinnedAppIds.slice(0, 4)
          : [];
        const rows = await appRuntime.listByUser(toolContext.prisma, toolContext.userId);
        const classified = appRuntime.classifyMentions(
          Array.from(new Set([...mentionedIds, ...pinnedIds])),
          rows,
        );
        toolContext.mentionedAppTools = appRuntime.mentionedToolNames(classified.attached);
        toolContext.mentionedAppsResolved = classified;
      } catch (mentionErr) {
        try { console.warn('[apps] mention resolve failed:', mentionErr.message); } catch (_) { /* noop */ }
      }
    }

    let tools = toolsOverride || buildDefaultTools({
      userQuery,
      selection: generatedArtifactRefs.length && selection
        ? { ...selection, signals: { ...(selection.signals || {}), hasCode: true } }
        : selection,
      clearance: toolContext && toolContext.clearance,
      capabilities: customGptCapabilities,
      skillPolicy: runtimeSkillPolicy,
      chatId: toolContext && toolContext.chatId,
      userId: toolContext && toolContext.userId,
      mentionedAppTools: toolContext && toolContext.mentionedAppTools,
    });

    // Inject this custom GPT's creator-defined Actions as agent tools. Appended
    // AFTER buildDefaultTools (so the per-turn selector cannot drop them) and
    // BEFORE the harness wrap (so each action call emits typed SSE events).
    // Only when the GPT defines actions; kill switch SIRAGPT_GPT_ACTIONS_ENABLED=0.
    // Fail-open: a builder error never breaks the turn.
    if (!toolsOverride && Array.isArray(customGptActions) && customGptActions.length) {
      const actionsGate = String(process.env.SIRAGPT_GPT_ACTIONS_ENABLED || '').trim().toLowerCase();
      if (actionsGate !== '0' && actionsGate !== 'off') {
        try {
          const { buildActionTools } = require('./gpts/gpt-actions');
          const actionTools = buildActionTools(customGptActions);
          if (actionTools.length) {
            const names = new Set(tools.map((t) => t && t.name));
            for (const at of actionTools) {
              if (at && at.name && !names.has(at.name)) { tools.push(at); names.add(at.name); }
            }
            console.log(`[gpt-actions] injected ${actionTools.length} action tool(s) for the custom GPT`);
          }
        } catch (actionErr) {
          console.warn('[gpt-actions] tool injection failed (skipping):', actionErr && actionErr.message);
        }
      }
    }

    // Activate backend plugins inside the real chat loop. Plugins can add
    // tools and observe lifecycle events, while identity, tool arguments,
    // results, and the AbortSignal remain immutable at the plugin boundary.
    // Boot failures are fail-open; explicit blocks from trusted system
    // plugins and user cancellation remain authoritative.
    let pluginLifecycle = null;
    if (!toolsOverride) {
      try {
        pluginLifecycle = await prepareAgentPluginLifecycle({
          userId: toolContext.userId || null,
          chatId: toolContext.chatId || null,
          organizationId: toolContext.activeOrganizationId || toolContext.requestedOrganizationId || null,
          signal,
        });
        tools = pluginLifecycle.addPluginSkills(tools, {
          enabled: customGptCapabilities?.skillsEnabled !== false,
          ctx: { clearance: toolContext?.clearance || null },
          allowedSkillIds: Array.isArray(customGptAgentPolicy.allowedSkillIds)
            ? customGptAgentPolicy.allowedSkillIds
            : null,
          recommendedSkillIds: Array.isArray(runtimeSkillPolicy.recommendedSkillIds)
            ? runtimeSkillPolicy.recommendedSkillIds
            : [],
        });
        tools = pluginLifecycle.addPluginTools(tools);
      } catch (pluginBootError) {
        if (pluginBootError?.code === 'ABORT_ERR') throw pluginBootError;
        console.warn('[agentic-chat] plugin lifecycle unavailable (continuing without plugins):', pluginBootError?.message || pluginBootError);
      }
    }
    // Bilingual media-intent detection: when the user asks to create an
    // image / video / audio / music in the chat bar, this pre-extracts the
    // specs (duration, aspect ratio, count, style/genre) and lets us inject a
    // directive so the agent reliably calls the matching tool with them.
    // Multi-intent: "crea un video y una foto" yields BOTH intents — the
    // primary (intents[0]) drives the forced first tool call, and the hint
    // instructs the model to call every requested tool before finalizing.
    const mediaIntents = detectMediaIntents(userQuery, {
      hasImageAttachment: Boolean(toolContext && toolContext.hasImageAttachment) || imageAttached,
      hasRecentImage: recentImage,
    });
    const mediaIntent = mediaIntents[0] || null;

    // Cowork control plane. A persisted chat gets one workspace and each
    // agentic turn gets a durable run before tools are assembled. Fail-open
    // during staged rollouts: a missing pre-migration model must not make the
    // legacy chat unavailable.
    let __coworkRun = null;
    let __coworkMemoryBlock = '';
    let __appsBlock = '';
    let __coworkHarnessEnabled = true;
    try {
      __coworkHarnessEnabled = require('./agent-harness/run-agent-turn').harnessEnabled();
    } catch (_) {
      __coworkHarnessEnabled = false;
    }
    if (
      !toolsOverride
      && __coworkHarnessEnabled
      && toolContext?.prisma?.coworkWorkspace
      && toolContext?.prisma?.coworkRun
      && toolContext?.userId
      && toolContext?.chatId
      && toolContext?.coworkDisabled !== true
    ) {
      try {
        const coworkControl = require('./cowork/control-plane');
        __coworkRun = await coworkControl.createRun(toolContext.prisma, {
          userId: toolContext.userId,
          chatId: toolContext.chatId,
          prompt: userQuery,
          kind: 'chat',
          maxSteps,
          maxCostUsd: toolContext.maxCostUsd ?? null,
          status: 'running',
        });
        toolContext.workspaceId = __coworkRun.workspaceId;
        toolContext.coworkWorkspaceId = __coworkRun.workspaceId;
        toolContext.coworkRunId = __coworkRun.id;
        const coworkMemories = await toolContext.prisma.coworkMemory.findMany({
          where: {
            userId: String(toolContext.userId),
            workspaceId: __coworkRun.workspaceId,
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { fact: true },
        });
        if (coworkMemories.length) {
          toolContext.memoryFacts = [
            ...(Array.isArray(toolContext.memoryFacts) ? toolContext.memoryFacts : []),
            ...coworkMemories.map((memory) => memory.fact),
          ];
          __coworkMemoryBlock = [
            '=== MEMORIA DEL WORKSPACE COWORK ===',
            ...coworkMemories.map((memory) => `- ${String(memory.fact).slice(0, 1000)}`),
            '=== FIN MEMORIA DEL WORKSPACE ===',
          ].join('\n');
        }
        await writeSse(res, {
          type: 'cowork_run_started',
          run: {
            id: __coworkRun.id,
            workspaceId: __coworkRun.workspaceId,
            status: __coworkRun.status,
            maxSteps: __coworkRun.maxSteps,
            maxCostUsd: __coworkRun.maxCostUsd,
            checklist: __coworkRun.checklist || [],
          },
        });
      } catch (coworkError) {
        try {
          require('./cowork/control-plane').logBootstrapFailure(coworkError);
        } catch (_) { /* noop */ }
      }
      if (__coworkRun) {
        // Heartbeat: a live turn keeps `updatedAt` fresh even during one long
        // step, so reapStaleRuns (15 min without progress) never closes it.
        // Cleared in the runAgenticChat wrapper (finally) whatever happens.
        try {
          const controlPlane = require('./cowork/control-plane');
          const heartbeat = setInterval(() => {
            controlPlane.touchRun(toolContext.prisma, { runId: __coworkRun.id, userId: toolContext.userId }).catch(() => {});
          }, controlPlane.heartbeatIntervalMs());
          heartbeat.unref?.();
          toolContext.__coworkHeartbeat = heartbeat;
        } catch (_) { /* heartbeat is best-effort */ }
      }
    }

    if (toolContext?.prisma && toolContext?.userId) {
      try {
        const appRuntime = require('./apps');
        __appsBlock = await appRuntime.buildUserAppsPrompt(toolContext.prisma, toolContext.userId, {
          prompt: userQuery,
          mentionedApps: Array.isArray(toolContext.mentionedApps) ? toolContext.mentionedApps : [],
        });
      } catch (appsError) {
        try { console.warn('[apps] prompt block failed:', appsError.message); } catch (_) { /* noop */ }
      }
    }

    // ─── Agent harness (Phase 1) ──────────────────────────────────────────
    // Merge the harness-native tools (web_fetch / run_javascript /
    // create_artifact) plus the user's external MCP tools into the turn, and
    // wrap EVERY tool with the typed SSE event stream (tool_call_start /
    // tool_executing / tool_result, blockIndex+seq) and the interactive
    // permission gate ('confirm' tier pauses on permission_request until
    // POST /api/agent/permission answers). Fail-open: any harness error
    // leaves the original toolset untouched. Skipped for toolsOverride
    // callers (tests pin the legacy frame contract). Env: SIRAGPT_AGENT_HARNESS=0.
    let __harness = null;
    if (!toolsOverride) {
      try {
        const { attachHarness } = require('./agent-harness/run-agent-turn');
        __harness = await attachHarness({
          tools,
          write: (payload) => writeSse(res, redactGeneratedArtifactPayload(payload)),
          chatId: toolContext.chatId || null,
          userId: toolContext.userId || null,
          requestedOrganizationId: toolContext.requestedOrganizationId || null,
          activeOrganizationId: toolContext.activeOrganizationId || null,
          prisma: toolContext.prisma || null,
          signal,
          describeTool: stageLabelFor,
          provider,
          // Weak prompted models already struggle with the core toolset —
          // don't hand them third-party MCP tools on top.
          mcpEnabled: toolCallMode === 'native',
          // Attachment IDs (ownership-verified upstream) — gates document_edit.
          fileIds: Array.isArray(toolContext.fileIds) ? toolContext.fileIds.filter(Boolean) : [],
          workspaceId: toolContext.workspaceId || null,
          coworkRunId: toolContext.coworkRunId || null,
          // Protegido reviewer: the event stream pauses write-side tools on
          // permission_request when this is 'protected'.
          // RLCD × Jev tool guard reads the user's request to judge each call.
          userQuery: typeof userQuery === 'string' ? userQuery : null,
          composerPermission: toolContext.permission
            || toolContext.toolPermission
            || toolContext.composerPermission
            || 'default',
        });
        if (__harness) tools = applyCustomGptCapabilityGates(__harness.tools, customGptCapabilities);
      } catch (harnessErr) {
        if (__coworkRun) {
          await require('./cowork/control-plane').finishRun(toolContext.prisma, {
            runId: __coworkRun.id,
            userId: toolContext.userId,
            status: 'failed',
            lastEvent: `Cowork tool harness unavailable: ${harnessErr?.message || 'unknown error'}`,
          }).catch(() => {});
          throw harnessErr;
        }
        console.warn('[agent-harness] attach failed — continuing without harness:', harnessErr && harnessErr.message);
      }
    }

    // Prompted mode (model without native function calling): hand the model a
    // SMALL, ordered toolset — weak models depend on harness quality far more
    // than flagships, and a ~70-tool catalog rendered as prose overwhelms
    // them. Intent tools (media, file/RAG) are pinned so they survive the cap.
    const imageGuarded = withImageEditGuard(tools);
    tools = imageGuarded.tools;
    const imageGuard = imageGuarded.guard;
    if (toolCallMode === 'prompted' && !toolsOverride) {
      try {
        const { capToolsForPrompted } = require('./agents/prompted-tool-calling');
        const pinned = [
          ...mediaIntents.map((intent) => intent && intent.tool),
          ...(customGptAgentPolicy.requiresSkill ? ['run_skill', 'run_skill_pipeline'] : []),
          ...(artifactDeliveryContract.active && !softwareBuildTurn ? ['create_document', 'verify_artifact'] : []),
          ...(softwareBuildTurn && !githubPrTurn && !githubLocalPreviewTurn ? ['create_artifact', 'construir_scaffold', 'github_publish_project'] : []),
          ...(githubLocalPreviewTurn ? [
            'project_clone_repo',
            'project_preview_start',
            'project_preview_status',
          ] : []),
          ...(githubPrTurn ? [
            'github_open_repo',
            'github_repo_list',
            'github_repo_read',
            'github_repo_write',
            'github_repo_exec',
            'github_open_pull_request',
          ] : []),
          ...(Array.isArray(toolContext.fileIds) && toolContext.fileIds.length
            ? ['rag_retrieve', 'docintel_analyze', 'search_docs', 'document_edit']
            : []),
          ...(Array.isArray(toolContext.mentionedAppTools) ? toolContext.mentionedAppTools : []),
        ].filter(Boolean);
        tools = capToolsForPrompted(tools, { pinned });
      } catch (capErr) {
        console.warn('[agentic-chat] prompted tool cap failed (using full set):', capErr && capErr.message);
      }
    }
    if (codingWorkspace) tools = require('./codex/chat-coding-workspace').codingTools({
      researchTools: applyCustomGptCapabilityGates(baseWebTools(), customGptCapabilities),
    });
    const availableToolNames = new Set(tools.map((tool) => tool && tool.name).filter(Boolean));
    let initialToolChoice = mediaIntent?.tool && mediaIntent.confidence === 'high' && availableToolNames.has(mediaIntent.tool)
      ? mediaIntent.tool
      : null;
    // A read-only follow-up about generated files has no File attachments.
    // Force the existing byte-reading tool before any web/RAG skill can treat
    // an internal artifact path as a knowledge-source id.
    if (generatedArtifactRefs.length && availableToolNames.has('python_exec')) {
      initialToolChoice = 'python_exec';
    }
    // Jev said the turn REQUIRES current web sources: open with the search tool
    // it picked (web / academic / X / GitHub) unless a media intent already won.
    const jevWebTool = webSearchIntent && webSearchIntent.force && availableToolNames.has(webSearchIntent.tool) ? webSearchIntent.tool : null;
    if (!initialToolChoice && jevWebTool) initialToolChoice = jevWebTool;
    // The route already ran the opening web search and injected its results:
    // the model starts from them instead of searching the same thing again.
    const preGroundedSources = Math.max(0, Math.floor(Number(webGrounding && webGrounding.sources) || 0));
    if (preGroundedSources > 0 && initialToolChoice === 'web_search') initialToolChoice = null;
    const webLookupLimit = webSearchBudget({ preGroundedSources });
    const webReadLimit = webReadBudget({ preGroundedSources });
    // Jev's freshness window becomes the default when the model omits it.
    if (webSearchIntent && webSearchIntent.freshness) {
      for (const tool of tools) {
        if (!tool || tool.name !== 'web_search' || typeof tool.execute !== 'function' || tool.__jevFreshness) continue;
        const inner = tool.execute;
        tool.execute = (args, ctx) => inner({ ...(args || {}), freshness: (args && args.freshness) || webSearchIntent.freshness }, ctx);
        tool.__jevFreshness = webSearchIntent.freshness;
      }
    }
    tools = withWebReadBudget(withWebSearchBudget(tools, webLookupLimit), webReadLimit);
    // Document merge ("combina estos 2 words en 1"): force document_edit as
    // the FIRST tool call — its deterministic merge fast-path produces the
    // fused .docx without depending on the model choosing the right tool.
    // Single-file EDIT intents get the same treatment: without it, weak models
    // answer in prose or call create_document and the user never gets an
    // edited copy of THEIR attachment.
    let documentMergeIntent = false;
    let documentEditIntent = false;
    const attachedFileCount = Array.isArray(toolContext.fileIds) ? toolContext.fileIds.filter(Boolean).length : 0;
    if (!initialToolChoice && attachedFileCount >= 2 && availableToolNames.has('document_edit')) {
      try {
        const { isDocumentMergeRequest } = require('./agents/document-merge');
        if (isDocumentMergeRequest(userQuery, { fileCount: attachedFileCount })) {
          documentMergeIntent = true;
          initialToolChoice = 'document_edit';
        }
      } catch (_) { /* best-effort */ }
    }
    if (
      !initialToolChoice
      && !wantsNewDeckDeliverable
      && attachedFileCount >= 1
      && availableToolNames.has('document_edit')
    ) {
      try {
        if (isDocumentEditRequest(userQuery)) {
          documentEditIntent = true;
          initialToolChoice = 'document_edit';
        }
      } catch (_) { /* best-effort */ }
    }
    // When the user is editing an attached document, create_document would
    // regenerate a NEW file from scratch and docintel_* would only *read* the
    // attachment (live bug: DeepSeek called docintel_analyze instead of
    // returning an edited DOCX). Drop both so the model can only take
    // document_edit (or answer) for edit intents.
    // Exception: NEW presentation decks from PDF/images MUST use create_document
    // (pptx) — blocking it forced the "PDF + anexos" failure path.
    if (
      (documentEditIntent || documentMergeIntent || documentEditPreloopAttempted)
      && !wantsNewDeckDeliverable
      && Array.isArray(tools)
    ) {
      const blockedOnEdit = new Set([
        'create_document',
        'docintel_analyze',
        'docintel_retrieve',
        'docintel_extract_tables',
        'docintel_compare',
      ]);
      tools = tools.filter((t) => t && t.name && !blockedOnEdit.has(t.name));
    }
    // An edit of a Word / Excel / PowerPoint file is delivered as that same
    // file type. create_artifact (html / code) must never stand in for it —
    // the incident answer was an .html «preview» plus a python script.
    // Only a same-file edit: «haz un dashboard html con los datos del excel»,
    // «pasa el excel a markdown» or «resume el word» ASK for another format.
    if (
      (documentEditIntent || documentMergeIntent || documentEditPreloopAttempted || agentRunnerClaimedTurn || designUpgradeTurn)
      && !wantsNewDeckDeliverable
      && !softwareBuildTurn
      && !requestsNonOfficeDeliverable(userQuery)
    ) {
      officeEditFormats = officeFormatsNamedIn(userQuery);
      if (!officeEditFormats.length && prior) {
        const latestFamily = officeEditFamily(priorArtifactFormat);
        if (latestFamily) officeEditFormats = [latestFamily];
      }
      if (!officeEditFormats.length && attachedFileCount > 0 && Array.isArray(toolContext.fileMetadata)) {
        officeEditFormats = Array.from(new Set(toolContext.fileMetadata
          .map((file) => officeEditFamily(artifactFormatOf({ filename: file && file.name })))
          .filter(Boolean)));
      }
      if (officeEditFormats.length && Array.isArray(tools)) {
        tools = tools.filter((t) => !(t && t.name === 'create_artifact'));
      }
    }
    // F2: the AgentRunner claimed this turn and failed, and the surgical
    // editor did not rescue it either — the loop may still serve the EDIT
    // via document_edit, but create_document (a brand-new generic document)
    // is banned for the rest of the turn. Exception preserved: NEW decks
    // from PDF/images (wantsNewDeckDeliverable) still require create_document.
    if (agentRunnerFailure && !wantsNewDeckDeliverable && Array.isArray(tools)) {
      tools = tools.filter((t) => !(t && t.name === 'create_document'));
    }
    // Force create_document first for new multi-slide decks so weak models
    // cannot answer with a preserved PDF annex.
    if (wantsNewDeckDeliverable && availableToolNames.has('create_document') && !initialToolChoice) {
      initialToolChoice = 'create_document';
    }
    // Website/app/software asks must produce code, not Document Sandbox Word.
    if (softwareBuildTurn && Array.isArray(tools)) {
      tools = tools.filter((t) => !(t && t.name === 'create_document'));
      for (const name of availableToolNames) {
        if (name === 'create_document') availableToolNames.delete(name);
      }
    }
    if (githubLocalPreviewTurn && !initialToolChoice && availableToolNames.has('project_clone_repo')) {
      initialToolChoice = 'project_clone_repo';
    } else if (githubPrTurn && !initialToolChoice && availableToolNames.has('github_open_repo')) {
      initialToolChoice = 'github_open_repo';
    } else if (softwareBuildTurn && !githubPrTurn && !githubLocalPreviewTurn && !initialToolChoice && availableToolNames.has('construir_scaffold')) {
      initialToolChoice = 'construir_scaffold';
    } else if (softwareBuildTurn && !githubPrTurn && !githubLocalPreviewTurn && !initialToolChoice && availableToolNames.has('create_artifact')) {
      initialToolChoice = 'create_artifact';
    }
    // A strong specialized-skill intent gets one deterministic first call. The
    // model still selects the concrete id/args and can chain further skills
    // after observing the first result.
    if (!initialToolChoice && customGptAgentPolicy.requiresSkill && availableToolNames.has('run_skill')) {
      initialToolChoice = 'run_skill';
    }
    // Aggressive auto-search: when the question clearly needs fresh/live/factual
    // web data and no media tool was force-selected, force the FIRST step to be
    // a web_search so the model cannot answer "no tengo información" from stale
    // memory. The model still controls every step after the first.
    if (!initialToolChoice && preGroundedSources === 0 && availableToolNames.has('web_search')) {
      try {
        const { detectWebSearchIntent } = require('./web-search-intent');
        const wsi = detectWebSearchIntent(userQuery);
        if (wsi.needsWebSearch && wsi.confidence >= 0.5) {
          initialToolChoice = 'web_search';
        }
      } catch (_) { /* best-effort; fall back to model-driven tool choice */ }
    }
    if (codingWorkspace) initialToolChoice = 'project_list';
    const executionProfile = buildChatFinalizeProfile({
      userQuery: codingWorkspace ? '' : userQuery,
      fileIds: Array.isArray(toolContext.fileIds) ? toolContext.fileIds : [],
      fileMetadata: Array.isArray(toolContext.fileMetadata) ? toolContext.fileMetadata : [],
      hasImageAttachment: toolContext.hasImageAttachment === true || imageAttached,
      hasRecentImage: recentImage,
      availableToolNames,
      artifactDeliveryContract,
    });
    if (generatedArtifactRefs.length) {
      const { requireGeneratedArtifactRead } = require('./agents/generated-artifact-followup');
      const readProfile = requireGeneratedArtifactRead({ requiredTools: [], minimumToolCalls: {} }, generatedArtifactRefs);
      executionProfile.requiredTools = readProfile.requiredTools;
      executionProfile.minimumToolCalls = readProfile.minimumToolCalls;
    }
    if (customGptAgentPolicy.requiresSkill && availableToolNames.has('run_skill')) {
      executionProfile.requiredTools = Array.from(new Set([...(executionProfile.requiredTools || []), 'run_skill']));
      executionProfile.minimumToolCalls = { ...(executionProfile.minimumToolCalls || {}), run_skill: 1 };
    }
    const openclawProfile = openclawCapabilityKernel.buildCapabilityProfile({
      prompt: userQuery,
      userId: toolContext.userId || null,
      chatId: toolContext.chatId || null,
      attachmentCount: Array.isArray(toolContext.fileIds) ? toolContext.fileIds.length : 0,
      toolNames: tools.map((tool) => tool.name),
      recentTurnCount: Array.isArray(safeHistory) ? safeHistory.length : 0,
      model,
      context: {
        history: safeHistory,
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
      toolCallMode,
    };
    state.meta.executionProfile = {
      version: executionProfile.version,
      requiredTools: executionProfile.requiredTools,
      minimumToolCalls: executionProfile.minimumToolCalls,
    };
    state.meta.skillPolicy = {
      enabled: customGptAgentPolicy.skillsEnabled,
      recommendedSkillIds: runtimeSkillPolicy.recommendedSkillIds,
      requiresSkill: customGptAgentPolicy.requiresSkill,
    };
    if (artifactDeliveryContract.active) state.meta.artifactDelivery = artifactDeliveryContract;

    const isGoalCommand = /^\s*(\/goal|\/plan)\b/i.test(userQuery);
    const isRepoTask = /\b(clon|repo|github|git|commit|push|pr|pull ?request|deploy|despleg|codex|cursor|claude.?code|program|c[oó]digo|refactor|mejora|arregla|corrige)\b/i.test(userQuery);
    const isAutonomous = isGoalCommand || isRepoTask || /\b(meses?|semanas?|sin.?detene|no.?pare?s|background|segundo.?plano|auto.?ejecut|contin[uú]a.?trabajando|trabaja.?por.?meses|no.?funciona.?a[uú]n|todav[ií]a.?no.?funciona)\b/i.test(userQuery);

    let maxStepsOverride = isAutonomous ? Math.max(maxSteps, isGoalCommand ? 60 : 30) : maxSteps;
    // A pasted link + «transcribe…»: transcribe_url downloads (or plays and
    // records) the recording and transcribes it, which can take as long as the
    // class itself — give the turn the tool's own budget plus room to answer.
    const isLinkTranscription = /https?:\/\/\S+/i.test(userQuery) && /\b(?:transcri|trascri|transcir|subt[ií]tul|qu[eé] dice|qu[eé] dicen)/i.test(userQuery);
    let maxRuntimeOverride = isAutonomous ? Math.max(maxRuntimeMs, 15 * 60 * 1000) : maxRuntimeMs;
    if (isLinkTranscription) {
      const transcribeBudget = require('./agent-harness/tools/transcribe-url-tool').toolTimeoutMs(process.env);
      maxRuntimeOverride = Math.max(maxRuntimeOverride, transcribeBudget + 5 * 60 * 1000);
    }
    // Prompted mode: budgets enforced in code, not prompts. Weak models drift
    // on long horizons; a tighter step budget converges to finalize sooner
    // (the loop already force-narrows to finalize on the last step).
    if (toolCallMode === 'prompted') {
      const promptedCap = Number(process.env.SIRAGPT_PROMPTED_MAX_STEPS) || 10;
      maxStepsOverride = Math.min(maxStepsOverride, Math.max(3, promptedCap));
    }
    if (__coworkRun?.maxSteps) {
      maxStepsOverride = Math.min(maxStepsOverride, __coworkRun.maxSteps);
    }

    // U3 observe/enforce: attach policy summary + non-fatal shadow diffs before
    // the first sentinel so telemetry is visible from the first UI frame.
    if (turnPolicy && typeof turnPolicy === 'object') {
      try {
        const turnPolicyService = require('./turn-policy');
        const diffs = turnPolicyService.diffTurnPolicyAgainstRuntime(turnPolicy, {
          toolCallMode,
          model,
          provider,
          maxSteps: maxStepsOverride,
        });
        state.meta.runtime.turnPolicy = turnPolicyService.summarizeTurnPolicy(turnPolicy);
        if (diffs.length > 0) {
          state.meta.runtime.turnPolicyShadowDiffs = diffs.slice(0, 8);
        }
        try {
          require('./cognitive-metrics').recordTurnPolicy(turnPolicy);
        } catch (_) { /* metrics never block */ }
      } catch (_) { /* turn-policy is best-effort */ }
    }

    // Live progress of the loop (decide steps, tickers, agent_model rows,
    // the guard step, agent_step frames) only for a client that speaks the
    // stage-v3 protocol: a stale tab (protocol 1) and the kill switch
    // (SIRAGPT_TURN_PROGRESS=0) keep the previous timeline unchanged.
    const __liveProgressOn = Boolean(progress && progress.enabled !== false && progress.protocol === 2);
    // Initial sentinel — gives the UI an immediate step indicator even
    // before the first model call returns. What it says is real: the model
    // that plans (display name only) and, once known, its tools.
    // Display name only ('' when none is known: never a raw id).
    const __liveModelName = turnProgressLib.displayNameFor(model, provider);
    const __liveModelLabel = __liveModelName || capitalizeFirst(turnProgressLib.modelLabel(model, provider));
    state.steps.push({
      id: 'agentic-start',
      label: __liveProgressOn ? 'Planificando cómo responder' : 'Analizando la pregunta',
      icon: 'thought',
      status: 'running',
      startedAt: Date.now(),
      ...(__liveProgressOn && __liveModelName ? { detail: __liveModelName } : {}),
      toolCalls: [],
    });
    await writeSse(res, { replace: true, content: serializeSentinel(state) });

    // One bounded transcript: do not duplicate/re-truncate the already-fitted
    // history in the inferred-goals block. The current query stays separate.
    const historyForPrompt = buildAgentHistoryBlock(safeHistory);

    let pluginPromptBlock = '';
    if (pluginLifecycle) {
      try {
        const pluginBeforeRun = await pluginLifecycle.beforeRun({
          query: userQuery,
          model,
          toolNames: tools.map((tool) => tool?.name).filter(Boolean),
        });
        pluginPromptBlock = pluginBeforeRun.promptBlock;
        state.meta.plugins = pluginLifecycle.summary();
      } catch (pluginBeforeError) {
        if (pluginBeforeError?.code === 'ABORT_ERR' || pluginBeforeError?.code === 'PLUGIN_RUN_BLOCKED') {
          throw pluginBeforeError;
        }
        console.warn('[agentic-chat] plugin beforeRun failed (continuing):', pluginBeforeError?.message || pluginBeforeError);
      }
    }

    // Agent Skills: explicit ones ride the prompt; the rest load on demand
    // through `use_skill` (harness tool) — progressive disclosure, like Claude.
    let skillsPolicyLine = '';
    try {
      if (require('./agent-harness/run-agent-turn').harnessEnabled()) {
        skillsPolicyLine = 'Skills: antes de crear o editar un Word, PowerPoint, Excel, PDF o CSV, o si la tarea encaja con una skill del usuario (las suyas o las que instaló en Ajustes → Skills), carga su playbook con `use_skill` (sin nombre lista las disponibles) y sigue sus instrucciones. No la cargues si ya está activa en este turno. Si el usuario quiere convertir un procedimiento repetible en una skill, redáctala con él y, cuando la apruebe, guárdala con `save_skill`. Marketplace: si pregunta si existe una skill para algo, quiere explorar o añadir skills de la comunidad (ClawHub), o pega un enlace de ClawHub/GitHub/SKILL.md para instalarla, busca con `search_skills_marketplace` y, solo cuando lo pida, instala con `install_skill` (pide confirmación; las skills bloqueadas por el marketplace se rechazan). Nunca afirmes que una skill quedó instalada sin haber llamado a la herramienta.';
      }
    } catch (_) { skillsPolicyLine = ''; }
    const extraSystem = codingWorkspace
      ? [require('./codex/chat-coding-workspace').WORKSPACE_POLICY, selectedSkillsBlock || '', preferenceBlock || '', historyForPrompt].join('\n')
      : [
      // Custom-GPT persona FIRST (primacy) so a selected GPT actually follows
      // its configured instructions/format/tone, then the generic agent rules.
      customGptPersona || '',
      requestBriefBlock || '',
      pluginPromptBlock,
      buildSkillExecutionPrompt(customGptAgentPolicy),
      buildArtifactDeliveryPrompt(artifactDeliveryContract),
      'Responde SIEMPRE en español, con tono profesional y cercano. No uses emojis.',
      'En tareas con 2 o más pasos llama `update_plan` PRIMERO con el plan completo (3-7 pasos cortos) y vuelve a llamarlo al completar cada paso o si el plan cambia — el usuario lo ve actualizarse en vivo. Para tareas de una sola acción no hace falta plan.',
      initialToolChoice ? buildMediaIntentsHint(mediaIntents) : '',
      documentMergeIntent
        ? 'El usuario quiere FUSIONAR sus documentos adjuntos en UN solo archivo. Llama `document_edit` UNA vez con una instrucción completa tipo "fusiona todos los documentos adjuntos en un solo .docx, en el orden adjuntado, conservando el contenido y formato de cada uno" (más cualquier ajuste que pidió el usuario). La herramienta devuelve el archivo fusionado como tarjeta de descarga: menciónalo brevemente y finaliza. NO pegues el contenido de los documentos en tu respuesta.'
        : '',
      documentEditIntent
        ? 'El usuario quiere EDITAR el documento que ADJUNTO (no crear uno nuevo). Llama `document_edit` UNA vez con una instrucción completa que liste TODOS los cambios pedidos. La herramienta edita el archivo original preservando formato/estructura y devuelve una copia editada como tarjeta de descarga. Menciónala brevemente y finaliza. PROHIBIDO inventar un documento nuevo, responder solo con sugerencias, o decir que no puedes editar el archivo adjunto.'
        : '',
      openclawRuntimeBlock,
      buildExecutionProfilePrompt(executionProfile),
      generatedArtifactRefs.length
        ? require('./agents/generated-artifact-followup').buildGeneratedArtifactReadContext(generatedArtifactRefs, userQuery)
        : '',
      __coworkRun
        ? [
          'Este chat tiene un workspace Cowork versionado. El trabajo debe ocurrir en archivos, no quedarse solo en una burbuja de chat.',
          'Usa ws_glob/ws_grep/ws_read para inspeccionar y ws_write/ws_edit para entregar o modificar archivos. Lee antes de editar; nunca ignores un conflicto de version.',
          'Usa workspace_memory para recordar o consultar decisiones estables de este proyecto; no mezcles esa memoria con otros workspaces ni guardes secretos.',
          'Usa update_checklist para tareas de dos o mas pasos. Puedes usar spawn_task para trabajo independiente y schedule_task solo cuando el usuario pida recurrencia.',
          `Workspace id: ${__coworkRun.workspaceId}. Run id: ${__coworkRun.id}.`,
        ].join('\n')
        : '',
      __coworkMemoryBlock,
      __appsBlock,
      buildThreadWorkContext(safeHistory, userQuery, { includeTranscript: false }),
      'Este hilo es una sesion agentica autónoma: decide, usa herramientas, observa resultados, corrige y finaliza solo cuando tengas una respuesta verificable o la tarea esté completa.',
      'Estándar de calidad (nivel experto): en tareas difíciles piensa antes de actuar (descompón el problema, explicita supuestos y casos límite, verifica cada paso); responde con la conclusión primero; distingue lo que SABES de lo que INFIERES de lo que NO SABES y NUNCA inventes datos, cifras, citas, fuentes ni APIs; cuando dudes, verifica con una herramienta en vez de adivinar; admite y corrige tus errores directamente, sin adular.',
      'Si el usuario dice "todavía no funciona", "sigue", "arregla", "no sirve", o similar, revisa TODO el historial del hilo para entender qué se pidió antes, qué se hizo, qué falló, y continúa desde donde se quedó. No empieces de cero.',
      'Cuando el usuario pide abrir un repo suyo y hacer un PR («abre un PR en owner/repo que…»): usa `github_open_repo` (OAuth del usuario; si falta conexión, el chat abrirá la autorización de GitHub y esperará; nunca inventes enlaces OAuth ni tokens), luego `github_repo_list` / `github_repo_read` / `github_repo_write` / `github_repo_exec` en el workspace aislado, y `github_open_pull_request` con approved=true. Devuelve la URL del PR. No uses clone_project ni host_bash para este flujo (evita el .env del host). No empujes a main. No muestres model_id ni nombres de vendor.',
      'Cuando el usuario pide «dame la web en local» o clonar un github.com para verlo: usa `project_clone_repo` + `project_preview_start` (servidor). Nunca le pidas clonar en su teléfono ni digas que no puedes abrir un puerto.',
      'Cuando detectes otras operaciones de repositorio público (clonar, editar, commit, push, deploy, CI) y NO sea el flujo OAuth de arriba ni el preview local, actúa como un coding agent completo:',
      '  1. Clona o localiza el repositorio usando `project_clone_repo` (preview) o `clone_project` / `host_bash` con git.',
      '  2. Comprende la estructura del proyecto: usa `list_dir` para explorar el árbol, `glob_files` para localizar archivos por patrón (ej. "**/*.ts") y `code_grep` para buscar dónde se define o se usa un símbolo/cadena antes de editar.',
      '  3. Realiza los cambios necesarios editando archivos con `host_file` para cambios de texto y `host_bash` solo para comandos.',
      '  4. Ejecuta `npm test` o la suite de pruebas respectiva para verificar.',
      '  5. Si las pruebas pasan, haz `git add`, `git commit`, `git push` al repositorio.',
      '  6. Usa `check_ci_status` o `monitor_ci` para verificar GitHub Actions hasta verde; si CI falla, informa el fallo exacto y no afirmes que quedó en verde.',
      'Cuando el usuario pega el enlace de un video, audio, clase o grabación y pide transcribirlo, subtitularlo, resumir lo que se dice o saber qué dicen en cierto minuto: usa `transcribe_url` con `start`/`end` exactamente como lo pidió («del minuto 1.5 al 10» → start "1:30", end "10:00"; sin rango = todo). La herramienta entra sola a páginas de reproductor (navegador headless) y usa las cookies guardadas del usuario. Si devuelve `media_login_required`, transmite su `userMessage` tal cual (dos caminos: adjuntar el video/audio, o adjuntar UNA vez el archivo cookies.txt de ese sitio, que queda guardado para los próximos enlaces); si devuelve `cookies.saved: true`, dile que su sesión quedó guardada. Nunca digas que no puedes transcribir enlaces sin haber llamado a la herramienta.',
      'Recordatorios y automatizaciones: cuando el usuario pida que le recuerdes algo, que le avises o envíes algo a una hora o con una frecuencia («recuérdame en 20 minutos…», «mañana a las 9 avísame…», «cada lunes a las 9 mándame el resumen…», «cada 10 minutos revisa si…», «todos los días a las 8…»), o quiera ver, pausar o borrar sus programaciones: usa `automations` (action create/list/pause/resume/remove, `schedule` con sus palabras exactas, `prompt` como instrucción completa para la ejecución futura). La herramienta interpreta la hora en la zona horaria del usuario y la ejecución responderá en ESTE chat; repite al usuario la hora/frecuencia exacta del `summary` para que pueda corregirla. Si no dijo cuándo, pregúntale antes de crear nada. Nunca afirmes que algo quedó programado sin haber llamado a la herramienta.',
      'Usa `memory_recall` cuando el pedido dependa de preferencias o contexto persistente del usuario.',
      'Memoria persistente: el índice del usuario ya está en el system prompt. Abre un tema con `memory_read_topic`, busca con `memory_search` (grep primero), recupera lo hablado en otros chats con `chat_history_search`, busca en Drive/Gmail del usuario con `connector_search`, y guarda hechos nuevos y duraderos con `memory_write` en esta misma conversación (nunca secretos ni detalles efímeros). Si el usuario pide olvidar algo, usa `memory_forget`.',
      preGroundedSources > 0
        ? `Ya tienes ${preGroundedSources} resultados web recientes para esta pregunta en «Fresh Web Context»: responde con ellos y cita sus enlaces. Usa \`web_search\` solo si falta un dato concreto (hasta ${webLookupLimit} búsquedas y ${webReadLimit} lecturas de página en este turno).`
        : '',
      webSearchIntent && webSearchIntent.suggest
        ? `Jev (juez de turno) estima que esta petición necesita fuentes actuales (${webSearchIntent.need === 'web_required' ? 'imprescindible' : 'recomendable'}): busca con \`${webSearchIntent.tool}\`${webSearchIntent.freshness ? ` usando freshness=${webSearchIntent.freshness}` : ''} antes de afirmar datos que cambian con el tiempo, y cita las URLs.`
        : '',
      'Para continuidad entre conversaciones (el usuario dice "lo que hablamos antes", "retoma", "¿en qué quedamos?", "mis chats", "la sesión de ayer"): usa `session_list` para ver sus sesiones recientes, `session_search` para encontrar un tema concreto, y `session_history` para abrir una sesión por su id y leer el hilo completo antes de continuar. Solo accedes a sesiones del propio usuario.',
      'Usa `rag_retrieve`, `self_rag_answer` o `docintel_*` cuando el usuario mencione archivos, documentos, PDFs, tablas o conocimiento privado.',
      'Si la respuesta depende de hechos que pueden haber cambiado, datos en tiempo real, cifras, fechas, precios, noticias, o de cualquier cosa que no sepas con certeza absoluta, DEBES usar la computadora en vivo (`computer_navigate` / `computer_screenshot`) o `web_search` (y luego `web_extract` o `read_url`) ANTES de responder. Nunca respondas "no tengo información", "no tengo acceso a internet" o "mis datos llegan hasta cierta fecha" sin haber ejecutado primero una herramienta. Cada chat TIENE una computadora en vivo. Cita las fuentes con enlaces markdown.',
      'Para calculos, transformaciones de datos o verificacion deterministica, usa `python_exec`. Cuando generes codigo no trivial, usa `run_tests` antes de finalizar.',
      'Cuando el usuario pida audio, voz, narración, locución, mp3 o wav, DEBES llamar `generate_speech` con el texto exacto y adjuntar el archivo MP3 descargable. PROHIBIDO inventar una página HTML con speechSynthesis / Web Speech API, un reproductor en el navegador, o decirle al usuario que pulse reproducir. El entregable es un archivo de audio real.',
      githubLocalPreviewTurn
        ? 'El usuario pidio clonar un repo GitHub y verlo en local ("dame la web en local", "en local 5000"). DEBES usar `project_clone_repo` con la URL https://github.com/owner/repo y luego `project_preview_start`. Comparte previewUrl como su web en local. El puerto lo asigna el runner; si pidio 5000 y el sandbox usa otro, explica el enlace — NUNCA digas que no puedes abrir el puerto ni le pidas clonar en su telefono/laptop. PROHIBIDO "Nivel de confianza". PROHIBIDO inventar tokens o model_id. No uses create_document.'
        : githubPrTurn
        ? 'El usuario pidio abrir un repositorio GitHub y/o crear un Pull Request. Usa `github_open_repo` con owner/repo (OAuth del usuario; si falta conexión, el chat abrirá la autorización de GitHub y esperará; nunca inventes enlaces OAuth ni tokens). Edita en el workspace aislado con `github_repo_write`. Abre el PR con `github_open_pull_request` (approved=true) y devuelve prUrl. PROHIBIDO inventar tokens o model_id. No uses create_document.'
        : softwareBuildTurn
        ? 'El usuario pidio SOFTWARE con codigo real (HTML/CSS/JS o una app web), no un documento Word/PDF. Usa `construir_scaffold` para entregar un proyecto funcional (HTML previsualizable + zip + base de datos en archivo). Tambien puedes usar `create_artifact` tipo html. Si pide GitHub, usa `github_publish_project` (OAuth del usuario; si falta conexión, el chat abrirá la autorización de GitHub y esperará; nunca inventes enlaces OAuth ni tokens). PROHIBIDO create_document con .docx/.xlsx/.pptx/.pdf (E_SOFTWARE_CODE). No menciones verificaciones tecnicas de Word. No muestres model_id ni nombres de vendor.'
        : 'Cuando el usuario pida uno o varios archivos descargables, usa `create_document` para cada entregable y despues `verify_artifact` para cada id devuelto; no finalices si alguna verificacion muestra un archivo vacio o incorrecto. No finalices con solo texto si pidio crear, descargar, exportar o convertir un Word/Excel/PPT/PDF/SVG/CSV/Markdown.',
      'Cuando el usuario pida editar su Word/Excel/PPT/PDF subido, usa `document_edit` cuando este disponible. Pasa una sola instruccion completa con TODOS los cambios pedidos (corregir, mejorar, agregar, borrar, reemplazar, completar, formatear o convertir), trata el archivo original como solo lectura, crea una nueva copia en el mismo formato salvo que pida otro, conserva estructura/logos/tablas/formulas/hojas/encabezados/diseno tanto como sea posible, y modifica solo lo solicitado. No finalices con recomendaciones o una lista de cambios sin entregar archivo.',
      'No afirmes que modificaste repositorios, GitHub o el filesystem local si ninguna herramienta disponible lo hizo realmente.',
      require('./computer/login-handoff').POLICY_ES,
      attachedDocuments
        ? `\n=== DOCUMENTOS ADJUNTOS POR EL USUARIO (texto ya extraído) ===\nAnaliza este contenido DIRECTAMENTE para responder. NUNCA digas que no tienes acceso al documento ni que el usuario debe reenviarlo: el texto está aquí. Si necesitas más detalle del que aparece (el contenido puede venir recortado), usa \`rag_retrieve\` o \`docintel_*\` sobre estos mismos archivos.\n${attachedDocuments}\n=== FIN DOCUMENTOS ADJUNTOS ===`
        : '',
      skillsPolicyLine,
      selectedSkillsBlock || '',
      preferenceBlock || '',
      historyForPrompt,
    ].filter(Boolean).join('\n');

    // Surface artifacts produced by media/visual/document tools into the
    // agent-task-state sentinel so generated images, videos, audio and music
    // render as downloadable, playable assets inside the chat bubble — without
    // any frontend change (the existing AgenticStepsRenderer already reads
    // state.artifacts). Tools emit `file_artifact` via ctx.onEvent.
    const seenArtifactIds = new Set();
    // A multi-file request is one delivery. Keep candidate files out of the
    // live sentinel (and workspace) until the finalize guard accepts the set.
    // Otherwise Stop or a failed repair leaves a lone download card behind.
    const pendingDeliveryArtifacts = [];
    const upstreamOnEvent = typeof toolContext.onEvent === 'function' ? toolContext.onEvent : null;
    const loginHandoffMod = require('./computer/login-handoff');
    const unsubLoginHandoff = loginHandoffMod.subscribeTakeover((evt) => {
      try {
        const chatId = String((toolContext && toolContext.chatId) || '');
        const evtId = String((evt && evt.conversationId) || '');
        if (evtId && chatId && evtId !== chatId) return;
        const payload = loginHandoffMod.ssePayloadFromTakeover(evt);
        writeSse(res, payload);
        if (evt && evt.active && payload.chatMessage && evt.isNew) {
          writeSse(res, { content: `\n\n${payload.chatMessage}` });
        }
      } catch (_) { /* overlay event is best-effort */ }
    });
    const stopLoginHandoff = () => {
      try { unsubLoginHandoff(); } catch (_) { /* noop */ }
    };
    try {
      res.once('close', stopLoginHandoff);
      res.once('finish', stopLoginHandoff);
    } catch (_) { /* res may be a stub in tests */ }
    function importArtifactToWorkspace(a) {
      if (toolContext.workspaceId && toolContext.prisma && toolContext.userId && a.id) {
        try {
          const workspaceStore = require('./cowork/workspace-store');
          Promise.resolve(workspaceStore.importAgentArtifact(toolContext.prisma, {
            workspaceId: toolContext.workspaceId,
            userId: toolContext.userId,
            artifactId: a.id,
            targetPath: `deliverables/${a.filename || 'artifact.bin'}`,
            authorRunId: toolContext.coworkRunId || null,
          })).then((file) => {
            writeSse(res, {
              type: 'cowork_file_changed',
              workspaceId: toolContext.workspaceId,
              file: {
                id: file.id,
                path: file.path,
                version: file.currentVersion,
                mime: file.mime,
                size: file.size,
                artifactId: a.id,
              },
            });
          }).catch((error) => {
            try { console.warn('[cowork] artifact import failed:', error.message); } catch (_) { /* noop */ }
          });
        } catch (error) {
          try { console.warn('[cowork] artifact import failed:', error.message); } catch (_) { /* noop */ }
        }
      }
    }
    function onEvent(evt) {
      // transcribe_url opened a login-walled recording in the chat computer:
      // open that panel on the client so the user can sign in there.
      if (evt?.type === 'computer_navigate') {
        if (!signal?.aborted && typeof evt.url === 'string' && /^https?:\/\//i.test(evt.url)) {
          writeSse(res, { type: 'computer_navigate', url: evt.url.slice(0, 4000), chatId: String(toolContext.chatId || ''), tool: String(evt.tool || '') });
        }
        return;
      }
      if (evt?.type === 'coding_preview_ready') {
        if (codingWorkspace && !signal?.aborted
          && evt.chatId === String(toolContext.chatId)
          && evt.projectId === String(toolContext.codingWorkspace.projectId)) {
          writeSse(res, { type: 'coding_preview_ready', chatId: evt.chatId, projectId: evt.projectId });
        }
        return;
      }
      if (upstreamOnEvent) { try { upstreamOnEvent(evt); } catch (_) { /* best-effort */ } }
      // Image / video / music / voice tools that fail (or deliver a 0-byte
      // file) inside this turn → «Fallos de respuesta» (advisory, never throws).
      require('./observability/turn-failures').observeGenerationToolEvent(evt, toolContext);
      try {
        if (!evt || evt.type !== 'file_artifact' || !evt.artifact || !evt.artifact.downloadUrl) return;
        const a = evt.artifact;
        const key = String(a.id || a.downloadUrl);
        if (seenArtifactIds.has(key)) return;
        seenArtifactIds.add(key);
        const artifact = {
          id: String(a.id || key),
          filename: a.filename || 'archivo',
          mime: a.mime || 'application/octet-stream',
          format: a.format || null,
          sizeBytes: Number(a.sizeBytes) || 0,
          downloadUrl: a.downloadUrl,
          previewHtml: a.previewHtml || null,
          validation: a.validation || null,
          category: a.category || null,
          kind: a.kind || a.category || null,
          durationSeconds: Number(a.durationSeconds) || null,
          prompt: a.prompt || null,
        };
        if (artifactDeliveryContract.active) {
          pendingDeliveryArtifacts.push(artifact);
        } else {
          state.artifacts.push(artifact);
          writeSse(res, { replace: true, content: serializeSentinel(state) });
          importArtifactToWorkspace(artifact);
        }
      } catch (_) { /* never let UI plumbing crash a tool */ }
    }

    // Authorization chokepoint for the interactive chat. Without this the
    // high-risk host tools (host_bash/host_file/clone_project) ran fail-open
    // for any ai:generate user. Low-risk tools are allow-by-default so the
    // ~80 web/RAG/visual tools keep working untouched.
    const { createChatToolGate } = require('./agents/chat-tool-policy');
    const composerPermission = toolContext.permission
      || toolContext.toolPermission
      || toolContext.composerPermission
      || 'default';
    const toolGate = createChatToolGate({
      permission: composerPermission,
      // Protegido writes are allowed through ONLY when the harness reviewer
      // above is live; it pauses them on permission_request. Without a
      // harness the gate keeps denying them (fail-closed).
      deferProtectedAsk: Boolean(__harness),
      onAudit: (info) => { try { onEvent({ type: 'tool_authorized', tool: info.tool }); } catch (_) { /* noop */ } },
    });

    // ── Claude-Code harness: plan + verify + deferred tools ────────────────
    // 1. `update_plan`: visible, updatable todo list pinned in the timeline
    //    (plan-then-execute; zero frontend changes — it rides the sentinel).
    // 2. Evaluator-optimizer finalize guard: one cheap judge pass per run
    //    rejects a draft that doesn't answer / fabricates / under-delivers,
    //    with concrete repair instructions (gather → act → VERIFY).
    // 3. Deferred tool loading (SIRAGPT_TOOL_DEFER=1): lean core schema,
    //    everything else activates on demand via `search_tools`.
    const planVerify = require('./agents/agent-plan-verify');
    tools = tools.concat([planVerify.createPlanTool({
      getState: () => state,
      emit: async () => { await writeSse(res, { replace: true, content: serializeSentinel(state) }); },
    })]);
    if (pluginLifecycle) tools = pluginLifecycle.wrapTools(tools);

    let coreTools = tools;
    let deferredAgentTools = [];
    if (String(process.env.SIRAGPT_TOOL_DEFER || '') === '1') {
      const mustKeep = new Set([
        ...CORE_AGENT_TOOL_NAMES,
        ...(codingWorkspace ? tools.map((t) => t.name) : []),
        ...(executionProfile.requiredTools || []),
        ...(initialToolChoice ? [initialToolChoice] : []),
      ]);
      coreTools = tools.filter((t) => t && mustKeep.has(t.name));
      deferredAgentTools = tools.filter((t) => t && !mustKeep.has(t.name));
      try { console.log(`[agentic-chat] tool-defer ON: ${coreTools.length} core, ${deferredAgentTools.length} deferred`); } catch (_) { /* noop */ }
    }

    const composedFinalizeGuard = planVerify.composeFinalizeGuards([
      executionProfile.requiredTools.length
        ? ({ steps, unavailableTools }) => validateFinalize(executionProfile, steps, {
          unavailableTools: [...(Array.isArray(unavailableTools) ? unavailableTools : []), ...imageGuard.refusedTools()],
        })
        : null,
      artifactDeliveryContract.active
        ? async ({ steps, unavailableTools }) => {
          const delivery = validateArtifactDelivery(artifactDeliveryContract, {
            artifacts: pendingDeliveryArtifacts,
            steps,
            unavailableTools,
          });
          if (!delivery.ok || !artifactDeliveryContract.savXlsxMatrix) return delivery;
          return validateSavXlsxDelivery(artifactDeliveryContract, {
            artifacts: pendingDeliveryArtifacts,
            inspectPair: (refs) => require('./agents/generated-artifact-followup').compareGeneratedSavXlsx({
              refs,
              userId: toolContext.userId,
              chatId: toolContext.chatId,
              forDeliveryValidation: true,
            }),
          });
        }
        : null,
      codingWorkspace
        ? require('./codex/coding-finalize-guard').createCodingFinalizeGuard({
          userQuery, projectId: toolContext.codingWorkspace.projectId,
          userId: toolContext.userId, chatId: toolContext.chatId,
        })
        : planVerify.createAnswerVerifier({ openai, model, userQuery }),
    ]);

    // parallel_tool_calls per the capability registry: sent ONLY when the
    // model family is known to honor it (o-series and several OSS hosts
    // reject the parameter outright, so absence — not `false` — is the safe
    // negative).
    let __parallelToolCalls = false;
    try {
      const { resolveModelCapabilities } = require('./agent-harness/model-capabilities');
      __parallelToolCalls = resolveModelCapabilities(model, { provider }).supportsParallelToolCalls === true;
    } catch (_) { /* capability registry unavailable → omit the param */ }

    let stepCounter = 0;
    let __coworkFallbackApplied = false;
    let __coworkFallbackClient = null;

    async function beforeCoworkStep({ step }) {
      const coworkControl = require('./cowork/control-plane');
      const control = await coworkControl.beforeStep(toolContext.prisma, {
        runId: __coworkRun.id,
        userId: toolContext.userId,
        step,
        signal,
        onEvent,
      });
      if (control?.stop || __coworkFallbackApplied) return control;

      const run = control?.run;
      const maxCost = Number(run?.maxCostUsd);
      const spent = Number(run?.costUsd) || 0;
      const completedSteps = Math.max(0, Number(run?.currentStep) || 0);
      const averageStepCost = completedSteps > 0 ? spent / completedSteps : 0;
      const nearBudget = Number.isFinite(maxCost) && maxCost > 0 && spent > 0 && (
        spent >= maxCost * 0.75
        || spent + averageStepCost * 1.25 >= maxCost
      );
      if (!nearBudget) return control;

      const {
        createInstrumentedCerebrasClient,
        getCerebrasConfig,
      } = require('./ai/cerebras-client');
      const fallback = getCerebrasConfig();
      const alreadyFree = String(provider || '').toLowerCase() === 'cerebras'
        || String(model || '').toLowerCase() === String(fallback.model || '').toLowerCase();
      if (alreadyFree || !fallback.enabled) return control;

      __coworkFallbackClient = __coworkFallbackClient || createInstrumentedCerebrasClient();
      if (!__coworkFallbackClient) return control;
      __coworkFallbackApplied = true;

      const event = `Budget guard switched the remaining work to FlashGPT (${fallback.model})`;
      await toolContext.prisma.coworkRun.update({
        where: { id: __coworkRun.id },
        data: { lastEvent: event, controlVersion: { increment: 1 } },
      });
      await coworkControl.appendAudit(toolContext.prisma, {
        userId: toolContext.userId,
        workspaceId: __coworkRun.workspaceId,
        runId: __coworkRun.id,
        action: 'cowork.run.model_fallback',
        targetType: 'model',
        targetId: fallback.model,
        inputSummary: String(model),
        resultSummary: event,
        metadata: { spent, maxCost, provider: fallback.provider },
      });
      await writeSse(res, {
        type: 'cowork_model_fallback',
        runId: __coworkRun.id,
        model: fallback.model,
        provider: fallback.provider,
        reason: 'cost_budget_guard',
      });
      return {
        ...control,
        clientOverride: __coworkFallbackClient,
        modelOverride: fallback.model,
        providerOverride: fallback.provider,
      };
    }

    // ── Live progress of the loop ──────────────────────────────────────
    // Every model call is a visible step («Decidiendo el siguiente paso» ·
    // «paso 2 de 10 · DeepSeek V4 Pro»), with two honest tickers while the
    // model is silent (12 s: still reasoning; 30 s: slower than usual + the
    // step's time limit). Timers are unref'd and cleared on the response,
    // on abort and when the run ends, whatever happens.
    const __liveTickers = new Set();
    let __liveModelHandle = null;
    let __liveGuardHandle = null;
    const clearLiveTickers = () => {
      for (const timer of __liveTickers) { try { clearTimeout(timer); } catch (_) { /* noop */ } }
      __liveTickers.clear();
    };
    const writeLiveSentinel = () => { writeSse(res, { replace: true, content: serializeSentinel(state) }); };
    const liveStepSynthetic = (step) => Boolean(step && step.status === 'running'
      && (step.id === 'agentic-start' || /-decide$/.test(String(step.id || ''))));
    const onLiveAbort = () => {
      clearLiveTickers();
      try { if (__liveModelHandle) __liveModelHandle.done(); } catch (_) { /* noop */ }
    };
    if (__liveProgressOn && signal && typeof signal.addEventListener === 'function') {
      try { signal.addEventListener('abort', onLiveAbort, { once: true }); } catch (_) { /* noop */ }
    }
    const onLiveModelCall = (info) => {
      try {
        clearLiveTickers();
        const stepNo = (Number(info && info.step) || 0) + 1;
        const maxStepsNo = Number(info && info.maxSteps) || stepNo;
        const finalizing = Boolean(info && info.finalize);
        const label = finalizing
          ? 'Redactando la respuesta final'
          : (stepNo === 1 ? 'Planificando cómo responder' : 'Decidiendo el siguiente paso');
        const parts = [];
        if (!finalizing) parts.push(`paso ${stepNo} de ${maxStepsNo}`);
        if (__liveModelName) parts.push(__liveModelName);
        const toolCount = Number(info && info.toolCount) || 0;
        if (stepNo === 1 && toolCount > 0) parts.push(`${turnProgressLib.fmtInt(toolCount)} ${toolCount === 1 ? 'herramienta disponible' : 'herramientas disponibles'}`);
        const detail = truncate(parts.join(' · '), LIVE_DETAIL_MAX);
        let row = state.steps[state.steps.length - 1];
        if (liveStepSynthetic(row)) {
          row.label = label;
          row.detail = detail;
          if (!row.startedAt) row.startedAt = Date.now();
        } else {
          row = {
            id: `step-${stepNo}-decide`,
            label,
            icon: 'thought',
            status: 'running',
            startedAt: Date.now(),
            detail,
            toolCalls: [],
          };
          state.steps.push(row);
        }
        writeLiveSentinel();
        if (progress && typeof progress.begin === 'function') {
          if (__liveModelHandle) __liveModelHandle.done();
          __liveModelHandle = progress.begin('agent_model', label, { tool: 'model', detail });
        }
        const limitSecs = Math.round((Number(info && info.stepTimeoutMs) || 0) / 1000);
        const tick = (ms, text) => {
          const timer = setTimeout(() => {
            __liveTickers.delete(timer);
            if (row.status !== 'running' || (signal && signal.aborted)) return;
            row.detail = truncate(text, LIVE_DETAIL_MAX);
            writeLiveSentinel();
            if (__liveModelHandle) __liveModelHandle.update({ detail: row.detail });
          }, ms);
          if (timer && typeof timer.unref === 'function') timer.unref();
          __liveTickers.add(timer);
        };
        // A fact, not a guess: the call is not streamed, so all we know at
        // 12 s is that the model has not answered yet.
        tick(LIVE_TICK_REASONING_MS, finalizing
          ? `${__liveModelLabel} sin respuesta todavía`
          : `${__liveModelLabel} sin respuesta todavía · paso ${stepNo} de ${maxStepsNo}`);
        tick(LIVE_TICK_SLOW_MS, limitSecs > 0
          ? `Tarda más de lo habitual · límite del paso ${limitSecs} s`
          : 'Tarda más de lo habitual');
      } catch (_) { /* live progress never breaks the loop */ }
    };
    const onLiveModelResponse = (info) => {
      try {
        clearLiveTickers();
        const row = state.steps[state.steps.length - 1];
        const took = turnProgressLib.fmtMs(Number(info && info.durationMs) || 0);
        let detail;
        let failed = false;
        if (info && info.failed) {
          failed = true;
          const secs = Math.round((Number(info.stepTimeoutMs) || 0) / 1000);
          // The exact cause by category, with the model's display name
          // («DeepSeek V4 Pro no tiene saldo en su proveedor»).
          // The model that really ran (react-agent may have failed over):
          // its own display name, or «El modelo» — never another model's.
          const sameModel = !info.model || String(info.model).trim().toLowerCase() === String(model || '').trim().toLowerCase();
          const failedName = sameModel
            ? __liveModelLabel
            : (turnProgressLib.displayNameFor(info.model) || 'El modelo');
          const category = info.timedOut ? 'timeout' : info.category;
          detail = info.aborted
            ? 'Detenido'
            : (category && category !== 'unknown'
              ? turnProgressLib.modelFailureText(failedName, category, {
                timeoutMs: info.timedOut && secs > 0 ? secs * 1000 : null,
                retryAfterSeconds: info.retryAfterSeconds,
              })
              : `${capitalizeFirst(failedName)} no pudo responder`);
        } else {
          detail = describeLiveDecision(Array.isArray(info && info.toolNames) ? info.toolNames : [], took);
        }
        if (liveStepSynthetic(row)) {
          row.status = failed && !(info && info.aborted) ? 'error' : 'done';
          row.endedAt = Date.now();
          row.detail = truncate(detail, LIVE_DETAIL_MAX);
          writeLiveSentinel();
        }
        if (__liveModelHandle) {
          if (failed && !(info && info.aborted)) __liveModelHandle.fail(null, { detail });
          else __liveModelHandle.done(null, { detail });
          __liveModelHandle = null;
        }
      } catch (_) { /* live progress never breaks the loop */ }
    };
    const onLiveGuard = (info) => {
      try {
        const phase = info && info.phase;
        if (phase === 'start') {
          state.steps.push({
            id: `step-${(Number(info.step) || 0) + 1}-verify-${state.steps.length}`,
            label: 'Verificando que la respuesta cumpla lo pedido',
            icon: 'thought',
            status: 'running',
            startedAt: Date.now(),
            toolCalls: [],
          });
          writeLiveSentinel();
          if (progress && typeof progress.begin === 'function') {
            __liveGuardHandle = progress.begin('agent_model', 'Verificando que la respuesta cumpla lo pedido', { tool: 'verify' });
          }
          return;
        }
        const row = [...state.steps].reverse().find((s) => s && s.status === 'running' && /-verify-\d+$/.test(String(s.id || '')));
        const label = phase === 'pass'
          ? 'Verificación superada'
          : (phase === 'repair' ? `Corrigiendo: ${guardCategoryEs(info && info.category)}` : 'Verificación detenida');
        if (row) {
          row.status = 'done';
          row.endedAt = Date.now();
          row.label = label;
          writeLiveSentinel();
        }
        if (__liveGuardHandle) {
          __liveGuardHandle.done(label);
          __liveGuardHandle = null;
        }
      } catch (_) { /* live progress never breaks the loop */ }
    };

    let result;
    try {
      result = await reactAgent.run(openai, {
        query: userQuery,
        tools: coreTools,
        deferredTools: deferredAgentTools,
        model,
        maxSteps: maxStepsOverride,
        maxRuntimeMs: maxRuntimeOverride,
        extraSystem,
        initialToolChoice,
        toolCallMode,
        parallelToolCalls: __parallelToolCalls,
        thinkingLevel,
        thinkingLevelExplicit,
        ctx: {
          ...toolContext,
          documentEditLlm: { client: openai, model, provider, toolCallMode },
          signal,
          provider,
          onEvent,
          toolGate,
          toolAuthCtx: {
            userId: toolContext.userId || null,
            clearance: toolContext.clearance || null,
            permission: composerPermission,
          },
          toolUsageMap: Object.create(null),
          checkToolBudget: (name, usage) => checkWebToolBudget(name, usage, { searches: webLookupLimit, reads: webReadLimit }),
        },
        finalizeGuard: composedFinalizeGuard,
        onBeforeStep: async (step) => {
          if (githubHandoff.pending) return { stop: true, reason: 'github_connection_required' };
          return __coworkRun ? beforeCoworkStep(step) : null;
        },
        onCheckpoint: __coworkRun
          ? (checkpoint) => require('./cowork/control-plane').saveCheckpoint(toolContext.prisma, {
            runId: __coworkRun.id,
            userId: toolContext.userId,
            checkpoint,
          })
          : null,
        onCompact: ({ step, removedMessages, chars }) => {
          try { console.log(`[agentic-chat] trace compacted at step ${step}: -${removedMessages} msgs, ${chars} chars`); } catch (_) {}
        },
        onModelCall: __liveProgressOn ? onLiveModelCall : null,
        onModelResponse: __liveProgressOn ? onLiveModelResponse : null,
        onGuard: __liveProgressOn ? onLiveGuard : null,
        onStepStart: async (stepRec) => {
        // Harness first (synchronous prefix): registers the step's planned
        // tool calls and emits typed tool_call_start frames BEFORE the
        // sentinel replace below, so the AgentTrace timeline leads the UI.
        if (__harness) __harness.onStepStart(stepRec);
        stepCounter += 1;
        // Mark the previous synthetic step done.
        const last = state.steps[state.steps.length - 1];
        if (last && last.status === 'running') {
          last.status = 'done';
          if (!last.endedAt) last.endedAt = Date.now();
        }

        // The model's natural-language reasoning for this step. Surfacing it
        // (instead of only a terse "Pensando" / tool label) is what makes the
        // chat show its thinking like Claude. Sanitised + capped so JSON /
        // tool-state never leaks into the visible narration.
        const reasoning = redactGeneratedArtifactText(sanitizeReasoning(stepRec?.thought));

        // Project each tool call as its own visible step so the timeline
        // reads "buscando X → leyendo fuente N → componiendo respuesta".
        const actions = Array.isArray(stepRec?.actions) ? stepRec.actions : [];
        if (actions.length === 0) {
          state.steps.push({
            id: `step-${stepCounter}-think`,
            label: 'Razonando',
            icon: 'thought',
            ...(reasoning ? { reasoning } : {}),
            status: 'running',
            toolCalls: [],
          });
        } else {
          actions.forEach((a, idx) => {
            const args = safeArgs(a?.args);
            const label = stageLabelFor(a?.tool, args);
            const detail = __liveProgressOn ? liveArgsDetail(args, label) : '';
            state.steps.push({
              id: `step-${stepCounter}-${idx}`,
              label,
              icon: 'thought',
              // Attach the reasoning to the first projected step of this turn
              // so the "why" sits next to the "what".
              ...(idx === 0 && reasoning ? { reasoning } : {}),
              status: 'running',
              startedAt: Date.now(),
              ...(detail ? { detail } : {}),
              toolCalls: [{ tool: a?.tool || 'unknown' }],
            });
            // Lightweight stage event for any consumer that listens. The
            // `agent_step` phase keeps it on AgenticSteps / AgentTrace (never
            // a second timeline); no callId, so the bubble keeps its renderer.
            writeSse(res, {
              type: 'stage',
              label,
              tool: a?.tool || 'unknown',
              ...(__liveProgressOn ? { phase: 'agent_step' } : {}),
              ...(detail ? { detail } : {}),
              ...(idx === 0 && reasoning ? { reasoning } : {}),
            });
          });
        }
        await writeSse(res, { replace: true, content: serializeSentinel(state) });
        },
        onStepDone: async (stepRec) => {
        // Harness first: settle tool calls that never reached execute()
        // (duplicate-cache hits, exhausted tools, invalid args) from their
        // observations so every tool_call_start gets its tool_result.
        if (__harness) __harness.onStepDone(stepRec);
        // Walk the actions in reverse and attach status to the most-recent
        // matching running step so an output lines up with its start.
        const actions = Array.isArray(stepRec?.actions) ? stepRec.actions : [];
        for (const action of actions) await githubHandoff.observe(action?.tool, action?.observation);
        for (let i = actions.length - 1; i >= 0; i--) {
          const a = actions[i];
          for (let j = state.steps.length - 1; j >= 0; j--) {
            const s = state.steps[j];
            if (s.status !== 'running') continue;
            if ((s.toolCalls[0] && s.toolCalls[0].tool) !== a?.tool) continue;
            const obs = a?.observation || {};
            const ok = !obs?.error;
            s.status = ok ? 'done' : 'error';
            s.endedAt = Date.now();
            const resultDetail = !__liveProgressOn ? ''
              : (ok ? liveResultDetail(obs) : `Error: ${liveErrorCategory(extractObservationError(obs))}`);
            if (resultDetail) s.detail = truncate(resultDetail, LIVE_DETAIL_MAX);
            if (ok) {
              s.toolCalls[0].output = { ok };
            } else {
              // Surface WHY the tool failed: attach the real message to the
              // tool output (structured, persisted) AND to the step's
              // reasoning line, which the chat timeline already renders as the
              // step detail — so a failed step shows the cause, not just a
              // red badge.
              const errText = redactGeneratedArtifactText(extractObservationError(obs));
              const toolName = (s.toolCalls[0] && s.toolCalls[0].tool) || a?.tool || 'la herramienta';
              s.toolCalls[0].output = { ok, error: errText || 'falló la ejecución' };
              const prefix = `Error en ${toolName}: ${errText || 'falló la ejecución'}`;
              s.reasoning = s.reasoning
                ? truncate(`${prefix} — ${s.reasoning}`, REASONING_MAX_CHARS)
                : truncate(prefix, REASONING_MAX_CHARS);
            }
            break;
          }
        }
        await writeSse(res, { replace: true, content: serializeSentinel(state) });
        if (__coworkRun) {
          await require('./cowork/control-plane').recordStep(toolContext.prisma, {
            runId: __coworkRun.id,
            userId: toolContext.userId,
            step: stepCounter,
            tokensEstimate: stepRec?.usage?.tokensEstimate || 0,
            costUsd: stepRec?.usage?.costUsd || 0,
            event: actions.length
              ? `Completed: ${actions.map((action) => action?.tool).filter(Boolean).join(', ')}`
              : `Completed reasoning step ${stepCounter}`,
          }).catch(() => {});
        }
        },
      });
    } catch (agentRunError) {
      if (__coworkRun) {
        const interrupted = signal?.aborted || /cancel|abort/i.test(String(agentRunError?.code || agentRunError?.message || ''));
        await require('./cowork/control-plane').finishRun(toolContext.prisma, {
          runId: __coworkRun.id,
          userId: toolContext.userId,
          status: interrupted ? 'cancelled' : 'failed',
          lastEvent: String(agentRunError?.message || agentRunError).slice(0, 4000),
        }).catch(() => {});
      }
      if (pluginLifecycle && agentRunError?.code !== 'ABORT_ERR') {
        try { await pluginLifecycle.error(agentRunError, { phase: 'run' }); } catch (_) { /* plugin telemetry must not mask the run error */ }
      }
      throw agentRunError;
    } finally {
      clearLiveTickers();
      if (signal && typeof signal.removeEventListener === 'function') {
        try { signal.removeEventListener('abort', onLiveAbort); } catch (_) { /* noop */ }
      }
      try { if (__liveModelHandle) __liveModelHandle.done(); } catch (_) { /* noop */ }
      try { if (__liveGuardHandle) __liveGuardHandle.done(); } catch (_) { /* noop */ }
      __liveModelHandle = null;
      __liveGuardHandle = null;
    }

    let deliveryReleaseBlocked = false;
    if (artifactDeliveryContract.active && !signal?.aborted
      && (result?.stoppedReason === 'finalized' || result?.stoppedReason === 'plain_text_finalize')) {
      const delivery = validateArtifactDelivery(artifactDeliveryContract, {
        artifacts: pendingDeliveryArtifacts,
        steps: result.steps,
        unavailableTools: result.exhaustedTools,
      });
      if (delivery.ok && !delivery.degraded) {
        state.artifacts.push(...delivery.selectedArtifacts);
        for (const artifact of delivery.selectedArtifacts) importArtifactToWorkspace(artifact);
      } else {
        deliveryReleaseBlocked = true;
      }
    }
    const deliveryStoppedReason = deliveryReleaseBlocked
      ? 'verification_failed:artifact_delivery'
      : (result?.stoppedReason || 'finalized');

    if (pluginLifecycle && !signal?.aborted) {
      try {
        await pluginLifecycle.afterRun({ ...result, stoppedReason: deliveryStoppedReason });
        state.meta.plugins = pluginLifecycle.summary();
      } catch (pluginAfterError) {
        if (pluginAfterError?.code !== 'ABORT_ERR') {
          console.warn('[agentic-chat] plugin afterRun failed (continuing):', pluginAfterError?.message || pluginAfterError);
        }
      }
    }

    // Mark any leftover running steps as done — react-agent guarantees a
    // finalize on the last step, but defensive coding keeps stale running
    // states from leaking into the persisted sentinel.
    for (const s of state.steps) {
      if (s.status !== 'running') continue;
      s.status = 'done';
      if (!s.endedAt) s.endedAt = Date.now();
    }
    state.done = true;

    let finalAnswer = (result?.finalAnswer || '').trim()
      || 'No pude generar una respuesta verificable. Intenta reformular la pregunta.';
    let stoppedReason = deliveryStoppedReason;
    if (githubHandoff.pending && !signal?.aborted) {
      finalAnswer = githubHandoffModule.GITHUB_HANDOFF_MESSAGE;
      stoppedReason = 'github_connection_required';
    }
    if (deliveryReleaseBlocked) {
      finalAnswer = 'No pude verificar todos los archivos solicitados. No entregaré una parte como si fuera el resultado completo; vuelve a intentarlo.';
    }
    if (generatedArtifactRefs.length) {
      const { successfulToolCalls } = require('./agents/agentic-execution-profile');
      const { missingRequestedArtifactFormats } = require('./agents/generated-artifact-followup');
      const readCount = successfulToolCalls(Array.isArray(result?.steps) ? result.steps : []).get('python_exec') || 0;
      const missing = missingRequestedArtifactFormats(generatedArtifactRefs, userQuery);
      if (missing.length) {
        finalAnswer = `La entrega más reciente de este chat no contiene ${missing.map((format) => `.${format}`).join(' ni ')}. No puedo comparar todos los archivos solicitados; adjunta el archivo que falta o pide regenerar la pareja.`;
        stoppedReason = 'generated_artifact_read_failed';
      } else if (readCount === 0) {
        finalAnswer = 'No pude abrir y verificar los archivos generados en este chat. No puedo concluir si sus datos coinciden; vuelve a intentarlo.';
        stoppedReason = 'generated_artifact_read_failed';
      }
      finalAnswer = redactGeneratedArtifactText(finalAnswer);
    }
    // Office edit turn that ended with substitutes (.html / .py / images)
    // and no file of the requested type: the answer must not present them as
    // the edited document. Honest failure, substitute cards dropped from the
    // persisted turn.
    if (officeEditFormats.length && !signal?.aborted && Array.isArray(state.artifacts)) {
      const acceptable = new Set(officeEditFormats.flatMap((format) => (
        format === 'pptx' ? ['pptx', 'pptm', 'potx'] : format === 'docx' ? ['docx', 'docm', 'dotx'] : ['xlsx', 'xlsm', 'xltx']
      )));
      const delivered = state.artifacts.some((artifact) => acceptable.has(artifactFormatOf(artifact)));
      const substitutes = state.artifacts.filter((artifact) => OFFICE_SUBSTITUTE_FORMATS.has(artifactFormatOf(artifact)));
      if (!delivered && substitutes.length) {
        for (const artifact of substitutes) {
          const index = state.artifacts.indexOf(artifact);
          if (index >= 0) state.artifacts.splice(index, 1);
        }
        finalAnswer = officeEditSubstituteMessage(officeEditFormats);
        stoppedReason = 'source_preserving_document_edit_failed';
        try {
          require('./observability/turn-failures').noteTurn('tool_failure', {
            tool: 'document_edit',
            reason: 'office_edit_substitute_artifacts',
            fatal: true,
            message: substitutes.map((artifact) => artifact.filename).join(', ').slice(0, 300),
          });
        } catch (_) { /* advisory */ }
      }
    }
    try {
      finalAnswer = require('./computer/login-handoff').filterModelPasswordPaste(finalAnswer);
    } catch (_) { /* never block the answer on a filter miss */ }
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
    } catch (err) {
      try { console.warn('[agentic-chat-stream] honesty check failed:', err && err.message); } catch (_) {}
      /* honesty check must never break the response */
    }

    // Emit the final sentinel + the answer body. Phase 5: when
    // SIRAGPT_AGENTIC_STREAM_FINAL is enabled, token-stream the answer
    // progressively (the agentic path otherwise dumps the whole answer in one
    // frame). Default ON → progressive streaming; set =0 to restore the
    // single-frame behavior. Hard fallback so streaming can never break the response.
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

    // Close the harness run: settles dangling calls, emits agent_done
    // (steps, duration, token/cost estimate, interrupted flag) AFTER the
    // final answer streamed — the UI collapses the trace on this frame —
    // and returns the persistence-ready record for agent_steps.
    let agentRun = null;
    if (__harness) {
      try {
        agentRun = __harness.finish({
          stoppedReason,
          interrupted: Boolean(signal && signal.aborted),
          finalAnswer,
        });
      } catch (finishErr) {
        console.warn('[agent-harness] finish failed:', finishErr && finishErr.message);
      }
    }
    if (__coworkRun) {
      const status = signal?.aborted || /cancelled_by_user|aborted|cost_budget_exhausted/.test(stoppedReason)
        ? 'cancelled'
        : statusForAgentStopReason(stoppedReason);
      const completedRun = await require('./cowork/control-plane').finishRun(toolContext.prisma, {
        runId: __coworkRun.id,
        userId: toolContext.userId,
        status,
        lastEvent: stoppedReason,
        costUsd: agentRun?.costUsdEstimate ?? null,
        tokensEstimate: agentRun?.tokensEstimate ?? null,
      }).catch(() => null);
      if (completedRun) {
        writeSse(res, {
          type: 'cowork_run_finished',
          run: {
            id: completedRun.id,
            workspaceId: completedRun.workspaceId,
            status: completedRun.status,
            currentStep: completedRun.currentStep,
            maxSteps: completedRun.maxSteps,
            costUsd: completedRun.costUsd,
            tokensEstimate: completedRun.tokensEstimate,
            lastEvent: completedRun.lastEvent,
          },
        });
      }
    }

    if (!skipDoneSentinel) {
      if (!res.writableEnded) {
        try { res.write('data: [DONE]\n\n'); } catch { /* socket gone */ }
      }
    }

    return {
      finalAnswer,
      persistedContent: buildPersistedContent(state, finalAnswer),
      stoppedReason,
      steps: result?.steps || [],
      artifacts: state.artifacts,
      agentRun,
      // The provider error that ended the loop ({status, code, message,
      // reason}): the route closes a dry / rejected provider honestly with
      // the model's name and the cause (agentic-degrade-policy).
      modelError: result?.modelError || null,
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
  function adaptAgentTool(tool, jsonSchema, retryPolicy = {}) {
    return {
      name: tool.name,
      description: tool.description,
      parameters: jsonSchema,
      ...(retryPolicy.readOnly === true ? { readOnly: true } : {}),
      // Only explicit local policy may authorize retries. Tool metadata,
      // names and returned-vs-thrown errors do not prove idempotency.
      execute: async (args, _ctx) => runToolWithRetry(
        (a, c) => tool.handler(a, c),
        args,
        _ctx,
        { label: tool.name, retrySafe: retryPolicy.retrySafe === true },
      ),
    };
  }

  function baseWebTools() {
    // Audited first-party reads only. Browser actions, writes, sub-agent
    // creation and generic app executors remain single-attempt by default.
    const adaptReadOnlyTool = (tool, schema) => adaptAgentTool(tool, schema, { retrySafe: true, readOnly: true });
    return [
      // react-agent expects {name,description,parameters,execute(args,ctx)};
      // agent-tools entries use {schema,handler}. Adapt them inline.
      adaptReadOnlyTool(agentTools.web_search, {
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
      adaptReadOnlyTool(agentTools.read_url, {
        type: 'object',
        properties: {
          url:      { type: 'string', description: 'Absolute http(s) URL to read.' },
          maxChars: { type: 'integer', minimum: 500, maximum: 50000, description: 'Markdown cap. Default 12000.' },
        },
        required: ['url'],
        additionalProperties: false,
      }),
      adaptReadOnlyTool(agentTools.web_extract, {
        type: 'object',
        properties: {
          url:      { type: 'string', description: 'Absolute http(s) URL to extract as readable markdown.' },
          maxChars: { type: 'integer', minimum: 500, maximum: 50000, description: 'Markdown cap. Default 12000.' },
        },
        required: ['url'],
        additionalProperties: false,
      }),
      adaptReadOnlyTool(agentTools.session_search, {
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
      adaptReadOnlyTool(agentTools.session_list, {
        type: 'object',
        properties: {
          limit:           { type: 'integer', minimum: 1, maximum: 50, description: 'How many recent sessions to return, newest first. Default 10.' },
          includeArchived: { type: 'boolean', description: 'Include archived sessions. Default false.' },
        },
        additionalProperties: false,
      }),
      adaptReadOnlyTool(agentTools.session_history, {
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
      adaptReadOnlyTool(agentTools.github_search, {
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
      adaptReadOnlyTool(agentTools.scientific_search, {
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
      adaptAgentTool(agentTools.github_list_repos, {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 30, description: 'How many repos. Default 10.' },
        },
        additionalProperties: false,
      }),
      adaptAgentTool(agentTools.github_create_issue, {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner.' },
          repo: { type: 'string', description: 'Repository name.' },
          title: { type: 'string', description: 'Issue title.' },
          body: { type: 'string', description: 'Issue body.' },
          approved: { type: 'boolean', description: 'Required true to perform the write.' },
        },
        required: ['owner', 'repo', 'title'],
        additionalProperties: false,
      }),
      adaptAgentTool(agentTools.construir_scaffold, {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What to build. Defaults to the user message.' },
          title: { type: 'string', description: 'Short project title.' },
          publishGithub: { type: 'boolean', description: 'Also publish if GitHub OAuth is connected.' },
          repoName: { type: 'string', description: 'GitHub repository name.' },
          approved: { type: 'boolean', description: 'Required true if publishGithub.' },
        },
        additionalProperties: false,
      }),
      adaptAgentTool(agentTools.github_publish_project, {
        type: 'object',
        properties: {
          repoName: { type: 'string', description: 'Repository name.' },
          branch: { type: 'string', description: 'Branch to create when the repo already exists.' },
          description: { type: 'string', description: 'Repository description.' },
          approved: { type: 'boolean', description: 'Required true to publish.' },
        },
        additionalProperties: false,
      }),
      adaptAgentTool(agentTools.github_open_repo, {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'GitHub owner or org.' },
          repo: { type: 'string', description: 'Repository name, or owner/repo.' },
          ref: { type: 'string', description: 'Branch to open. Defaults to the repo default branch.' },
        },
        additionalProperties: false,
      }),
      adaptAgentTool(agentTools.github_repo_list, {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory inside the isolated workspace.' },
          workspaceId: { type: 'string', description: 'Workspace from github_open_repo.' },
        },
        additionalProperties: false,
      }),
      adaptAgentTool(agentTools.github_repo_read, {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path inside the isolated workspace.' },
          workspaceId: { type: 'string', description: 'Workspace from github_open_repo.' },
        },
        required: ['path'],
        additionalProperties: false,
      }),
      adaptAgentTool(agentTools.github_repo_write, {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path inside the isolated workspace.' },
          content: { type: 'string', description: 'New file contents.' },
          workspaceId: { type: 'string', description: 'Workspace from github_open_repo.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      }),
      adaptAgentTool(agentTools.github_repo_exec, {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Executable name (ls, cat, pwd). No shell metacharacters.' },
          args: { type: 'array', items: { type: 'string' }, description: 'Arguments. Paths must stay inside the workspace.' },
          workspaceId: { type: 'string', description: 'Workspace from github_open_repo.' },
        },
        required: ['command'],
        additionalProperties: false,
      }),
      adaptAgentTool(agentTools.github_open_pull_request, {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Pull request title.' },
          body: { type: 'string', description: 'Pull request body.' },
          branch: { type: 'string', description: 'Work branch. Never main or master.' },
          base: { type: 'string', description: 'Base branch. Defaults to the repo default.' },
          approved: { type: 'boolean', description: 'Required true to open the PR.' },
          workspaceId: { type: 'string', description: 'Workspace from github_open_repo.' },
        },
        required: ['title'],
        additionalProperties: false,
      }),
      adaptAgentTool(agentTools.linkedin_read_profile, {
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
      adaptAgentTool(agentTools.linkedin_publish_post, {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Post text.' },
          approved: { type: 'boolean', description: 'Required true to publish.' },
        },
        required: ['text'],
        additionalProperties: false,
      }),
      adaptAgentTool(agentTools.x_list_mentions, {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 5, maximum: 20, description: 'How many mentions. Default 10.' },
        },
        additionalProperties: false,
      }),
      adaptAgentTool(agentTools.x_publish_post, {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Post text, max 280.' },
          approved: { type: 'boolean', description: 'Required true to publish.' },
        },
        required: ['text'],
        additionalProperties: false,
      }),
    ];
  }

  function loadMemoryTools() {
    try {
      // eslint-disable-next-line global-require
      return require('./agents/memory-tools').MEMORY_TOOLS;
    } catch (err) {
      try { console.warn('[agentic-chat] memory tools unavailable:', err && err.message); } catch (_) {}
      return [];
    }
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
    const base = [...baseWebTools(), ...loadTaskTools(), ...loadMemoryTools(), cloneProjectTool, hostBashTool, hostFileTool, listDirTool, globFilesTool, codeGrepTool, checkCiStatusTool, monitorCiTool, projectReadTool, projectWriteTool, projectExecTool, projectCloneRepoTool, projectPreviewStartTool, projectPreviewStatusTool, projectPreviewStopTool, projectChangesTool, projectOpenPullRequestTool, projectPullRequestChecksTool, decideWithJevTool];
    const userQuery = opts && typeof opts.userQuery === 'string' ? opts.userQuery : '';

    // Phase C: expose the real, policy-gated filesystem skills (openalex,
    // crossref, apa7, sessions, scheduling…) via ONE `run_skill` tool, so the
    // chat agent can actually execute them. Policy is enforced per-call by the
    // user's clearance. Skipped when SIRAGPT_SKILLS_IN_CHAT=0 or unavailable.
    try {
      const skillRunner = require('./agents/skill-runner');
      const skillPolicy = opts?.skillPolicy || null;
      if (opts?.capabilities?.skillsEnabled !== false) {
        const skillToolOptions = {
          ctx: {
            clearance: (opts && opts.clearance) || null,
            ...(Array.isArray(skillPolicy?.allowedSkillIds)
              ? { allowedSkillIds: skillPolicy.allowedSkillIds }
              : {}),
          },
          allowedSkillIds: Array.isArray(skillPolicy?.allowedSkillIds) ? skillPolicy.allowedSkillIds : null,
          recommendedSkillIds: Array.isArray(skillPolicy?.recommendedSkillIds) ? skillPolicy.recommendedSkillIds : [],
        };
        const runSkillTool = skillRunner.buildRunSkillTool(skillToolOptions);
        if (runSkillTool) base.push(runSkillTool);
        const runSkillPipelineTool = skillRunner.buildRunSkillPipelineTool(skillToolOptions);
        if (runSkillPipelineTool) base.push(runSkillPipelineTool);
      }
    } catch (skillToolErr) {
      console.warn('[skills-in-chat] run_skill tool unavailable:', skillToolErr && skillToolErr.message);
    }

    // Creation tools (image/video/audio/music + the 30+ diagram/chart tools)
    // ship on EVERY agentic turn by default — a mid-conversation "ahora hazme
    // un diagrama de eso" must work even when the opening turn had no media
    // intent. The per-turn tool selector below keeps the effective set small.
    // SIRAGPT_MEDIA_TOOLS_ALWAYS=0 restores the legacy intent-gated loading.
    try {
      const chatComputer = require('./computer/chat-computer-tools');
      if (chatComputer.shouldOfferComputerTools(process.env)) {
        const computerTools = chatComputer.buildChatComputerTools({
          userId: (opts && opts.userId) || (opts && opts.clearance && opts.clearance.userId),
          conversationId: opts && opts.chatId,
          env: process.env,
        });
        if (Array.isArray(computerTools) && computerTools.length) base.push(...computerTools);
      }
    } catch (computerErr) {
      try { console.warn('[agentic-chat] computer tools unavailable:', computerErr && computerErr.message); } catch (_) {}
    }

    const mediaAlways = envFlagEnabled(process.env.SIRAGPT_MEDIA_TOOLS_ALWAYS, true);
    const wantsMedia = mediaAlways
      || (!!userQuery && (isAgenticActionRequest(userQuery) || !!detectMediaIntent(userQuery).kind));
    const tools = wantsMedia ? [...base, ...loadMediaTools()] : base;
    const seen = new Set();
    const deduped = tools.filter((tool) => {
      if (!tool || !tool.name || seen.has(tool.name)) return false;
      seen.add(tool.name);
      return true;
    });

    // Per-GPT capability gating. A custom GPT can disable tools per capability.
    // SAFE DEFAULT: capabilities == null (legacy GPTs / normal non-GPT chats) →
    // no gating. A tool is dropped only when its capability is EXPLICITLY false;
    // missing keys stay ON so partial objects never silently disable tools.
    // Kill switch: SIRAGPT_GPT_CAPABILITIES_GATING=0.
    const gated = applyCustomGptCapabilityGates(deduped, opts && opts.capabilities);
    if (gated.length !== deduped.length) {
      const caps = opts && opts.capabilities;
      console.log(`[gpt-capabilities] gated ${deduped.length - gated.length} tools (web=${caps?.webBrowsing !== false} img=${caps?.imageGeneration !== false} canvas=${caps?.dataAnalysis !== false} code=${caps?.codeInterpreter !== false} docs=${caps?.documents !== false} skills=${caps?.skillsEnabled !== false})`);
    }

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
          tools: gated,
          userQuery,
          decision: sel.decision || null,
          intent: sel.intent || (sel.decision && sel.decision.intent) || null,
          signals: {
            ...(sel.signals || {}),
            mentionedAppTools: opts.mentionedAppTools
              || (opts.toolContext && opts.toolContext.mentionedAppTools)
              || [],
          },
          maxTools: sel.maxTools,
        });
        if (picked && picked.applied && Array.isArray(picked.tools) && picked.tools.length >= 4) {
          console.log(`[tool-selector] ${picked.reason}: ${picked.keptCount}/${gated.length} tools (dropped ${picked.droppedCount})`);
          return picked.tools;
        }
      } catch (selErr) {
        console.warn('[tool-selector] selection failed (using full set):', selErr && selErr.message);
      }
    }
    return gated;
  }

  /**
   * Read the runtime feature flag for the agentic chat path. Agentic chat
   * remains available for tool-capable models. The turn-level policy above
   * decides whether tools are warranted; operators can still disable the
   * runtime entirely without a deploy.
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
    // Phase-1 spec name for the harness-enriched agent turn: runAgenticChat
    // IS the runAgentTurn implementation (capability-gated tool-call mode,
    // typed SSE events, permission gate, agent_steps persistence record).
    runAgentTurn: runAgenticChat,
    isEnabled,
    shouldUseAgenticChat,
    isHandledAgenticChatResult,
    modelSupportsFunctionCalling,
    resolveToolCallMode,
    promptedToolsEnabled,
    agentFirstEnabled,
    // Exposed for tests:
    _internal: {
      freshState,
      serializeSentinel,
      buildPersistedContent,
      extractObservationError,
      stageLabelFor,
      buildThreadWorkContext,
      buildAgentHistoryBlock,
      AGENT_HISTORY_MAX_CHARS,
      adaptAgentTool,
      baseWebTools,
      buildDefaultTools,
      applyCustomGptCapabilityGates,
      webSearchBudget,
      webReadBudget,
      checkWebToolBudget,
      withWebSearchBudget,
      withWebReadBudget,
      withImageEditGuard,
      buildChatFinalizeProfile,
      SENTINEL_FENCE_OPEN,
      SENTINEL_FENCE_CLOSE,
    },
  };

/**
 * semantic-intent-router
 *
 * Contract-first bridge between the chat UI legacy intents and the
 * UniversalTaskContract/Enterprise ExecutionGraph runtime. The frontend
 * still receives the same small ChatIntent enum, but the decision is now
 * derived from a validated contract, closed pipeline taxonomy, required
 * tools, DAG shape, validation gates and release policy. Legacy keyword
 * routing remains only as client fallback when this backend layer is not
 * reachable.
 */

const crypto = require('crypto');
const {
  buildUniversalTaskContract,
  validateUniversalTaskContract,
} = require('./universal-task-contract');
const {
  buildEnterpriseExecutionGraph,
  buildEnterpriseRuntimeProfile,
} = require('./enterprise-agentic-runtime');
const { buildToolRuntimePlan } = require('./enterprise-tool-gateway');
const { buildAgenticQaBoardReview } = require('./agentic-qa-board');
const { buildAgenticOperatingCore } = require('./agentic-operating-core');
const {
  buildCiraCognitiveTaskEnvelope,
  validateCiraCognitiveTaskEnvelope,
} = require('./cira-cognitive-task-envelope');
const productModelRouter = require('../ai-product-os/model-router');
const productSkillSystem = require('../ai-product-os/skill-system');
const productPlanner = require('../ai-product-os/planner-agent');
const productIntentRouter = require('../ai-product-os/semantic-intent-router');
const { analyzeRequestTokens } = require('./request-token-intelligence');
const { buildUserIntentAttributionGraph } = require('./user-intent-attribution-graph');

const VALID_CHAT_INTENTS = new Set([
  'gmail',
  'google_services',
  'web_search',
  'image',
  'video',
  'ppt',
  'figma',
  'plan',
  'math',
  'viz',
  'doc',
  'artifact',
  'chart',
  'webdev',
  'agent_task',
  'text',
]);

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function matchAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

const EXISTING_DOCUMENT_REFERENCE_RE =
  /\b(?:del|de la|de el|en el|sobre el|este|esta|ese|esa|mi|el|la)\s+(?:word|documento|archivo|adjunto|docx?|pdf|excel|xlsx|power\s*point|powerpoint|pptx?)\b|\b(?:word|documento|archivo|adjunto|docx?|pdf|excel|xlsx|pptx?)\s+(?:adjunto|subido|cargado|anterior)\b/i;

const DOCUMENT_UNDERSTANDING_RE =
  /\b(?:cual|cu[aá]l|que|qu[eé]|quien|qui[eé]n|cuando|cu[aá]ndo|donde|d[oó]nde|primera\s+palabra|primer\s+parrafo|primer\s+p[aá]rrafo|resume|resumen|resumir|analiza|analisis|an[aá]lisis|lee|leer|extrae|extraer|identifica|identificar|dime|segun|seg[uú]n|explica|explicar|contenido|menciona|dice)\b/i;

const OUTPUT_FORMAT_REQUEST_RE =
  /\b(?:en|como|a)\s+(?:un\s+|una\s+)?(?:word|docx|pdf|excel|xlsx|pptx|power\s*point|powerpoint)\b|\b(?:genera(?:r|me)?|crea(?:r|me)?|haz(?:me)?|exporta(?:r|me)?|descarga(?:r|me)?|prepara(?:r|me)?|elabora(?:r|me)?|redacta(?:r|me)?)\b.*\b(?:word|docx|pdf|excel|xlsx|pptx|power\s*point|powerpoint|documento|archivo|informe|reporte|presentaci[oó]n)\b/i;

function shouldAnswerFromExistingDocument(rawUserRequest) {
  const n = normalizeText(rawUserRequest);
  if (!n) return false;
  if (OUTPUT_FORMAT_REQUEST_RE.test(n)) return false;
  return EXISTING_DOCUMENT_REFERENCE_RE.test(n) && DOCUMENT_UNDERSTANDING_RE.test(n);
}

// User-facing improvement #2 (intent routing — negative-intent guards):
// When the user explicitly negates a capability ("no busques en internet",
// "sin documento", "no me hagas un video"), the regex-based signals above
// will still fire on the noun and produce a false positive (e.g. routing
// to web_search when the user just said don't search). NEGATION_GUARDS
// maps a signal key to keyword groups; if any keyword appears within
// ~32 chars after a negation word, that signal is forced false.
//
// We keep this narrow on purpose: we only mask out signals already
// detected by the affirmative patterns above — we never add new
// inferences from negations. That way:
//   - the contract-first pipeline upstream still sees the raw prompt,
//   - the domain_signals object becomes negation-aware,
//   - downstream callers (mapContractToChatIntent, requiresAgenticExecution,
//     productIntentForContract, etc.) get the corrected booleans for free.
//
// Tokens used as "negation":
//   no | sin | tampoco | nada de | nunca | ni
// They must precede the keyword with no more than 16 characters between
// them (≈3 short words) and not be themselves part of another word
// (\b anchors). 16 chars is calibrated to cover the canonical short
// negations:
//   "no busques en X"           (1 char gap)
//   "no me hagas un video"      (12 char gap)
//   "no me hagas una grafica"   (14 char gap)
//   "no necesito un grafico"    (13 char gap)
//   "sin web"                   (1 char gap)
//   "no uses gmail"             (5 char gap)
// while NOT firing on compound sentences where the negation scopes to
// a different verb, e.g. "no me importa nada mas, busca en internet"
// (22 char gap between "no" and "busca") — there the user does want to
// search, and our shorter window correctly keeps realtimeLookup alive.
// Trade-off: very long phrasings like "no te molestes en hacer una web"
// (26 char gap) will NOT be neutralized by this guard; those are rare
// and the contract-first layer upstream still sees the raw prompt so
// it can still detect text_only constraints elsewhere.
const NEGATION_TOKEN_RE = '(?:no|sin|tampoco|nada de|nunca|ni)';
const NEGATION_MAX_GAP = 16;
function buildNegationRegex(keywordAlternation) {
  return new RegExp(
    `\\b${NEGATION_TOKEN_RE}\\b[\\w\\s,;:]{0,${NEGATION_MAX_GAP}}?\\b(?:${keywordAlternation})\\b`,
    'i',
  );
}
const NEGATION_GUARDS = {
  realtimeLookup: buildNegationRegex('busca(?:r|s|me)?|busques|buscar en internet|web|internet|google|search|navega(?:r|s)?'),
  gmail:          buildNegationRegex('gmail|correo|correos|e-?mail|mail'),
  googleServices: buildNegationRegex('drive|calendario|calendar|carpeta|google'),
  webdev:         buildNegationRegex('web|website|p[aá]gina web|sitio web|landing|frontend|web app|app web'),
  video:          buildNegationRegex('video|clip|animaci[oó]n|veo3|sora'),
  plan:           buildNegationRegex('plano|planta|floor plan|blueprint|planos?'),
  figma:          buildNegationRegex('figma|wireframe|user flow|prototipo'),
  artifact:       buildNegationRegex('artefacto|artifact|simulador|widget|calculadora interactiva'),
  math:           buildNegationRegex('matem[aá]tica|matem[aá]ticas|c[aá]lculos?|calcular|ecuaci[oó]n|estad[ií]stica'),
  viz:            buildNegationRegex('gr[aá]fic[ao]?|chart|plot|diagrama|visualizaci[oó]n|dashboard'),
  repoOperation:  buildNegationRegex('repo|repositorio|github|git|clone|clona|commit|push|branch|rama|main|ci|actions?'),
};

// Contrastive constructions where "no" does NOT negate the following
// keyword but instead introduces an additive clause ("no solo X, sino
// también Y", "no únicamente X"). Architect-flagged regression: under
// the bare guard, "no solo busques en internet, también razona" would
// suppress realtimeLookup even though the user explicitly DOES want to
// search. We neutralize the leading "no" in those constructions before
// the guards run, preserving string length so the regex windows still
// measure correctly. Order matters: "no unicamente" before "no solo".
const CONTRASTIVE_NEGATION_RE = /\bno\s+(solo|unicamente|s[oó]lo)\b/gi;
function neutralizeContrastiveNegations(normalizedText) {
  return normalizedText.replace(
    CONTRASTIVE_NEGATION_RE,
    (match, qualifier) => `${' '.repeat(2)} ${qualifier}`,
  );
}

function applyNegationGuards(signals, normalizedText) {
  if (!normalizedText) return signals;
  const scanned = neutralizeContrastiveNegations(normalizedText);
  for (const [key, guardRe] of Object.entries(NEGATION_GUARDS)) {
    if (signals[key] && guardRe.test(scanned)) {
      signals[key] = false;
    }
  }
  return signals;
}

function buildDomainSignals(rawUserRequest, tokenAnalysis = null) {
  const n = normalizeText(rawUserRequest);
  const signals = {
    gmail: matchAny(n, [
      /\b(gmail|e-?mail|correo|correos|redacta(?:r)? un correo|envia(?:r)? un correo|lee(?:r)? mis correos)\b/i,
    ]),
    googleServices: matchAny(n, [
      /\b(google drive|drive|google calendar|calendario|calendar|evento|event|reunion|meeting|agenda|carpeta)\b/i,
    ]),
    realtimeLookup: Boolean(tokenAnalysis?.context?.has_freshness_lookup) || matchAny(n, [
      /\b(clima|tiempo actual|pron[oó]stico|temperatura|weather|forecast)\b/i,
      /\b(resultados?|marcador|score|partidos?|fixture|estad[ií]sticas?)\b.*\b(nba|nfl|mlb|nhl|f[uú]tbol|soccer|epl|champions|liga|deporte|sports?)\b/i,
      /\b(restaurantes?|hoteles?|lugares?|atracciones?|direcci[oó]n|mapa|ruta|itinerario|cerca de mi|google places)\b/i,
      /\b(?:qu[eé]|cu[aá]l|qui[eé]n|cu[aá]ndo|d[oó]nde|precio|resultado|marcador|noticias?)\b.*\b(?:hoy|ahora|actual(?:es)?|actualidad|reciente(?:s)?|[uú]ltim[oa]s?|latest|today|current|202[0-9])\b/i,
      /\b(?:hoy|ahora|actual(?:es)?|actualidad|reciente(?:s)?|[uú]ltim[oa]s?|latest|today|current)\b.*\b(?:noticias?|pas[oó]|ocurri[oó]|precio|estado|resultado|marcador|avance)\b/i,
    ]),
    math: Boolean(tokenAnalysis?.context?.has_math_work) || matchAny(n, [
      /\b(integral|derivada|ecuacion|cronbach|spearman|anova|regresion|chi cuadrado|p valor|probabilidad|matriz|autovalor|estadistica|likert|varianza|desviacion|sistema de ecuaciones|fisica|quimica)\b/i,
    ]),
    viz: Boolean(tokenAnalysis?.context?.has_visual_work) || matchAny(n, [
      /\b(grafica|grafico|chart|plot|histograma|pareto|ishikawa|boxplot|scatter|dispersion|curva s|gantt|sankey|treemap|heatmap|diagrama er|mermaid|uml|dashboard|visualizacion)\b/i,
    ]),
    artifact: matchAny(n, [
      /\b(calculadora interactiva|simulador|quiz|widget|artefacto|artifact|editor en tiempo real|visualizador interactivo|mapa interactivo|three\.?js|modelo 3d|dashboard con inputs)\b/i,
    ]),
    plan: matchAny(n, [
      /\b(plano|blueprint|floor plan|planta arquitectonica|planta baja|dxf)\b/i,
      /\b(casa|vivienda|departamento|oficina)\b.*\b(plano|planta|distribucion|habitaciones|dormitorios)\b/i,
    ]),
    figma: matchAny(n, [
      /\b(figma|wireframe|user flow|design system|prototipo navegable|diagrama de producto)\b/i,
    ]),
    webdev: Boolean(tokenAnalysis?.context?.has_web_build) || matchAny(n, [
      /\b(crea|crear|creame|haz|hazme|genera|desarrolla|programa|construye|implementa|disena|diseña)\b.*\b(web|website|pagina web|sitio web|landing|frontend|react|next\.?js|web app|tienda online|ecommerce|dashboard web|saas)\b/i,
      /\b(web|website|pagina web|sitio web|landing|frontend|react|next\.?js|web app|tienda online|ecommerce|dashboard web|saas)\b.*\b(crea|crear|haz|genera|desarrolla|programa|construye|implementa|disena|diseña)\b/i,
    ]),
    video: matchAny(n, [
      /\b(video|clip|animacion|veo3|veo 3|sora)\b/i,
    ]),
    longRunning: Boolean(tokenAnalysis?.context?.has_long_running_signal) || matchAny(n, [
      /\b(30 minutos|60 minutos|2 horas|dos horas|una hora|sin detenerse|sin parar|autonomo|autonoma|auto corrige|autocorrige|verifica y corrige|ejecuta pruebas)\b/i,
    ]),
    dataWork: Boolean(tokenAnalysis?.context?.has_data_work) || matchAny(n, [
      /\b(analiza datos|procesa datos|limpia datos|dataset|base de datos|tabla|formula|formulas|csv|registros|filas|dashboard|cronbach|spearman)\b/i,
    ]),
    codeWork: Boolean(tokenAnalysis?.context?.has_code_work) || matchAny(n, [
      /\b(codigo|código|script|api|backend|frontend|debug|bug|test|tests|lint|build|repositorio|github|despliegue|deploy)\b/i,
    ]),
    repoOperation: matchAny(n, [
      /\b(?:github\.com\/[\w.-]+\/[\w.-]+|git\s+clone|clona(?:r|me)?|clone(?:ar)?|fork|pull\s+request|pr\b|commit|push|sube(?:r)?\s+(?:a\s+)?(?:github|main)|repositorio|repo|checkout|branch|rama|main|ci\s+(?:verde|green)|actions?)\b/i,
    ]),
  };
  // Apply explicit-negation guards last so we never produce a signal
  // the user just told us not to. Only mutates already-true signals;
  // never invents new ones.
  return applyNegationGuards(signals, n);
}

function extractFileIds(files = [], conversationHistory = []) {
  const ids = new Set();
  for (const file of Array.isArray(files) ? files : []) {
    const id = file?.id || file?.fileId || file?.openaiFileId || file?.name;
    if (id) ids.add(String(id));
  }
  for (const message of Array.isArray(conversationHistory) ? conversationHistory.slice(-4) : []) {
    const messageFiles = Array.isArray(message?.files) ? message.files : [];
    for (const file of messageFiles) {
      const id = file?.id || file?.fileId || file?.openaiFileId || file?.name;
      if (id) ids.add(String(id));
    }
  }
  return Array.from(ids).slice(0, 20);
}

function requiresAgenticExecution(contract, signals) {
  const hasSources = Boolean(contract?.source_requirements?.required);
  const hasArtifact = Boolean(contract?.artifact_required);
  const hasMultiDag = Boolean(contract?.multi_intent_dag?.enabled);
  const strictSources = contract?.source_requirements?.verification_policy === 'strict';
  return Boolean(
    contract?.pipeline === 'MultiIntentPipeline'
    || hasMultiDag
    || signals.longRunning
    || signals.repoOperation
    || (hasSources && hasArtifact)
    || (hasArtifact && (signals.dataWork || signals.codeWork) && hasSources)
    || (strictSources && hasArtifact)
  );
}

function mapContractToChatIntent(contract, signals) {
  if (signals.gmail) return 'gmail';
  if (signals.googleServices) return 'google_services';
  if (signals.realtimeLookup) return 'web_search';

  if (signals.plan) return 'plan';
  if (signals.artifact) return 'artifact';
  if (signals.math && !contract?.artifact_required) return 'math';
  if (signals.viz && !contract?.artifact_required) return 'viz';
  if (signals.figma && !contract?.artifact_required) return 'figma';
  if (signals.video && contract?.pipeline !== 'ImagePipeline') return 'video';

  if (requiresAgenticExecution(contract, signals)) return 'agent_task';

  switch (contract?.pipeline) {
    case 'ImagePipeline':
      return 'image';
    case 'VisualArtifactPipeline':
      return 'doc';
    case 'DocumentPipeline':
    case 'SpreadsheetPipeline':
      return 'doc';
    case 'SlidePipeline':
      return 'ppt';
    case 'ResearchGroundingPipeline':
      return 'web_search';
    case 'RAGDocumentUnderstandingPipeline':
      return contract.artifact_required ? 'agent_task' : 'text';
    case 'ActionExecutionPipeline':
      return signals.gmail ? 'gmail' : signals.googleServices ? 'google_services' : 'agent_task';
    case 'CodePipeline':
      return signals.webdev && !signals.repoOperation ? 'webdev' : (signals.longRunning || signals.repoOperation) ? 'agent_task' : 'text';
    case 'DirectAnswerPipeline':
      if (signals.webdev) return 'webdev';
      if (signals.math) return 'math';
      if (signals.viz) return 'viz';
      return 'text';
    case 'MultiIntentPipeline':
      return 'agent_task';
    default:
      return 'text';
  }
}

function confidenceForDecision(contract, intent, toolRuntimePlan, qaBoardReview) {
  let score = 0.72;
  if (contract?.pipeline) score += 0.08;
  if (validateUniversalTaskContract(contract).ok) score += 0.08;
  if (contract?.required_extension || contract?.source_requirements?.required || contract?.pipeline !== 'DirectAnswerPipeline') score += 0.04;
  if (toolRuntimePlan?.summary?.blockerCount === 0) score += 0.03;
  if (qaBoardReview?.summary?.blockerCount === 0) score += 0.03;
  if (intent === 'text' && contract?.pipeline === 'DirectAnswerPipeline') score -= 0.04;
  return Math.max(0.01, Math.min(0.99, Number(score.toFixed(2))));
}

function finalOutputForContract(contract, intent) {
  if (contract?.required_extension) {
    return `${contract.required_extension.replace('.', '')}_file`;
  }
  if (contract?.artifact_type && contract.artifact_type !== 'text-answer') {
    return contract.artifact_type;
  }
  if (intent === 'web_search') return 'grounded_chat_answer';
  if (intent === 'webdev') return 'web_artifact';
  if (intent === 'agent_task') return 'validated_agentic_deliverable';
  return 'chat_answer';
}

function buildProductOsDecisionFromContract(contract, signals, fileIds = []) {
  const rawDecision = productIntentRouter.regexDecision(contract?.raw_user_request || '', {
    has_attachments: fileIds.length > 0,
    attachment_kinds: fileIds.map((id) => String(id).split('.').pop()).filter(Boolean).slice(0, 6),
  });

  const primary = productIntentForContract(contract, signals, rawDecision.intent_primary);
  const secondary = productSecondaryIntents(contract, rawDecision);
  const requiredAgents = productIntentRouter.AGENT_BUNDLE_BY_INTENT[primary] || rawDecision.required_agents || ['intent-compiler'];
  const requiredTools = productToolsForContract(contract, primary, rawDecision, signals);

  return {
    intent_primary: primary,
    intent_secondary: secondary,
    required_agents: requiredAgents,
    required_tools: requiredTools,
    confidence: Math.max(rawDecision.confidence || 0, productDecisionConfidence(contract, primary)),
    needs_clarification: contract?.ambiguity_score >= 0.8 || Boolean(rawDecision.needs_clarification),
    final_output: productFinalOutputForContract(contract, primary, rawDecision.final_output),
    tier: 'contract-first',
    trace: {
      source: 'UniversalTaskContract→AIProductOS',
      fallback_tier: rawDecision.tier,
      pipeline: contract?.pipeline,
    },
  };
}

function productIntentForContract(contract, signals, fallback) {
  switch (contract?.pipeline) {
    case 'DocumentPipeline':
      return 'complex_academic_document_generation';
    case 'SpreadsheetPipeline':
      return 'spreadsheet_generation';
    case 'SlidePipeline':
      return 'presentation_generation';
    case 'ResearchGroundingPipeline':
      return 'research_question';
    case 'RAGDocumentUnderstandingPipeline':
      return 'text_answer';
    case 'ImagePipeline':
      return 'image_generation';
    case 'VisualArtifactPipeline':
      return 'design_system';
    case 'CodePipeline':
      return signals?.webdev ? 'web_app_build' : 'code_generation';
    case 'ActionExecutionPipeline':
      return fallback && fallback !== 'text_answer' ? fallback : 'agent_long_running_task';
    case 'MultiIntentPipeline':
      return 'agent_long_running_task';
    case 'DirectAnswerPipeline':
      if (signals?.math) return 'math_solving';
      if (signals?.viz) return 'viz_generation';
      return fallback || 'text_answer';
    default:
      return fallback || 'text_answer';
  }
}

function productSecondaryIntents(contract, rawDecision) {
  const raw = contract?.raw_user_request || '';
  const items = [
    ...(rawDecision.intent_secondary || []),
    ...(contract?.secondary_intents || []),
  ];
  if (contract?.source_requirements?.required) items.push('scientific_research', 'multi_provider_search', 'citation_grounding');
  if (contract?.source_requirements?.doi_required || /\bdoi\b/i.test(raw)) items.push('doi_validation');
  if (contract?.citations_required) items.push('apa7_citation');
  if (contract?.required_extension === '.docx') items.push('docx_export');
  if (contract?.required_extension === '.xlsx') items.push('spreadsheet_export', 'excel_analysis');
  if (contract?.required_extension === '.pptx') items.push('slide_layout');
  if (contract?.required_extension === '.html') items.push('web_app_build');
  if (contract?.required_extension === '.svg') items.push('svg_artifact', 'format_sovereignty');
  return [...new Set(items)].slice(0, 12);
}

function productToolsForContract(contract, primary, rawDecision, signals = {}) {
  const forbidden = new Set(Array.isArray(contract?.forbidden_tools) ? contract.forbidden_tools : []);
  const textOnly = (contract?.user_constraints || []).includes('text_only:user_requested');
  if (
    textOnly
    && contract?.pipeline === 'DirectAnswerPipeline'
    && !contract?.source_requirements?.required
    && !contract?.artifact_required
    && !contract?.grounding_required
  ) {
    return ['finalize'];
  }
  const tools = [
    ...(productIntentRouter.TOOL_BUNDLE_BY_INTENT[primary] || []),
    ...(rawDecision.required_tools || []),
  ];
  if (contract?.source_requirements?.required) {
    tools.push('research.agenticBatch', 'docintel.ground', 'self_rag.answer');
  }
  if (contract?.pipeline === 'RAGDocumentUnderstandingPipeline') {
    tools.push('rag.retrieve', 'docintel.analyze', 'docintel.ground');
  }
  if (contract?.artifact_required) {
    tools.push('create_document', 'verify_artifact');
  }
  if (contract?.pipeline === 'VisualArtifactPipeline') {
    tools.push('design.tokens.build', 'wcag.contrast.check', 'create_document', 'verify_artifact');
  }
  if (signals?.repoOperation) {
    tools.push('git.clone', 'repo.inspect', 'code-review.analyze', 'test.run', 'github.actions.monitor');
  }
  return [...new Set(tools)].filter((tool) => !forbidden.has(tool));
}

function productFinalOutputForContract(contract, primary, fallback) {
  if (contract?.required_extension === '.docx') return 'word_document';
  if (contract?.required_extension === '.xlsx') return 'xlsx_document';
  if (contract?.required_extension === '.pptx') return 'pptx_document';
  if (contract?.required_extension === '.pdf') return 'pdf_document';
  if (contract?.required_extension === '.html') return primary === 'web_app_build' ? 'web_app' : 'html_artifact';
  if (contract?.required_extension === '.svg') return 'svg_artifact';
  return productIntentRouter.FINAL_OUTPUT_BY_INTENT[primary] || fallback || 'text';
}

function productDecisionConfidence(contract, primary) {
  let score = 0.68;
  if (contract?.pipeline && contract.pipeline !== 'DirectAnswerPipeline') score += 0.08;
  if (contract?.required_extension) score += 0.06;
  if (contract?.source_requirements?.required) score += 0.05;
  if (primary === 'text_answer' && contract?.pipeline === 'DirectAnswerPipeline') score -= 0.04;
  return Number(Math.min(0.98, Math.max(0.01, score)).toFixed(2));
}

function semanticPrimaryIntent(contract, structuredIntent) {
  if (structuredIntent?.intent_primary) return structuredIntent.intent_primary;
  switch (contract?.pipeline) {
    case 'DocumentPipeline':
      return contract?.citations_required || contract?.source_requirements?.required
        ? 'academic_document_generation'
        : 'document_generation';
    case 'SpreadsheetPipeline':
      return 'spreadsheet_generation';
    case 'SlidePipeline':
      return 'presentation_generation';
    case 'ResearchGroundingPipeline':
      return 'web_research';
    case 'RAGDocumentUnderstandingPipeline':
      return 'document_understanding';
    case 'CodePipeline':
      return 'code_generation';
    case 'ImagePipeline':
      return contract?.primary_intent === 'image_editing' ? 'image_editing' : 'image_generation';
    case 'VisualArtifactPipeline':
      return 'visual_artifact_generation';
    case 'ActionExecutionPipeline':
      return 'external_action';
    case 'MultiIntentPipeline':
      return 'multi_step_agentic_task';
    default:
      return contract?.primary_intent || 'direct_answer';
  }
}

function semanticSecondaryIntents(contract, structuredIntent) {
  const raw = contract?.raw_user_request || '';
  const items = [
    ...(structuredIntent?.intent_secondary || []),
    ...(contract?.secondary_intents || []),
  ];
  if (contract?.source_requirements?.required) items.push('web_research', 'source_validation');
  if (contract?.citations_required) items.push('apa7_citation');
  if (contract?.required_extension === '.docx') items.push('docx_export');
  if (contract?.required_extension === '.xlsx') items.push('excel_analysis', 'xlsx_export');
  if (contract?.required_extension === '.pptx') items.push('slide_design', 'pptx_export');
  if (contract?.required_extension === '.pdf') items.push('pdf_export');
  if (contract?.required_extension === '.csv') items.push('csv_export');
  if (contract?.required_extension === '.html') items.push('html_export');
  if (contract?.required_extension === '.svg') items.push('svg_export');
  if (/\bdoi\b/i.test(raw)) items.push('doi_validation');
  if (contract?.grounding_required && contract?.pipeline === 'RAGDocumentUnderstandingPipeline') items.push('private_document_grounding');
  return [...new Set(items)].slice(0, 16);
}

function semanticTools(contract, structuredIntent, fileIds = []) {
  const tools = new Set([
    ...(structuredIntent?.required_tools || []),
    ...(contract?.required_tools || []),
  ]);
  const forbidden = new Set(Array.isArray(contract?.forbidden_tools) ? contract.forbidden_tools : []);
  const raw = contract?.raw_user_request || '';
  const mentionsSpreadsheet = /\b(excel|xlsx|csv|hoja de c[aá]lculo|spreadsheet|tabla|dataset|base de datos)\b/i.test(raw)
    || fileIds.some((id) => /\.(xlsx|xls|csv)$/i.test(String(id)));
  const mentionsDoi = /\b(doi|apa|cita|citas|referencias|bibliograf[ií]a)\b/i.test(raw);

  if (mentionsSpreadsheet) tools.add('spreadsheet_reader');
  if (contract?.source_requirements?.required) tools.add('web_search');
  if (mentionsDoi || contract?.source_requirements?.verification_policy === 'strict') tools.add('doi_validator');
  if (contract?.citations_required) tools.add('citation_generator');
  if (contract?.required_extension === '.docx') tools.add('docx_renderer');
  if (contract?.required_extension === '.xlsx') tools.add('xlsx_renderer');
  if (contract?.required_extension === '.pptx') tools.add('pptx_renderer');
  if (contract?.required_extension === '.pdf') tools.add('pdf_renderer');
  if (contract?.required_extension === '.csv') tools.add('csv_renderer');
  if (contract?.required_extension === '.html') tools.add('html_renderer');
  if (contract?.required_extension === '.svg') tools.add('svg_renderer');
  if (contract?.artifact_required) tools.add('artifact_validator');
  if (/\b(?:github\.com\/[\w.-]+\/[\w.-]+|git\s+clone|clona(?:r|me)?|clone(?:ar)?|fork|pull\s+request|pr\b|commit|push|sube(?:r)?\s+(?:a\s+)?(?:github|main)|repositorio|repo|checkout|branch|rama|main|ci\s+(?:verde|green)|actions?)\b/i.test(raw)) {
    tools.add('git.clone');
    tools.add('repo.inspect');
    tools.add('code-review.analyze');
    tools.add('test.run');
    tools.add('github.actions.monitor');
  }
  for (const toolName of forbidden) tools.delete(toolName);
  if ((contract?.user_constraints || []).includes('text_only:user_requested')) {
    for (const toolName of [
      'create_document',
      'verify_artifact',
      'docx_renderer',
      'xlsx_renderer',
      'pptx_renderer',
      'pdf_renderer',
      'csv_renderer',
      'html_renderer',
      'svg_renderer',
      'artifact_validator',
    ]) tools.delete(toolName);
  }
  if (
    (contract?.user_constraints || []).includes('text_only:user_requested')
    && contract?.pipeline === 'DirectAnswerPipeline'
    && !contract?.source_requirements?.required
    && !contract?.artifact_required
    && !contract?.grounding_required
  ) {
    return ['finalize'];
  }
  return [...tools].slice(0, 24);
}

function semanticOutputFormat(contract, finalOutput) {
  if (contract?.required_extension) return contract.required_extension.replace(/^\./, '').toLowerCase();
  if (contract?.output_format) return String(contract.output_format).toLowerCase();
  if (finalOutput && finalOutput !== 'chat_answer') return finalOutput;
  return 'chat';
}

function semanticQualityLevel(contract) {
  const raw = contract?.raw_user_request || '';
  const academic = /\b(apa|tesis|acad[eé]mic|investigaci[oó]n|art[ií]culos?|papers?|doi|referencias|citas)\b/i.test(raw)
    || contract?.citations_required
    || contract?.source_requirements?.required;
  if (academic && contract?.artifact_required) return 'professional_academic';
  if (contract?.quality_bar?.level === 'critical') return 'critical_verified';
  if (contract?.artifact_required) return 'professional_deliverable';
  return contract?.quality_bar?.level === 'premium' ? 'premium' : 'professional';
}

function semanticUserGoal(contract, profilePrimaryIntent, outputFormat) {
  const raw = String(contract?.raw_user_request || '').trim();
  if (raw.length > 0 && raw.length <= 240) return raw;
  const formatPart = outputFormat && outputFormat !== 'chat' ? ` en formato ${outputFormat.toUpperCase()}` : '';
  const sourcePart = contract?.source_requirements?.required ? ' con fuentes verificadas' : '';
  return `Atender la solicitud de ${profilePrimaryIntent}${formatPart}${sourcePart}.`;
}

function buildSemanticProfile({ contract, structuredIntent, finalOutput, confidence, needsClarification, fileIds = [] } = {}) {
  const outputFormat = semanticOutputFormat(contract, finalOutput);
  const primaryIntent = semanticPrimaryIntent(contract, structuredIntent);
  return {
    primary_intent: primaryIntent,
    secondary_intents: semanticSecondaryIntents(contract, structuredIntent),
    user_goal: semanticUserGoal(contract, primaryIntent, outputFormat),
    required_tools: semanticTools(contract, structuredIntent, fileIds),
    output_format: outputFormat,
    language: contract?.detected_language || 'unknown',
    quality_level: semanticQualityLevel(contract),
    confidence: Number(Math.max(0.01, Math.min(0.99, confidence || structuredIntent?.confidence || 0.72)).toFixed(2)),
    needs_clarification: Boolean(needsClarification || structuredIntent?.needs_clarification),
  };
}

function buildModelRouting(productOsDecision, skillPlan) {
  const profile = skillPlan?.model_profile || {};
  const request = {
    ...productModelRouter.reqFromDecision(productOsDecision, {
      max_cost: profile.max_cost || 'medium',
      latency: profile.latency || 'normal',
      language: 'es',
      user_plan: 'ENTERPRISE',
    }),
    complexity: profile.complexity || productModelRouter.reqFromDecision(productOsDecision).complexity,
    requires_reasoning: Boolean(profile.requires_reasoning || productOsDecision.intent_primary !== 'small_talk'),
    requires_tools: Boolean(profile.requires_tools || (productOsDecision.required_tools || []).length > 0),
    requires_long_context: Boolean(profile.requires_long_context),
    requires_vision: Boolean(profile.requires_vision || productOsDecision.intent_primary === 'image_generation'),
    requires_code: Boolean(profile.requires_code || ['code_generation', 'web_app_build'].includes(productOsDecision.intent_primary)),
    requires_structured_outputs: true,
  };
  return {
    request,
    selection: productModelRouter.select(request),
  };
}

function buildSemanticIntentAnalysis({
  rawUserRequest,
  conversationHistory = [],
  files = [],
  userId = null,
  chatId = null,
} = {}) {
  const prompt = String(rawUserRequest || '').trim();
  const traceId = `trace_${crypto.createHash('sha256').update(`${prompt}:${Date.now()}`).digest('hex').slice(0, 16)}`;
  const fileIds = extractFileIds(files, conversationHistory);
  const tokenIntelligence = analyzeRequestTokens({
    rawUserRequest: prompt,
    fileIds,
    conversationHistory,
  });
  const intentAttributionGraph = buildUserIntentAttributionGraph({
    history: conversationHistory,
    currentPrompt: prompt,
    files,
  });
  const contract = buildUniversalTaskContract({
    rawUserRequest: prompt,
    fileIds,
    tokenAnalysis: tokenIntelligence,
  });
  const graph = buildEnterpriseExecutionGraph({
    contract,
    taskId: `intent-${traceId}`,
    userId,
    chatId,
  });
  const toolRuntimePlan = buildToolRuntimePlan({ contract, graph });
  const qaBoardReview = buildAgenticQaBoardReview({
    contract,
    graph,
    toolRuntimePlan,
    phase: 'preflight',
  });
  const operatingCore = buildAgenticOperatingCore({
    contract,
    graph,
    toolRuntimePlan,
    qaBoardReview,
  });
  const runtimeProfile = buildEnterpriseRuntimeProfile(contract, graph);
  const signals = buildDomainSignals(prompt, tokenIntelligence);
  const documentUnderstandingOverride = shouldAnswerFromExistingDocument(prompt)
    || Boolean(tokenIntelligence.context?.asks_existing_document_question);
  const intent = documentUnderstandingOverride ? 'text' : mapContractToChatIntent(contract, signals);
  const finalOutput = documentUnderstandingOverride ? 'chat_answer' : finalOutputForContract(contract, intent);
  const productOsDecision = buildProductOsDecisionFromContract(contract, signals, fileIds);
  const skillPlan = productSkillSystem.buildSkillExecutionPlan(productOsDecision, { userPlan: 'ENTERPRISE' });
  const enrichedProductOsDecision = productSkillSystem.mergeDecisionWithSkillPlan(productOsDecision, skillPlan);
  const productOsPlan = productPlanner.buildAndValidate(enrichedProductOsDecision, {
    contract_id: graph.graph_id,
  });
  const modelRouting = buildModelRouting(enrichedProductOsDecision, skillPlan);
  const confidence = confidenceForDecision(contract, intent, toolRuntimePlan, qaBoardReview);
  const needsClarification = contract.ambiguity_score >= 0.8;
  const semanticProfile = buildSemanticProfile({
    contract,
    structuredIntent: enrichedProductOsDecision,
    finalOutput,
    confidence,
    needsClarification,
    fileIds,
  });
  const ciraTaskEnvelope = buildCiraCognitiveTaskEnvelope({
    rawUserRequest: prompt,
    conversationHistory,
    files,
    userId,
    chatId,
    contract,
    graph,
    toolRuntimePlan,
    qaBoardReview,
    semanticProfile,
    structuredIntent: enrichedProductOsDecision,
    modelRouting,
  });
  const ciraTaskEnvelopeValidation = validateCiraCognitiveTaskEnvelope(ciraTaskEnvelope);

  if (!VALID_CHAT_INTENTS.has(intent)) {
    throw new Error(`Semantic router produced invalid chat intent: ${intent}`);
  }

  return {
    ok: true,
    trace_id: traceId,
    intent,
    confidence,
    needs_clarification: needsClarification,
    final_output: finalOutput,
    contract,
    execution_graph: graph,
    tool_runtime_plan: toolRuntimePlan,
    qa_board: qaBoardReview,
    operating_core: operatingCore,
    runtime_profile: runtimeProfile,
    semantic_profile: semanticProfile,
    intent_attribution_graph: intentAttributionGraph,
    request_intelligence: {
      version: tokenIntelligence.version,
      token_count: tokenIntelligence.token_count,
      primary_intent: tokenIntelligence.primary_intent,
      pipeline: tokenIntelligence.pipeline,
      confidence: tokenIntelligence.confidence,
      ambiguity_score: tokenIntelligence.ambiguity_score,
      requested_formats: tokenIntelligence.requested_formats,
      excluded_formats: tokenIntelligence.excluded_formats,
      top_intent_scores: tokenIntelligence.intent_scores.slice(0, 5),
      context: tokenIntelligence.context,
    },
    cira_task_envelope: ciraTaskEnvelope,
    cira_task_envelope_validation: ciraTaskEnvelopeValidation,
    intent_frame: ciraTaskEnvelope.frames.intent_frame,
    plan_frame: ciraTaskEnvelope.frames.plan_frame,
    tool_call_frame: ciraTaskEnvelope.frames.tool_call_frame,
    artifact_frame: ciraTaskEnvelope.frames.artifact_frame,
    validation_frame: ciraTaskEnvelope.frames.validation_frame,
    structured_intent: enrichedProductOsDecision,
    skill_plan: skillPlan,
    model_routing: modelRouting,
    product_os_plan: productOsPlan.plan,
    product_os_plan_validation: productOsPlan.validation,
    routing: {
      source: 'UniversalTaskContract+ExecutionGraph',
      pipeline: contract.pipeline,
      primary_intent: contract.primary_intent,
      secondary_intents: contract.secondary_intents,
      required_agents: contract.execution_plan.map((step) => step.agent_role),
      required_tools: contract.required_tools,
      domain_signals: signals,
      token_intelligence: {
        version: tokenIntelligence.version,
        primary_intent: tokenIntelligence.primary_intent,
        pipeline: tokenIntelligence.pipeline,
        confidence: tokenIntelligence.confidence,
        token_count: tokenIntelligence.token_count,
        requested_formats: tokenIntelligence.requested_formats.map((format) => format.extension),
        top_scores: tokenIntelligence.intent_scores.slice(0, 3),
      },
      release_decision: qaBoardReview.summary?.decision || 'unknown',
      validation_gate_count: contract.validation_plan.length,
      graph_node_count: graph.nodes.length,
      graph_edge_count: graph.edges.length,
      intent_attribution_node_count: intentAttributionGraph.node_count,
      intent_attribution_edge_count: intentAttributionGraph.edge_count,
      product_os_intent: enrichedProductOsDecision.intent_primary,
      selected_model: modelRouting.selection?.model?.id || null,
      selected_skills: skillPlan.selected_skills.map((skill) => skill.id),
      product_os_plan_node_count: productOsPlan.plan.nodes.length,
      cira_envelope_version: ciraTaskEnvelope.schema_version,
      cira_primary_intent: ciraTaskEnvelope.intent_analysis.primary_intent.id,
      cira_artifact_count: ciraTaskEnvelope.frames.artifact_frame.artifacts.length,
    },
  };
}

module.exports = {
  VALID_CHAT_INTENTS,
  buildSemanticIntentAnalysis,
  INTERNAL: {
    buildDomainSignals,
    applyNegationGuards,
    NEGATION_GUARDS,
    mapContractToChatIntent,
    requiresAgenticExecution,
    finalOutputForContract,
    buildProductOsDecisionFromContract,
    buildSemanticProfile,
    buildModelRouting,
    shouldAnswerFromExistingDocument,
    analyzeRequestTokens,
  },
};

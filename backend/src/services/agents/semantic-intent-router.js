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
const productModelRouter = require('../ai-product-os/model-router');
const productSkillSystem = require('../ai-product-os/skill-system');
const productPlanner = require('../ai-product-os/planner-agent');
const productIntentRouter = require('../ai-product-os/semantic-intent-router');

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

function buildDomainSignals(rawUserRequest) {
  const n = normalizeText(rawUserRequest);
  return {
    gmail: matchAny(n, [
      /\b(gmail|e-?mail|correo|correos|redacta(?:r)? un correo|envia(?:r)? un correo|lee(?:r)? mis correos)\b/i,
    ]),
    googleServices: matchAny(n, [
      /\b(google drive|drive|google calendar|calendario|calendar|evento|event|reunion|meeting|agenda|carpeta)\b/i,
    ]),
    math: matchAny(n, [
      /\b(integral|derivada|ecuacion|cronbach|spearman|anova|regresion|chi cuadrado|p valor|probabilidad|matriz|autovalor|estadistica|likert|varianza|desviacion|sistema de ecuaciones|fisica|quimica)\b/i,
    ]),
    viz: matchAny(n, [
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
    webdev: matchAny(n, [
      /\b(crea|crear|creame|haz|hazme|genera|desarrolla|programa|construye|implementa|disena|diseña)\b.*\b(web|website|pagina web|sitio web|landing|frontend|react|next\.?js|web app|tienda online|ecommerce|dashboard web|saas)\b/i,
      /\b(web|website|pagina web|sitio web|landing|frontend|react|next\.?js|web app|tienda online|ecommerce|dashboard web|saas)\b.*\b(crea|crear|haz|genera|desarrolla|programa|construye|implementa|disena|diseña)\b/i,
    ]),
    video: matchAny(n, [
      /\b(video|clip|animacion|veo3|veo 3|sora)\b/i,
    ]),
    longRunning: matchAny(n, [
      /\b(30 minutos|60 minutos|2 horas|dos horas|una hora|sin detenerse|sin parar|autonomo|autonoma|auto corrige|autocorrige|verifica y corrige|ejecuta pruebas)\b/i,
    ]),
    dataWork: matchAny(n, [
      /\b(analiza datos|procesa datos|limpia datos|dataset|base de datos|tabla|formula|formulas|csv|registros|filas|dashboard|cronbach|spearman)\b/i,
    ]),
    codeWork: matchAny(n, [
      /\b(codigo|código|script|api|backend|frontend|debug|bug|test|tests|lint|build|repositorio|github|despliegue|deploy)\b/i,
    ]),
  };
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
    || (hasSources && hasArtifact)
    || (hasArtifact && (signals.dataWork || signals.codeWork) && hasSources)
    || (strictSources && hasArtifact)
  );
}

function mapContractToChatIntent(contract, signals) {
  if (signals.gmail) return 'gmail';
  if (signals.googleServices) return 'google_services';

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
      return signals.webdev ? 'webdev' : signals.longRunning ? 'agent_task' : 'text';
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
  const requiredTools = productToolsForContract(contract, primary, rawDecision);

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
  const items = [
    ...(rawDecision.intent_secondary || []),
    ...(contract?.secondary_intents || []),
  ];
  if (contract?.source_requirements?.required) items.push('scientific_research', 'multi_provider_search', 'citation_grounding');
  if (contract?.source_requirements?.doi_required) items.push('doi_validation');
  if (contract?.citations_required) items.push('apa7_citation');
  if (contract?.required_extension === '.docx') items.push('docx_export');
  if (contract?.required_extension === '.xlsx') items.push('spreadsheet_export', 'excel_analysis');
  if (contract?.required_extension === '.pptx') items.push('slide_layout');
  if (contract?.required_extension === '.html') items.push('web_app_build');
  if (contract?.required_extension === '.svg') items.push('svg_artifact', 'format_sovereignty');
  return [...new Set(items)].slice(0, 12);
}

function productToolsForContract(contract, primary, rawDecision) {
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
  return [...new Set(tools)];
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
  const contract = buildUniversalTaskContract({
    rawUserRequest: prompt,
    fileIds,
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
  const signals = buildDomainSignals(prompt);
  const intent = mapContractToChatIntent(contract, signals);
  const productOsDecision = buildProductOsDecisionFromContract(contract, signals, fileIds);
  const skillPlan = productSkillSystem.buildSkillExecutionPlan(productOsDecision, { userPlan: 'ENTERPRISE' });
  const enrichedProductOsDecision = productSkillSystem.mergeDecisionWithSkillPlan(productOsDecision, skillPlan);
  const productOsPlan = productPlanner.buildAndValidate(enrichedProductOsDecision, {
    contract_id: graph.graph_id,
  });
  const modelRouting = buildModelRouting(enrichedProductOsDecision, skillPlan);
  const confidence = confidenceForDecision(contract, intent, toolRuntimePlan, qaBoardReview);
  const needsClarification = contract.ambiguity_score >= 0.8;

  if (!VALID_CHAT_INTENTS.has(intent)) {
    throw new Error(`Semantic router produced invalid chat intent: ${intent}`);
  }

  return {
    ok: true,
    trace_id: traceId,
    intent,
    confidence,
    needs_clarification: needsClarification,
    final_output: finalOutputForContract(contract, intent),
    contract,
    execution_graph: graph,
    tool_runtime_plan: toolRuntimePlan,
    qa_board: qaBoardReview,
    operating_core: operatingCore,
    runtime_profile: runtimeProfile,
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
      release_decision: qaBoardReview.summary?.decision || 'unknown',
      validation_gate_count: contract.validation_plan.length,
      graph_node_count: graph.nodes.length,
      graph_edge_count: graph.edges.length,
      product_os_intent: enrichedProductOsDecision.intent_primary,
      selected_model: modelRouting.selection?.model?.id || null,
      selected_skills: skillPlan.selected_skills.map((skill) => skill.id),
      product_os_plan_node_count: productOsPlan.plan.nodes.length,
    },
  };
}

module.exports = {
  VALID_CHAT_INTENTS,
  buildSemanticIntentAnalysis,
  INTERNAL: {
    buildDomainSignals,
    mapContractToChatIntent,
    requiresAgenticExecution,
    finalOutputForContract,
    buildProductOsDecisionFromContract,
    buildModelRouting,
  },
};

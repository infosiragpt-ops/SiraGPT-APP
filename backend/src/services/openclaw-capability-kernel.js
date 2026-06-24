'use strict';

const executionDossier = require('./openclaw-execution-dossier');

const DEFAULT_TOOL_NAMES = Object.freeze([
  'web_search',
  'read_url',
  'web_extract',
  'session_search',
  'session_list',
  'session_history',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'memory_recall',
  'rag_retrieve',
  'self_rag_answer',
  'docintel_analyze',
  'docintel_retrieve',
  'docintel_extract_tables',
  'docintel_compare',
  'deep_analyze',
  'auto_file',
  'compare_documents',
  'python_exec',
  'bash_exec',
  'create_document',
  'verify_artifact',
  'run_tests',
]);

const HIGH_RISK_PATTERNS = [
  /\b(enviar|manda|publica|postea|borra|elimina|destruye|compra|paga|transfiere|cancela)\b/i,
  /\b(send|publish|post|delete|destroy|buy|pay|transfer|cancel)\b/i,
];

const IMAGE_PATTERNS = [
  /\b(imagen|foto|captura|screenshot|visual|adjunto|archivo|pdf|documento|tabla|excel)\b/i,
  /\b(image|photo|screenshot|attachment|file|document|spreadsheet)\b/i,
];

const AUTONOMOUS_AGENT_PATTERNS = [
  /\b(agente(?:s)?\s+aut[oó]nom[oa]s?|autonomous\s+agent|software\s+(?:muy\s+)?potente|sofware\s+(?:muy\s+)?potente|auto.?ejecut(?:a|able|or)|trabaja\s+(?:de\s+manera\s+)?aut[oó]noma)\b/i,
  /\b(fusiona(?:r)?|fusi[oó]n|fusi[oó]nalo|integr[aá]lo)\b.{0,80}\b(openclaw|github\.com\/openclaw\/openclaw|software|sofware|agente)\b/i,
];

const MASSIVE_SOURCE_FUSION_PATTERNS = [
  /\b(millones|millions|miles|thousands|much[ií]simas?)\b.{0,80}\b(l[ií]neas?|lines?|c[oó]digo|code|archivos?|files?)\b/i,
  /\b(copiar|copia(?:r)?|copy)\b.{0,100}\b(millones|millions|miles|thousands|repositorio|repo|openclaw)\b/i,
  /\b(merge|fusiona(?:r)?|fusi[oó]n|fusi[oó]nalo)\b.{0,100}\b(millones|millions|miles|thousands|repositorio|repo|openclaw|c[oó]digo|code)\b/i,
  /\b(c[oó]digo|code)\b.{0,80}\b(copiar\s+y\s+fusionar|copy\s+and\s+merge|fusionar(?:lo)?)\b/i,
];

const REPAIR_PATTERNS = [
  /\b(no entiende|no entend(i|í)|mal|error|terrible|regenera|regenerar|corrige|corrígelo|no era|equivoc)\b/i,
  /\b(wrong|misunderstood|regenerate|retry|fix|not what i meant)\b/i,
];

const EXTERNAL_REPO_PATTERNS = [
  /\b(openclaw|github\.com\/openclaw\/openclaw|upstream|external repo|repo externo|repositorio externo|otro repositorio|del otro software|ese repositorio|este repositorio)\b/i,
  /\b(github\.com\/[\w.-]+\/[\w.-]+)\b.{0,80}\b(integra|integrar|refactoriza|reescribe|reescribir|adapta|adaptar)\b/i,
  /\b(integra|integrar|refactoriza|reescribe|reescribir|adapta|adaptar)\b.{0,80}\b(github\.com\/[\w.-]+\/[\w.-]+|upstream|external repo|repo externo|repositorio externo|otro repositorio)\b/i,
];

const NO_COPY_PATTERNS = [
  /\b(no\s+cop(?:ies|iar|ie|iarlo)|sin\s+copiar)\b.{0,60}\b(c[oó]digo|repo|repositorio|openclaw|upstream)\b/i,
  /\b(c[oó]digo|repo|repositorio|openclaw|upstream)\b.{0,60}\b(no\s+cop(?:ies|iar|ie|iarlo)|sin\s+copiar)\b/i,
];

const NATIVE_REWRITE_PATTERNS = [
  /\b(reescrib(?:e|ir|as|irlo|elo|elo todo)|rewrite(?:\s+not\s+copy)?|refactoriza|implementa(?:r)?\s+(?:nuestro|propio)|c[oó]digo\s+propio)\b/i,
];

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return DEFAULT_TOOL_NAMES.slice();
  const names = tools
    .map((tool) => (typeof tool === 'string' ? tool : tool && tool.name))
    .filter(Boolean)
    .map(String);
  return [...new Set(names.length ? names : DEFAULT_TOOL_NAMES)];
}

function classifyRequest(text, opts = {}) {
  const prompt = String(text || '');
  const hasAttachments = Number(opts.attachmentCount || 0) > 0;
  const wantsRepair = REPAIR_PATTERNS.some((rx) => rx.test(prompt));
  const referencesVisualContext = hasAttachments || IMAGE_PATTERNS.some((rx) => rx.test(prompt));
  const highRisk = HIGH_RISK_PATTERNS.some((rx) => rx.test(prompt));
  const externalRepoAdaptation = EXTERNAL_REPO_PATTERNS.some((rx) => rx.test(prompt));
  const wantsAutonomousAgent = AUTONOMOUS_AGENT_PATTERNS.some((rx) => rx.test(prompt));
  const massiveSourceFusion = MASSIVE_SOURCE_FUSION_PATTERNS.some((rx) => rx.test(prompt));
  const nativeRewriteRequired = NO_COPY_PATTERNS.some((rx) => rx.test(prompt))
    || massiveSourceFusion
    || (externalRepoAdaptation && NATIVE_REWRITE_PATTERNS.some((rx) => rx.test(prompt)));
  const likelyLongRunning = externalRepoAdaptation
    || nativeRewriteRequired
    || wantsAutonomousAgent
    || massiveSourceFusion
    || /\b(repo|github|deploy|desplieg|commit|push|pr|proyecto|tesis|app|web|investiga|paper|reporte|ppt|excel|word|pdf)\b/i.test(prompt);

  return {
    wantsRepair,
    referencesVisualContext,
    externalRepoAdaptation,
    wantsAutonomousAgent,
    massiveSourceFusion,
    nativeRewriteRequired,
    highRisk,
    likelyLongRunning,
    shouldPreferAgentic: !referencesVisualContext && (wantsRepair || likelyLongRunning || externalRepoAdaptation || nativeRewriteRequired),
    trustBoundary: hasAttachments ? 'mixed_user_and_attachment_context' : 'user_chat_context',
  };
}

function buildCapabilityProfile({
  prompt = '',
  userId = null,
  chatId = null,
  attachmentCount = 0,
  toolNames = DEFAULT_TOOL_NAMES,
  memoryFacts = [],
  recentTurnCount = 0,
  model = null,
  provider = null,
  context = {},
} = {}) {
  const tools = normalizeTools(toolNames);
  const classification = classifyRequest(prompt, { attachmentCount });

  const profile = {
    version: 'openclaw-capability-kernel-2026-05',
    userId: userId || null,
    chatId: chatId || null,
    model: model || null,
    provider: provider || null,
    trustBoundary: classification.trustBoundary,
    signals: {
      wantsRepair: classification.wantsRepair,
      referencesVisualContext: classification.referencesVisualContext,
      highRisk: classification.highRisk,
      likelyLongRunning: classification.likelyLongRunning,
      externalRepoAdaptation: classification.externalRepoAdaptation,
      wantsAutonomousAgent: classification.wantsAutonomousAgent,
      massiveSourceFusion: classification.massiveSourceFusion,
      nativeRewriteRequired: classification.nativeRewriteRequired,
      recentTurnCount: Number(recentTurnCount || 0),
      attachmentCount: Number(attachmentCount || 0),
      memoryFactCount: Array.isArray(memoryFacts) ? memoryFacts.length : 0,
    },
    capabilities: {
      persistentMemory: true,
      sessionContinuity: true,
      toolUse: tools.length > 0,
      evidenceLedger: true,
      attachmentGrounding: classification.referencesVisualContext,
      selfRepair: true,
      taskPlanning: true,
      safeExternalActions: true,
      nativeRepoAdaptation: classification.externalRepoAdaptation || classification.nativeRewriteRequired,
      autonomousExecution: classification.wantsAutonomousAgent || classification.likelyLongRunning,
      bulkSourceFusion: classification.massiveSourceFusion,
    },
    tools,
    routing: {
      shouldPreferAgentic: classification.shouldPreferAgentic,
      plainVisionFallback: classification.referencesVisualContext,
      reason: classification.referencesVisualContext
        ? 'vision_or_attachment_turn_requires_multimodal_grounding'
        : (classification.shouldPreferAgentic ? 'repair_long_running_or_autonomous_work_benefits_from_tools' : 'standard_chat_with_openclaw_policy'),
    },
  };

  profile.executionDossier = executionDossier.buildExecutionDossier({
    prompt,
    profile,
    context,
    toolNames: tools,
  });

  return profile;
}

function buildOpenClawPromptBlock(profile) {
  if (!profile || typeof profile !== 'object') return '';
  const toolList = normalizeTools(profile.tools).slice(0, 24).join(', ');
  const signals = profile.signals || {};
  const nativeAdaptationBlock = signals.externalRepoAdaptation || signals.nativeRewriteRequired
    ? [
      '',
      '### Native Adaptation Contract',
      '- Treat external repositories as reference material only. Extract capability intent, risks, workflows, and verification patterns; do not copy active code or foreign folder structure into SiraGPT runtime.',
      '- Rewrite behavior inside SiraGPT-native modules, services, skills, scripts, and tests. Keep upstream snapshots inactive and attributed when they are needed for audit.',
      '- Before finishing, prove the adaptation with an integration map, focused tests, and a no-verbatim-runtime-import boundary check.',
    ].join('\n')
    : '';
  const bulkFusionBlock = signals.massiveSourceFusion
    ? [
      '',
      '### Bulk Source Fusion Contract',
      '- Treat requests for millions of lines or broad copy/merge as a staged source-ingestion program, not as a raw paste into active runtime.',
      '- First inventory folders, licenses, capabilities, dependency boundaries, side effects, and test surfaces. Preserve MIT attribution for any copied reference material.',
      '- Activate only the smallest verified SiraGPT-native slices behind existing backend/agent contracts. Keep unrelated upstream UI, release, credentials, and maintainer-specific code inactive.',
      '- Require an integration map, deterministic tests, and a rollback-aware checkpoint before claiming that any bulk-fusion capability is live.',
    ].join('\n')
    : '';

  return [
    '## OpenClaw-Level Runtime Policy',
    'Act as a capable personal agent, not as a single-turn chatbot. Every response must preserve session continuity, use available context, and recover from misunderstandings.',
    '',
    '### Context Contract',
    `- Trust boundary: ${profile.trustBoundary || 'user_chat_context'}. Treat user text, chat history, attachments, tool outputs, and memory as separate evidence channels.`,
    '- Never merge uncertain visual/document details with assumptions. If an image or file is present, ground the answer in visible or extracted evidence and say when something is not visible.',
    '- Resolve short follow-ups like "eso", "igual", "regenera", "no entiende", "corrige" against the recent thread before answering.',
    '- Keep a small internal evidence ledger: claim -> source channel -> confidence. Do not reveal the ledger unless useful, but use it to avoid invented details.',
    '',
    '### Capability Contract',
    '- Prefer tools when they materially improve correctness: search for current facts, read sources, recall memory, inspect documents, run deterministic checks, create/verify artifacts, and run tests.',
    `- Available tool families: ${toolList || 'none declared'}.`,
    '- For multi-step work, create a plan, execute the next concrete step, verify, then report what actually happened. Do not claim work was completed if no tool or deterministic step did it.',
    signals.wantsAutonomousAgent ? '- For autonomous-agent software requests, maintain a durable loop: map capabilities, implement through native runtime contracts, verify with tests, then continue only from observed state.' : '',
    '- For files, images, PDFs, spreadsheets, or screenshots: analyze the artifact first, then answer. If a tool cannot inspect it, say the limitation instead of guessing.',
    '- For code or app changes: inspect the repo, edit scoped files, run type-check/tests/build when available, and surface any failing command exactly.',
    '',
    '### Repair Contract',
    '- If the user says the previous answer was wrong, treat it as a repair turn: identify the mismatch, reuse the original request and attachments, produce a corrected answer, and preserve a tiny regeneration count if the UI provides one.',
    '- Ask at most one clarifying question only when the missing information blocks execution; otherwise make the safest professional assumption and continue.',
    '- High-risk external actions such as sending, posting, deleting, paying, deploying, or irreversible changes require explicit confirmation.',
    nativeAdaptationBlock,
    bulkFusionBlock,
    '',
    '### Runtime Signals',
    `- wantsRepair=${Boolean(signals.wantsRepair)} referencesVisualContext=${Boolean(signals.referencesVisualContext)} externalRepoAdaptation=${Boolean(signals.externalRepoAdaptation)} wantsAutonomousAgent=${Boolean(signals.wantsAutonomousAgent)} massiveSourceFusion=${Boolean(signals.massiveSourceFusion)} nativeRewriteRequired=${Boolean(signals.nativeRewriteRequired)} highRisk=${Boolean(signals.highRisk)} likelyLongRunning=${Boolean(signals.likelyLongRunning)}`,
    `- recentTurnCount=${signals.recentTurnCount || 0} attachmentCount=${signals.attachmentCount || 0} memoryFactCount=${signals.memoryFactCount || 0}`,
    '',
    executionDossier.buildDossierPromptBlock(profile.executionDossier),
  ].join('\n');
}

function buildOpenClawRuntimeSummary(profile) {
  if (!profile || typeof profile !== 'object') return null;
  if (!profile.executionDossier && Array.isArray(profile.qualityGates) && profile.signals && profile.capabilities) {
    return {
      version: profile.version || 'openclaw-capability-kernel',
      trustBoundary: profile.trustBoundary || 'user_chat_context',
      routingReason: profile.routingReason || profile.routing?.reason || null,
      operatingMode: profile.operatingMode || null,
      signals: {
        externalRepoAdaptation: Boolean(profile.signals.externalRepoAdaptation),
        wantsAutonomousAgent: Boolean(profile.signals.wantsAutonomousAgent),
        massiveSourceFusion: Boolean(profile.signals.massiveSourceFusion),
        nativeRewriteRequired: Boolean(profile.signals.nativeRewriteRequired),
        likelyLongRunning: Boolean(profile.signals.likelyLongRunning),
        highRisk: Boolean(profile.signals.highRisk),
        attachmentCount: Number(profile.signals.attachmentCount || 0),
      },
      capabilities: {
        nativeRepoAdaptation: Boolean(profile.capabilities.nativeRepoAdaptation),
        autonomousExecution: Boolean(profile.capabilities.autonomousExecution),
        taskPlanning: Boolean(profile.capabilities.taskPlanning),
        safeExternalActions: Boolean(profile.capabilities.safeExternalActions),
        evidenceLedger: Boolean(profile.capabilities.evidenceLedger),
        bulkSourceFusion: Boolean(profile.capabilities.bulkSourceFusion),
      },
      qualityGates: profile.qualityGates.map(String).filter(Boolean).slice(0, 12),
      workPackets: (Array.isArray(profile.workPackets) ? profile.workPackets : []).slice(0, 8),
      riskControls: (Array.isArray(profile.riskControls) ? profile.riskControls : []).map(String).filter(Boolean).slice(0, 8),
    };
  }
  const signals = profile.signals || {};
  const capabilities = profile.capabilities || {};
  const dossier = profile.executionDossier || {};
  const operatingMode = dossier.operatingMode || {};
  const workPackets = Array.isArray(dossier.workPackets) ? dossier.workPackets : [];
  const qualityGates = Array.isArray(dossier.qualityGates) ? dossier.qualityGates : [];
  const riskControls = Array.isArray(dossier.riskControls) ? dossier.riskControls : [];

  return {
    version: profile.version || 'openclaw-capability-kernel',
    trustBoundary: profile.trustBoundary || 'user_chat_context',
    routingReason: profile.routing?.reason || null,
    operatingMode: operatingMode.primary || null,
    signals: {
      externalRepoAdaptation: Boolean(signals.externalRepoAdaptation),
      wantsAutonomousAgent: Boolean(signals.wantsAutonomousAgent),
      massiveSourceFusion: Boolean(signals.massiveSourceFusion),
      nativeRewriteRequired: Boolean(signals.nativeRewriteRequired),
      likelyLongRunning: Boolean(signals.likelyLongRunning),
      highRisk: Boolean(signals.highRisk),
      attachmentCount: Number(signals.attachmentCount || 0),
    },
    capabilities: {
      nativeRepoAdaptation: Boolean(capabilities.nativeRepoAdaptation),
      autonomousExecution: Boolean(capabilities.autonomousExecution),
      taskPlanning: Boolean(capabilities.taskPlanning),
      safeExternalActions: Boolean(capabilities.safeExternalActions),
      evidenceLedger: Boolean(capabilities.evidenceLedger),
      bulkSourceFusion: Boolean(capabilities.bulkSourceFusion),
    },
    qualityGates: qualityGates.map(String).filter(Boolean).slice(0, 12),
    workPackets: workPackets
      .map((packet, index) => ({
        id: packet.id || `packet_${index + 1}`,
        label: packet.label || packet.name || packet.id || `Work packet ${index + 1}`,
        required: packet.required !== false,
      }))
      .slice(0, 8),
    riskControls: riskControls
      .map((control) => control?.risk || control?.id || control?.label || control)
      .map(String)
      .filter(Boolean)
      .slice(0, 8),
  };
}

function buildOpenClawRuntimeEvents(profile) {
  const summary = buildOpenClawRuntimeSummary(profile);
  if (!summary) return [];
  const signals = summary.signals || {};
  const active = signals.externalRepoAdaptation
    || signals.wantsAutonomousAgent
    || signals.massiveSourceFusion
    || signals.nativeRewriteRequired
    || Boolean(summary.capabilities?.nativeRepoAdaptation);
  if (!active) return [];

  return [
    {
      type: 'checkpoint',
      id: 'openclaw-runtime-profile',
      label: 'Perfil OpenClaw autónomo listo',
      status: 'saved',
      payload: summary,
    },
    {
      type: 'quality_gate',
      id: 'openclaw-native-fusion',
      gate: 'openclaw_native_fusion',
      label: 'Fusión OpenClaw nativa',
      passed: Boolean(
        signals.externalRepoAdaptation
        && (signals.wantsAutonomousAgent || signals.massiveSourceFusion)
        && summary.qualityGates.includes('autonomous_plan_execute_verify_loop')
      ),
      summary: [
        `referenceOnly=${Boolean(signals.externalRepoAdaptation)}`,
        `autonomous=${Boolean(signals.wantsAutonomousAgent)}`,
        `bulkFusion=${Boolean(signals.massiveSourceFusion)}`,
        `nativeRewrite=${Boolean(signals.nativeRewriteRequired)}`,
        `mode=${summary.operatingMode || 'unknown'}`,
      ].join(' '),
      payload: summary,
    },
  ];
}

module.exports = {
  DEFAULT_TOOL_NAMES,
  buildCapabilityProfile,
  buildOpenClawPromptBlock,
  buildOpenClawRuntimeEvents,
  buildOpenClawRuntimeSummary,
  buildExecutionDossier: executionDossier.buildExecutionDossier,
  buildDossierPromptBlock: executionDossier.buildDossierPromptBlock,
  classifyRequest,
  normalizeTools,
};

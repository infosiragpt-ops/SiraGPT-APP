'use strict';

const DEFAULT_TOOL_NAMES = Object.freeze([
  'web_search',
  'read_url',
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

const REPAIR_PATTERNS = [
  /\b(no entiende|no entend(i|í)|mal|error|terrible|regenera|regenerar|corrige|corrígelo|no era|equivoc)\b/i,
  /\b(wrong|misunderstood|regenerate|retry|fix|not what i meant)\b/i,
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
  const likelyLongRunning = /\b(repo|github|deploy|desplieg|commit|push|pr|proyecto|tesis|app|web|investiga|paper|reporte|ppt|excel|word|pdf)\b/i.test(prompt);

  return {
    wantsRepair,
    referencesVisualContext,
    highRisk,
    likelyLongRunning,
    shouldPreferAgentic: !referencesVisualContext && (wantsRepair || likelyLongRunning),
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
} = {}) {
  const tools = normalizeTools(toolNames);
  const classification = classifyRequest(prompt, { attachmentCount });

  return {
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
    },
    tools,
    routing: {
      shouldPreferAgentic: classification.shouldPreferAgentic,
      plainVisionFallback: classification.referencesVisualContext,
      reason: classification.referencesVisualContext
        ? 'vision_or_attachment_turn_requires_multimodal_grounding'
        : (classification.shouldPreferAgentic ? 'repair_or_long_running_work_benefits_from_tools' : 'standard_chat_with_openclaw_policy'),
    },
  };
}

function buildOpenClawPromptBlock(profile) {
  if (!profile || typeof profile !== 'object') return '';
  const toolList = normalizeTools(profile.tools).slice(0, 24).join(', ');
  const signals = profile.signals || {};

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
    '- For files, images, PDFs, spreadsheets, or screenshots: analyze the artifact first, then answer. If a tool cannot inspect it, say the limitation instead of guessing.',
    '- For code or app changes: inspect the repo, edit scoped files, run type-check/tests/build when available, and surface any failing command exactly.',
    '',
    '### Repair Contract',
    '- If the user says the previous answer was wrong, treat it as a repair turn: identify the mismatch, reuse the original request and attachments, produce a corrected answer, and preserve a tiny regeneration count if the UI provides one.',
    '- Ask at most one clarifying question only when the missing information blocks execution; otherwise make the safest professional assumption and continue.',
    '- High-risk external actions such as sending, posting, deleting, paying, deploying, or irreversible changes require explicit confirmation.',
    '',
    '### Runtime Signals',
    `- wantsRepair=${Boolean(signals.wantsRepair)} referencesVisualContext=${Boolean(signals.referencesVisualContext)} highRisk=${Boolean(signals.highRisk)} likelyLongRunning=${Boolean(signals.likelyLongRunning)}`,
    `- recentTurnCount=${signals.recentTurnCount || 0} attachmentCount=${signals.attachmentCount || 0} memoryFactCount=${signals.memoryFactCount || 0}`,
  ].join('\n');
}

module.exports = {
  DEFAULT_TOOL_NAMES,
  buildCapabilityProfile,
  buildOpenClawPromptBlock,
  classifyRequest,
  normalizeTools,
};

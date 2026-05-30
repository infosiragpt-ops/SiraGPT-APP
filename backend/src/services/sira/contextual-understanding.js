'use strict';

const {
  resolveCoreferences,
  buildCorefPromptBlock,
} = require('../agents/coref-resolver');
const personalLexicon = require('../personal-lexicon');
const conversationRepair = require('../agents/conversation-repair');
const misunderstandingSignals = require('../agents/misunderstanding-signals');

const MAX_RECENT_TURNS = 8;
const MAX_EFFECTIVE_TEXT = 8000;
const DEFAULT_COREF_TIMEOUT_MS = 250;

const EMPTY_VALUE_CONTEXT = Object.freeze({
  source: 'deterministic_contextual_value_mapper',
  values: [],
  primary_domains: [],
  constraints: [],
  task_trajectory: {
    mode: 'single_turn',
    objective: null,
    phases: [],
    success_criteria: [],
    stop_conditions: [],
    confidence: 0,
  },
  task_context: 'general',
  subjectivity: {
    score: 0,
    label: 'objective',
    signals: [],
  },
  collaboration_mode: 'direct_response',
  response_posture: 'neutral_acknowledgment',
  response_type: 'neutral_acknowledgment',
  confidence: 0,
});

const EMPTY_GOAL_UNDERSTANDING = Object.freeze({
  source: 'deterministic_goal_understanding',
  explicit_request: null,
  inferred_user_goal: null,
  desired_outcome: null,
  continuity_anchors: [],
  missing_context: [],
  proactive_next_steps: [],
  confidence: 0,
});

const EMPTY_CONTEXT_MEMORY = Object.freeze({
  source: 'deterministic_context_memory',
  semantic: [],
  project: [],
  project_context: null,
  counts: {
    semantic: 0,
    project: 0,
    project_docs: 0,
    recent_conversations: 0,
  },
  confidence: 0,
});

const EMPTY_ATTRIBUTION_GRAPH_CONTEXT = Object.freeze({
  source: 'deterministic_attribution_graph_context',
  hypothesis: null,
  supernodes: [],
  edges: [],
  critical_paths: [],
  uncertainty: [],
  confidence: 0,
});

const EMPTY_LLM_UNDERSTANDING_PACKET = Object.freeze({
  source: 'deterministic_llm_understanding_packet',
  literal_request: null,
  inferred_task: null,
  user_goal: null,
  response_mode: 'direct_answer',
  context_priority: [],
  evidence_policy: [],
  ambiguity_policy: 'answer_directly',
  execution_policy: [],
  repair_policy: [],
  output_contract: [],
  no_go_rules: [],
  confidence: 0,
});

function clampText(value, max = 500) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function textFromHistoryItem(item) {
  if (!item || typeof item !== 'object') return '';
  const content = item.content;
  if (typeof item.text === 'string') return item.text;
  if (typeof content === 'string') return content;
  if (content && typeof content.text === 'string') return content.text;
  if (content && typeof content.original === 'string') return content.original;
  try {
    return content ? JSON.stringify(content) : '';
  } catch {
    return '';
  }
}

function normalizeRecentTurns(history = [], maxTurns = MAX_RECENT_TURNS) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const item of history) {
    const role = item?.role === 'assistant' ? 'assistant' : item?.role === 'user' ? 'user' : null;
    if (!role) continue;
    const text = textFromHistoryItem(item).trim();
    if (!text) continue;
    out.push({ role, text });
  }
  return out.slice(-maxTurns);
}

function findPreviousTurn(recentTurns, role) {
  for (let i = recentTurns.length - 1; i >= 0; i -= 1) {
    if (recentTurns[i]?.role === role) return recentTurns[i];
  }
  return null;
}

function summarizeCoreference(coref) {
  const refs = Array.isArray(coref?.references) ? coref.references : [];
  return {
    source: coref?.source || 'not_run',
    latency_ms: Number.isFinite(coref?.latencyMs) ? coref.latencyMs : 0,
    references: refs.slice(0, 5).map((ref) => ({
      span: clampText(ref.span || ref.anaphor, 80),
      resolves_to: ref.resolvesTo ? clampText(ref.resolvesTo, 240) : null,
      confidence: typeof ref.confidence === 'number' ? ref.confidence : 0,
      source: ref.source || null,
    })),
  };
}

function summarizeLexiconTerms(terms = []) {
  if (!Array.isArray(terms)) return [];
  return terms.slice(0, 5).map((term) => ({
    term: clampText(term.term, 120),
    definition: clampText(term.definition, 300),
    confidence: typeof term.confidence === 'number' ? term.confidence : 0,
    hits: Number.isFinite(term.hits) ? term.hits : 0,
  }));
}

function isExternalNativeRewriteRequest(text) {
  const raw = String(text || '');
  const noCopy = /\b(no\s+cop(?:ies|iar|ie|iarlo)|sin\s+copiar)\b.{0,60}\b(c[oó]digo|repo|repositorio|openclaw|upstream)\b/i.test(raw)
    || /\b(c[oó]digo|repo|repositorio|openclaw|upstream)\b.{0,60}\b(no\s+cop(?:ies|iar|ie|iarlo)|sin\s+copiar)\b/i.test(raw);
  if (noCopy) return true;
  const externalReference = /\b(openclaw|github\.com\/openclaw\/openclaw|upstream|external repo|repo externo|repositorio externo|otro repositorio|del otro software|ese repositorio|este repositorio)\b/i.test(raw);
  const rewriteIntent = /\b(reescrib(?:e|ir|as|irlo|elo)|refactoriza|integra|integrar|adaptar|adapta|implementa(?:r)?\s+(?:nuestro|propio)|c[oó]digo\s+propio)\b/i.test(raw);
  return externalReference && rewriteIntent;
}

function textFromMemoryItem(record) {
  if (!record) return '';
  const item = record && typeof record === 'object' && Object.prototype.hasOwnProperty.call(record, 'item')
    ? record.item
    : record;
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return String(item || '');
  for (const key of ['text', 'content', 'fact', 'summary', 'value', 'title', 'name']) {
    if (typeof item[key] === 'string' && item[key].trim()) return item[key];
  }
  try {
    return JSON.stringify(item);
  } catch {
    return '';
  }
}

function summarizeMemoryItems(items = [], maxItems = 4) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const record of items) {
    const text = clampText(textFromMemoryItem(record), 320);
    if (!text) continue;
    const item = record && typeof record === 'object' && record.item && typeof record.item === 'object'
      ? record.item
      : {};
    const score = numberOrNull(record?.score);
    const importance = numberOrNull(record?.importance ?? item.importance);
    out.push({
      id: record?.id || item.id || null,
      text,
      score: score == null ? null : Math.max(0, Math.min(1, score)),
      importance: importance == null ? null : Math.max(0, Math.min(1, importance)),
    });
    if (out.length >= maxItems) break;
  }
  return out;
}

function summarizeProjectMemoryContext(projectContext) {
  if (!projectContext || typeof projectContext !== 'object') return null;
  const docs = Array.isArray(projectContext.docs) ? projectContext.docs : [];
  const recent = Array.isArray(projectContext.recent_conversations) ? projectContext.recent_conversations : [];
  const summary = {
    project_id: projectContext.project_id ? String(projectContext.project_id) : null,
    member_role: projectContext.member?.role ? String(projectContext.member.role) : null,
    capabilities: Array.isArray(projectContext.capabilities)
      ? projectContext.capabilities.map(String).filter(Boolean).slice(0, 10)
      : [],
    instructions: clampText(projectContext.instructions, 500) || null,
    docs: docs.slice(0, 5).map((doc) => ({
      id: doc?.id || doc?.document_id || doc?.file_id || null,
      title: clampText(doc?.title || doc?.name || doc?.filename, 140) || null,
      summary: clampText(doc?.summary || doc?.description, 180) || null,
      type: clampText(doc?.type || doc?.mime_type, 80) || null,
    })).filter((doc) => doc.id || doc.title || doc.summary || doc.type),
    recent_conversations: recent.slice(0, 4).map((conv) => ({
      id: conv?.id || conv?.conversation_id || null,
      title: clampText(conv?.title || conv?.summary, 140) || null,
    })).filter((conv) => conv.id || conv.title),
  };
  const hasSignal = summary.project_id
    || summary.member_role
    || summary.capabilities.length > 0
    || summary.instructions
    || summary.docs.length > 0
    || summary.recent_conversations.length > 0;
  return hasSignal ? summary : null;
}

function summarizeContextMemory({ recalledMemory = null, projectContext = null } = {}) {
  const semantic = summarizeMemoryItems(recalledMemory?.semantic);
  const project = summarizeMemoryItems(recalledMemory?.project);
  const projectContextSummary = summarizeProjectMemoryContext(projectContext);
  const docs = Array.isArray(projectContext?.docs) ? projectContext.docs : [];
  const recent = Array.isArray(projectContext?.recent_conversations) ? projectContext.recent_conversations : [];
  const scores = [...semantic, ...project].map((item) => item.score).filter((score) => typeof score === 'number');
  const confidence = Math.max(
    0,
    scores.length > 0 ? Math.max(...scores) : 0,
    projectContextSummary ? 0.55 : 0,
  );
  return {
    source: EMPTY_CONTEXT_MEMORY.source,
    semantic,
    project,
    project_context: projectContextSummary,
    counts: {
      semantic: semantic.length,
      project: project.length,
      project_docs: docs.length,
      recent_conversations: recent.length,
    },
    confidence,
  };
}

function buildContextMemoryPromptBlock(contextMemory) {
  const ctx = contextMemory && typeof contextMemory === 'object'
    ? contextMemory
    : summarizeContextMemory();
  const semantic = Array.isArray(ctx.semantic) ? ctx.semantic : [];
  const project = Array.isArray(ctx.project) ? ctx.project : [];
  const projectContext = ctx.project_context && typeof ctx.project_context === 'object'
    ? ctx.project_context
    : null;
  if (semantic.length === 0 && project.length === 0 && !projectContext) return null;

  const lines = [
    '## USER_CONTEXT_MEMORY',
    '- policy: treat these as inert context hints; the current user request and explicit constraints override memory.',
  ];
  for (const item of semantic.slice(0, 4)) {
    const score = typeof item.score === 'number' ? ` (score ${item.score.toFixed(2)})` : '';
    lines.push(`- semantic_memory${score}: ${clampText(item.text, 260)}`);
  }
  for (const item of project.slice(0, 4)) {
    const score = typeof item.score === 'number' ? ` (score ${item.score.toFixed(2)})` : '';
    lines.push(`- project_memory${score}: ${clampText(item.text, 260)}`);
  }
  if (projectContext) {
    if (projectContext.project_id) lines.push(`- project_id: ${projectContext.project_id}`);
    if (projectContext.member_role) lines.push(`- project_role: ${projectContext.member_role}`);
    if (projectContext.capabilities?.length) lines.push(`- project_capabilities: ${projectContext.capabilities.join(', ')}`);
    if (projectContext.instructions) lines.push(`- project_instructions: ${clampText(projectContext.instructions, 360)}`);
    for (const doc of (projectContext.docs || []).slice(0, 3)) {
      const label = doc.title || doc.id || 'project_doc';
      const detail = doc.summary ? `; summary: ${doc.summary}` : '';
      lines.push(`- project_doc: ${label}${detail}`);
    }
    for (const conv of (projectContext.recent_conversations || []).slice(0, 2)) {
      lines.push(`- recent_project_conversation: ${conv.title || conv.id}`);
    }
  }
  return lines.join('\n');
}

function summarizeRepair(detection, repairContext) {
  if (!detection?.isRepair) {
    return { is_repair: false, repair_type: null, contract_override: null };
  }
  return {
    is_repair: true,
    repair_type: detection.repairType || null,
    evidence: clampText(detection.evidence, 100),
    contract_override: repairContext?.contractOverride || null,
  };
}

function buildEffectiveText({
  originalText,
  corefBlock,
  lexiconBlock,
  contextMemoryBlock,
  repairAddendum,
  valueContextBlock,
  goalUnderstandingBlock,
  attributionGraphBlock,
  llmUnderstandingBlock,
  resolvedPrompt,
}) {
  const basePrompt = String(resolvedPrompt || originalText || '').trim();
  const blocks = [corefBlock, lexiconBlock, contextMemoryBlock, repairAddendum, valueContextBlock, goalUnderstandingBlock, attributionGraphBlock, llmUnderstandingBlock]
    .filter((block) => typeof block === 'string' && block.trim().length > 0);
  if (blocks.length === 0 || basePrompt.length === 0) return basePrompt;
  const effective = `${blocks.join('\n\n')}\n\nSOLICITUD_USUARIO:\n${basePrompt}`;
  return effective.length > MAX_EFFECTIVE_TEXT
    ? `${effective.slice(0, MAX_EFFECTIVE_TEXT - 3)}...`
    : effective;
}

function uniqueById(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function subjectivitySignal(id, label, weight) {
  return { id, label, weight };
}

function inferSubjectivity(text, attachments = []) {
  const signals = [];
  const current = String(text || '');
  const hasAttachment = Array.isArray(attachments) && attachments.length > 0;

  if (/\b(deber[ií]a|conviene|prioriza|elige|decide|recomienda|aconseja|mejor(?:a|as|es)?|suficientemente\s+inteligente|intelligent|values?|valor(?:es)?|criterio|juicio)\b/i.test(current)) {
    signals.push(subjectivitySignal('normative_choice', 'Request requires prioritization or judgment', 0.32));
  }
  if (/\b(analiza|eval[uú]a|audita|review|under review|paper|investigaci[oó]n|framework|metodolog[ií]a)\b/i.test(current)) {
    signals.push(subjectivitySignal('interpretive_analysis', 'Request asks for interpretive analysis', 0.24));
  }
  if (/\b(sin\s+(?:cambiar|modificar|tocar)|no\s+invent(?:es|ar)|segur(?:o|idad)|privacidad|riesgo|bloquea|valida|estatus\s+verde)\b/i.test(current)) {
    signals.push(subjectivitySignal('constraint_tradeoff', 'Request includes tradeoffs or hard constraints', 0.22));
  }
  if (hasAttachment) {
    signals.push(subjectivitySignal('attached_context', 'Attachment can change task-specific priorities', 0.12));
  }
  if (/\b(c[uó]mo|por\s+qu[eé]|qué\s+opinas|opini[oó]n|siento|creo)\b/i.test(current)) {
    signals.push(subjectivitySignal('preference_or_explanation', 'Request includes preference or explanation framing', 0.14));
  }

  const score = Math.max(0, Math.min(1, signals.reduce((sum, item) => sum + item.weight, 0)));
  const label = score >= 0.5 ? 'highly_subjective'
    : score >= 0.28 ? 'mixed'
      : 'objective';
  return {
    score,
    label,
    signals: signals.map(({ id, label: signalLabel }) => ({ id, label: signalLabel })).slice(0, 6),
  };
}

function inferTaskContext(text, attachments = []) {
  const current = String(text || '');
  const attachmentNames = Array.isArray(attachments)
    ? attachments.map((a) => `${a?.filename || a?.name || ''} ${a?.mime_type || a?.mimeType || ''}`).join(' ')
    : '';
  const combined = `${current}\n${attachmentNames}`;

  if (/\b(c[oó]digo|software|repo|github|main|ci|deploy|tests?|type-check|bug|backend|frontend|interfaz|ui)\b/i.test(combined)) {
    return 'software_engineering';
  }
  if (/\b(pdf|docx|word|excel|ppt|documento|archivo|paper|art[ií]culo|investigaci[oó]n)\b/i.test(combined)) {
    return 'document_analysis';
  }
  if (/\b(fuentes?|citas?|doi|apa\s*7|paper|estudios?|cient[ií]fic[ao]s?)\b/i.test(combined)) {
    return 'research';
  }
  if (/\b(relaci[oó]n|pareja|familia|amigo|emocional|bienestar|consejo)\b/i.test(combined)) {
    return 'personal_advice';
  }
  if (/\b(hack|bypass|evadir|robar|credenciales|malware|phishing|destructiv[ao])\b/i.test(combined)) {
    return 'safety_sensitive';
  }
  if (/\b(historia|guion|copy|marketing|creativ[ao]|dise[ñn]a)\b/i.test(combined)) {
    return 'creative_content';
  }
  return 'general';
}

function enrichValueTaxonomy(values, taskContext, { subjectivity, attachments } = {}) {
  const shouldEnrich = (subjectivity?.score || 0) >= 0.24 || (Array.isArray(attachments) && attachments.length > 0);
  if (!shouldEnrich) return;

  const taskValue = {
    software_engineering: {
      id: 'implementation_integrity',
      domain: 'practical',
      label: 'Implementation integrity',
      evidence: 'software task needs behaviorally correct code and validation',
      confidence: 0.83,
    },
    document_analysis: {
      id: 'document_fidelity',
      domain: 'epistemic',
      label: 'Document fidelity',
      evidence: 'document task must preserve source meaning and attached context',
      confidence: 0.82,
    },
    research: {
      id: 'epistemic_traceability',
      domain: 'epistemic',
      label: 'Epistemic traceability',
      evidence: 'research task depends on verifiable claims and source tracking',
      confidence: 0.84,
    },
    personal_advice: {
      id: 'healthy_boundaries',
      domain: 'protective',
      label: 'Healthy boundaries',
      evidence: 'personal advice should reframe toward agency and wellbeing',
      confidence: 0.82,
    },
    safety_sensitive: {
      id: 'harm_prevention',
      domain: 'protective',
      label: 'Harm prevention',
      evidence: 'request may involve unsafe or abusive actions',
      confidence: 0.9,
    },
    creative_content: {
      id: 'creative_fit',
      domain: 'practical',
      label: 'Creative fit',
      evidence: 'creative task should match the user goal and audience',
      confidence: 0.76,
    },
  }[taskContext];

  if (taskValue) addValueSignal(values, taskValue);
}

function deriveContextualConstraints(text) {
  const constraints = [];
  if (/\b(sin\s+(?:cambiar|modificar|tocar)\s+(?:nada\s+de\s+)?(?:la\s+)?(?:interfaz|ui)|no\s+(?:cambies|toques)\s+(?:la\s+)?(?:interfaz|ui)|ui\s*lock)\b/i.test(text)) {
    constraints.push({
      id: 'preserve_interface',
      label: 'Preserve the existing interface',
      evidence: 'explicit no-ui-change constraint',
      priority: 'hard',
    });
  }
  if (isExternalNativeRewriteRequest(text)) {
    constraints.push({
      id: 'native_rewrite_only',
      label: 'Rewrite external ideas as SiraGPT-native implementation',
      evidence: 'explicit no-copy or rewrite constraint',
      priority: 'hard',
    });
  }
  if (/\b(no\s+invent(?:es|ar)|fuentes?\s+reales?|citas?\s+reales?|doi\s+real(?:es)?|verificad[ao]s?)\b/i.test(text)) {
    constraints.push({
      id: 'verified_sources_only',
      label: 'Use verified evidence only',
      evidence: 'explicit verification constraint',
      priority: 'hard',
    });
  }
  if (/\b(main|github|estatus\s+verde|green|vigila|ci|deploy)\b/i.test(text)) {
    constraints.push({
      id: 'remote_green_status',
      label: 'Finish through remote green status',
      evidence: 'explicit delivery/status constraint',
      priority: 'hard',
    });
  }
  return constraints;
}

function inferTaskTrajectory(text, recentTurns = [], attachments = [], valueContext = {}) {
  const current = String(text || '');
  const recent = Array.isArray(recentTurns) ? recentTurns.map((turn) => turn.text).join('\n') : '';
  const combined = `${current}\n${recent}`;
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  const isEndToEnd = /\b(de\s+inicio\s+a\s+fin|inicio\s+a\s+fin|end[-\s]?to[-\s]?end|completa(?:r|me)?\s+tareas?|ejecuta(?:r)?\s+tareas?\s+completas?|desarrollar\s+algo\s+complejo|hasta\s+que\s+(?:quede|est[eé]|funcione)|trabaja\s+de\s+manera\s+aut[oó]noma|programemos|codifica|implementemos|investiga(?:r)?\s+.+\s+(?:y|e)\s+(?:hag[aá]moslo|programemos|codifica)|sube\s+(?:los\s+)?cambios\s+a\s+github|ci\s+(?:en\s+)?verde)\b/i.test(combined);
  const needsResearch = /\b(investiga|estudios?|papers?|claude|chatgpt|openai|anthropic|fuentes?|documentaci[oó]n|research)\b/i.test(combined);
  const needsImplementation = /\b(implementa(?:r|mos)?|programa(?:r|mos)?|codifica|software|c[oó]digo|repo|github|ci|tests?|deploy|main)\b/i.test(combined);
  const needsValidation = /\b(valida|verifica|tests?|ci|estatus\s+verde|green|calidad|profesional|correctamente)\b/i.test(combined);

  if (!isEndToEnd && !needsImplementation && !needsResearch && !hasAttachments) {
    return EMPTY_VALUE_CONTEXT.task_trajectory;
  }

  const phases = [];
  phases.push('understand_full_context');
  if (hasAttachments) phases.push('ground_in_attachments');
  if (needsResearch) phases.push('research_current_best_practices');
  phases.push('build_execution_plan');
  if (needsImplementation) phases.push('implement_changes');
  if (needsValidation || needsImplementation) phases.push('validate_with_tests');
  if (/\b(github|main|ci|deploy|sube)\b/i.test(combined)) phases.push('publish_and_monitor');
  phases.push('deliver_concise_status');

  const criteria = [];
  if ((valueContext.constraints || []).some((constraint) => constraint.id === 'preserve_interface')) {
    criteria.push('Preserve existing UI/visual contract unless the user explicitly asks to change it.');
  }
  if ((valueContext.constraints || []).some((constraint) => constraint.id === 'native_rewrite_only')) {
    criteria.push('Rewrite external repository ideas into SiraGPT-native behavior; do not copy upstream code into active runtime.');
  }
  if (needsResearch) criteria.push('Use current, attributable source context before changing behavior.');
  if (needsImplementation) criteria.push('Convert the user goal into scoped code changes with focused tests.');
  if (needsValidation) criteria.push('Do not call the task done until local/remote validation is green or a concrete blocker is reported.');
  if (isEndToEnd) criteria.push('Carry the workflow from interpretation through delivery without stopping at a proposal.');

  const stopConditions = [
    'external action requires user approval',
    'missing credential or permission blocks execution',
    'destructive action would be required',
  ];

  return {
    mode: isEndToEnd || needsImplementation ? 'end_to_end_execution' : 'contextual_assistance',
    objective: clampText(current, 220),
    phases: Array.from(new Set(phases)).slice(0, 10),
    success_criteria: criteria.slice(0, 6),
    stop_conditions: stopConditions,
    confidence: Math.max(
      isEndToEnd ? 0.9 : 0,
      needsImplementation ? 0.82 : 0,
      needsResearch ? 0.72 : 0,
      hasAttachments ? 0.68 : 0,
    ),
  };
}

function addValueSignal(values, { id, domain, label, evidence, confidence }) {
  if (!id || !domain || !label) return;
  values.push({
    id,
    domain,
    label,
    evidence: clampText(evidence || label, 140),
    confidence: Math.max(0, Math.min(1, Number(confidence || 0))),
  });
}

function inferCollaborationMode(text, values, constraints) {
  if (/\b(trabaja\s+de\s+manera\s+aut[oó]noma|trabaja\s+aut[oó]nomo|procede\s+sin\s+parar|no\s+pares|hasta\s+completar|cuando\s+acabes)\b/i.test(text)) {
    return 'autonomous_execution';
  }
  if (constraints.some((constraint) => constraint.id === 'remote_green_status')) return 'autonomous_execution';
  if (values.some((value) => value.id === 'human_ai_collaboration')) return 'collaborative_alignment';
  if (values.some((value) => value.domain === 'epistemic')) return 'careful_verification';
  return 'direct_response';
}

function inferResponsePosture(values, constraints, repairDetection) {
  if (constraints.length > 0 || repairDetection?.isRepair) return 'support_with_guardrails';
  if (values.some((value) => value.domain === 'protective')) return 'mild_resistance_to_risk';
  if (values.some((value) => value.id === 'human_ai_collaboration')) return 'supportive_collaboration';
  if (values.length > 0) return 'mild_support';
  return 'neutral_acknowledgment';
}

function inferResponseType({ values, constraints, repairDetection, taskContext, subjectivity }) {
  if (values.some((value) => value.id === 'harm_prevention')) return 'strong_resistance';
  if (constraints.length > 0 || repairDetection?.isRepair) return 'reframing';
  if (taskContext === 'personal_advice') return 'reframing';
  if (subjectivity?.label === 'highly_subjective' && values.some((value) => value.domain === 'epistemic')) {
    return 'mild_resistance';
  }
  if (values.some((value) => ['execution_reliability', 'implementation_integrity'].includes(value.id))) {
    return 'strong_support';
  }
  if (values.length > 0) return 'mild_support';
  return 'neutral_acknowledgment';
}

function inferContextualValueContext({
  originalText,
  recentTurns = [],
  attachments = [],
  lexiconTerms = [],
  repairDetection = null,
  coreference = null,
} = {}) {
  const currentText = String(originalText || '');
  const recentText = recentTurns.map((turn) => turn.text).join('\n');
  const combined = `${currentText}\n${recentText}`;
  const values = [];
  const taskContext = inferTaskContext(currentText, attachments);
  const subjectivity = inferSubjectivity(currentText, attachments);

  const corefRefs = Array.isArray(coreference?.references) ? coreference.references : [];
  if (
    corefRefs.length > 0
    || /\b(contexto|contextual|completo|eso|aquello|la\s+segunda|la\s+primera|contin[uú]a|como\s+te\s+dije|lo\s+anterior|the\s+previous|that\s+one)\b/i.test(currentText)
  ) {
    addValueSignal(values, {
      id: 'contextual_fidelity',
      domain: 'epistemic',
      label: 'Contextual fidelity',
      evidence: 'request depends on conversation or full context',
      confidence: corefRefs.length > 0 ? 0.9 : 0.78,
    });
  }

  if (/\b(fuentes?|citas?|doi|apa\s*7|verificad[ao]s?|reales?|evidencia|estudios?|paper|art[ií]culos?|cient[ií]fic[ao]s?|no\s+invent(?:es|ar))\b/i.test(combined)) {
    addValueSignal(values, {
      id: 'evidence_integrity',
      domain: 'epistemic',
      label: 'Evidence integrity',
      evidence: 'request mentions sources, citations, studies, or verification',
      confidence: 0.84,
    });
  }

  if (/\b(trabaja\s+de\s+manera\s+aut[oó]noma|aut[oó]nom[ao]|implementa|mejoras?|funcionamiento|software|c[oó]digo|main|github|estatus\s+verde|deploy|ci)\b/i.test(currentText)) {
    addValueSignal(values, {
      id: 'execution_reliability',
      domain: 'practical',
      label: 'Execution reliability',
      evidence: 'request asks for autonomous implementation and verified delivery',
      confidence: 0.9,
    });
  }

  if (isExternalNativeRewriteRequest(combined)) {
    addValueSignal(values, {
      id: 'native_integration_integrity',
      domain: 'practical',
      label: 'Native integration integrity',
      evidence: 'request asks to adapt an external repo without copying code',
      confidence: 0.9,
    });
  }

  if (/\b(colaboraci[oó]n\s+humano[-\s]?ia|humano[-\s]?ia|colaboraci[oó]n|trabaja\s+conmigo|usuario)\b/i.test(combined)) {
    addValueSignal(values, {
      id: 'human_ai_collaboration',
      domain: 'social',
      label: 'Human-AI collaboration',
      evidence: 'request frames the task as human-AI collaboration',
      confidence: 0.82,
    });
  }

  if (/\b(sin\s+(?:cambiar|modificar|tocar)\s+(?:nada\s+de\s+)?(?:la\s+)?(?:interfaz|ui)|no\s+(?:cambies|toques)\s+(?:la\s+)?(?:interfaz|ui)|no\s+invent(?:es|ar)|segur(?:o|idad)|privacidad|bloquea|valida)\b/i.test(currentText)) {
    addValueSignal(values, {
      id: 'risk_bounded_execution',
      domain: 'protective',
      label: 'Risk-bounded execution',
      evidence: 'request includes hard constraints or risk boundaries',
      confidence: 0.88,
    });
  }

  if (Array.isArray(lexiconTerms) && lexiconTerms.length > 0) {
    addValueSignal(values, {
      id: 'personalized_continuity',
      domain: 'personal',
      label: 'Personalized continuity',
      evidence: 'private lexicon matched user-specific terms',
      confidence: 0.82,
    });
  }

  if (repairDetection?.isRepair) {
    addValueSignal(values, {
      id: 'misunderstanding_repair',
      domain: 'protective',
      label: 'Misunderstanding repair',
      evidence: 'turn corrects a previous mismatch',
      confidence: 0.86,
    });
  }

  if (attachments.length > 0) {
    addValueSignal(values, {
      id: 'attachment_grounding',
      domain: 'epistemic',
      label: 'Attachment grounding',
      evidence: 'request includes attached context',
      confidence: 0.78,
    });
  }

  enrichValueTaxonomy(values, taskContext, { subjectivity, attachments });

  const uniqueValues = uniqueById(values).sort((a, b) => b.confidence - a.confidence).slice(0, 8);
  const primaryDomains = Array.from(new Set(uniqueValues.map((value) => value.domain))).slice(0, 5);
  const constraints = deriveContextualConstraints(currentText);
  const taskTrajectory = inferTaskTrajectory(currentText, recentTurns, attachments, { values: uniqueValues, constraints });
  const collaborationMode = inferCollaborationMode(currentText, uniqueValues, constraints);
  const responsePosture = inferResponsePosture(uniqueValues, constraints, repairDetection);
  const responseType = inferResponseType({
    values: uniqueValues,
    constraints,
    repairDetection,
    taskContext,
    subjectivity,
  });
  const confidence = uniqueValues.length > 0 ? Math.max(...uniqueValues.map((value) => value.confidence)) : 0;

  return {
    source: EMPTY_VALUE_CONTEXT.source,
    values: uniqueValues,
    primary_domains: primaryDomains,
    constraints,
    task_trajectory: taskTrajectory,
    task_context: taskContext,
    subjectivity,
    collaboration_mode: collaborationMode,
    response_posture: responsePosture,
    response_type: responseType,
    confidence,
  };
}

function summarizeValueContext(valueContext) {
  const ctx = valueContext && typeof valueContext === 'object' ? valueContext : EMPTY_VALUE_CONTEXT;
  return {
    source: ctx.source || EMPTY_VALUE_CONTEXT.source,
    values: Array.isArray(ctx.values) ? ctx.values.slice(0, 8).map((value) => ({
      id: String(value.id || ''),
      domain: String(value.domain || ''),
      label: clampText(value.label, 100),
      evidence: clampText(value.evidence, 140),
      confidence: typeof value.confidence === 'number' ? Math.max(0, Math.min(1, value.confidence)) : 0,
    })).filter((value) => value.id && value.domain && value.label) : [],
    primary_domains: Array.isArray(ctx.primary_domains) ? ctx.primary_domains.map(String).slice(0, 5) : [],
    constraints: Array.isArray(ctx.constraints) ? ctx.constraints.slice(0, 8).map((constraint) => ({
      id: String(constraint.id || ''),
      label: clampText(constraint.label, 120),
      evidence: clampText(constraint.evidence, 140),
      priority: constraint.priority === 'hard' ? 'hard' : 'soft',
    })).filter((constraint) => constraint.id && constraint.label) : [],
    task_trajectory: summarizeTaskTrajectory(ctx.task_trajectory),
    task_context: String(ctx.task_context || EMPTY_VALUE_CONTEXT.task_context),
    subjectivity: {
      score: typeof ctx.subjectivity?.score === 'number' ? Math.max(0, Math.min(1, ctx.subjectivity.score)) : 0,
      label: String(ctx.subjectivity?.label || EMPTY_VALUE_CONTEXT.subjectivity.label),
      signals: Array.isArray(ctx.subjectivity?.signals)
        ? ctx.subjectivity.signals.slice(0, 6).map((signal) => ({
          id: String(signal.id || ''),
          label: clampText(signal.label, 120),
        })).filter((signal) => signal.id && signal.label)
        : [],
    },
    collaboration_mode: String(ctx.collaboration_mode || EMPTY_VALUE_CONTEXT.collaboration_mode),
    response_posture: String(ctx.response_posture || EMPTY_VALUE_CONTEXT.response_posture),
    response_type: String(ctx.response_type || ctx.response_posture || EMPTY_VALUE_CONTEXT.response_type),
    confidence: typeof ctx.confidence === 'number' ? Math.max(0, Math.min(1, ctx.confidence)) : 0,
  };
}

function summarizeTaskTrajectory(taskTrajectory) {
  const trajectory = taskTrajectory && typeof taskTrajectory === 'object'
    ? taskTrajectory
    : EMPTY_VALUE_CONTEXT.task_trajectory;
  return {
    mode: String(trajectory.mode || EMPTY_VALUE_CONTEXT.task_trajectory.mode),
    objective: trajectory.objective ? clampText(trajectory.objective, 220) : null,
    phases: Array.isArray(trajectory.phases) ? trajectory.phases.map(String).filter(Boolean).slice(0, 10) : [],
    success_criteria: Array.isArray(trajectory.success_criteria)
      ? trajectory.success_criteria.map((item) => clampText(item, 180)).filter(Boolean).slice(0, 6)
      : [],
    stop_conditions: Array.isArray(trajectory.stop_conditions)
      ? trajectory.stop_conditions.map((item) => clampText(item, 140)).filter(Boolean).slice(0, 5)
      : [],
    confidence: typeof trajectory.confidence === 'number' ? Math.max(0, Math.min(1, trajectory.confidence)) : 0,
  };
}

function buildContextualValuePromptBlock(valueContext) {
  const ctx = summarizeValueContext(valueContext);
  const shouldInject = ctx.values.length > 0 && (
    ctx.constraints.length > 0
    || ctx.collaboration_mode !== 'direct_response'
    || ctx.task_trajectory.mode !== 'single_turn'
    || ctx.values.some((value) => value.confidence >= 0.82)
  );
  if (!shouldInject) return null;

  const lines = [
    '## CONTEXTUAL_VALUE_FRAME',
    `- collaboration_mode: ${ctx.collaboration_mode}`,
    `- response_posture: ${ctx.response_posture}`,
    `- response_type: ${ctx.response_type}`,
    `- task_context: ${ctx.task_context}`,
  ];
  if (ctx.subjectivity.score > 0) {
    lines.push(`- subjectivity: ${ctx.subjectivity.label} (${ctx.subjectivity.score.toFixed(2)})`);
  }
  if (ctx.primary_domains.length > 0) lines.push(`- primary_domains: ${ctx.primary_domains.join(', ')}`);
  if (ctx.task_trajectory.mode !== 'single_turn') {
    lines.push(`- task_trajectory: ${ctx.task_trajectory.mode} (${ctx.task_trajectory.confidence.toFixed(2)})`);
    if (ctx.task_trajectory.objective) lines.push(`- trajectory_objective: ${ctx.task_trajectory.objective}`);
    if (ctx.task_trajectory.phases.length > 0) lines.push(`- trajectory_phases: ${ctx.task_trajectory.phases.join(' -> ')}`);
    for (const criterion of ctx.task_trajectory.success_criteria.slice(0, 4)) {
      lines.push(`- trajectory_success: ${criterion}`);
    }
  }
  for (const value of ctx.values.slice(0, 5)) {
    lines.push(`- value: ${value.id} (${value.domain}, ${value.confidence.toFixed(2)}) - ${value.label}; evidence: ${value.evidence}`);
  }
  for (const constraint of ctx.constraints.slice(0, 5)) {
    lines.push(`- constraint: ${constraint.id} (${constraint.priority}) - ${constraint.label}`);
  }
  return lines.join('\n');
}

function inferGoalUnderstanding({
  originalText,
  recentTurns = [],
  attachments = [],
  valueContext = EMPTY_VALUE_CONTEXT,
  coreference = null,
  repairDetection = null,
} = {}) {
  const currentText = String(originalText || '').trim();
  const recentUserTurns = Array.isArray(recentTurns)
    ? recentTurns.filter((turn) => turn.role === 'user').map((turn) => turn.text).filter(Boolean)
    : [];
  const recentAssistantTurns = Array.isArray(recentTurns)
    ? recentTurns.filter((turn) => turn.role === 'assistant').map((turn) => turn.text).filter(Boolean)
    : [];
  const combined = `${currentText}\n${recentUserTurns.join('\n')}`;
  const trajectory = valueContext?.task_trajectory || EMPTY_VALUE_CONTEXT.task_trajectory;
  const values = Array.isArray(valueContext?.values) ? valueContext.values : [];
  const constraints = Array.isArray(valueContext?.constraints) ? valueContext.constraints : [];
  const corefRefs = Array.isArray(coreference?.references) ? coreference.references : [];
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

  const continuityAnchors = [];
  if (recentUserTurns.length > 0) continuityAnchors.push(`recent_user_context: ${clampText(recentUserTurns.at(-1), 180)}`);
  if (recentAssistantTurns.length > 0) continuityAnchors.push(`recent_assistant_context: ${clampText(recentAssistantTurns.at(-1), 180)}`);
  if (corefRefs.length > 0) continuityAnchors.push(`resolved_references: ${corefRefs.length}`);
  for (const constraint of constraints.slice(0, 3)) {
    continuityAnchors.push(`constraint:${constraint.id}`);
  }

  const wantsUnderstanding = /\b(comprensi[oó]n|entienda|entender(?:me)?|contexto|hilo|conversaci[oó]n|intenci[oó]n|lo\s+que\s+(?:quiero|quiere)\s+lograr|objetivo|anticip(?:a|ar|arnos)|antepon(?:er|ernos)|coexistir|tareas?\s+completas?)\b/i.test(combined);
  const wantsCompleteExecution = trajectory.mode !== 'single_turn'
    || /\b(ejecuta(?:r)?\s+tareas?\s+completas?|desarrollar\s+algo\s+complejo|de\s+inicio\s+a\s+fin|no\s+pares|hasta\s+comprobar|verifica(?:r)?)\b/i.test(combined);
  const wantsNativeAdaptation = constraints.some((constraint) => constraint.id === 'native_rewrite_only')
    || values.some((value) => value.id === 'native_integration_integrity');
  const hasContextDependency = corefRefs.length > 0
    || repairDetection?.isRepair
    || /\b(esto|eso|lo\s+anterior|todo\s+el\s+hilo|contexto\s+completo|como\s+dije|ahora\s+s[ií])\b/i.test(currentText)
    || recentUserTurns.length >= 2;

  let confidence = 0;
  if (wantsUnderstanding) confidence = Math.max(confidence, 0.86);
  if (wantsCompleteExecution) confidence = Math.max(confidence, 0.82);
  if (hasContextDependency) confidence = Math.max(confidence, 0.74);
  if (values.some((value) => value.id === 'contextual_fidelity')) confidence = Math.max(confidence, 0.88);
  if (values.some((value) => value.id === 'execution_reliability')) confidence = Math.max(confidence, 0.86);
  if (wantsNativeAdaptation) confidence = Math.max(confidence, 0.88);
  if (hasAttachments) confidence = Math.max(confidence, 0.68);

  if (confidence < 0.65) return { ...EMPTY_GOAL_UNDERSTANDING };

  const inferredPieces = [];
  if (wantsUnderstanding || values.some((value) => value.id === 'contextual_fidelity')) {
    inferredPieces.push('understand the full conversational context and the user objective before answering');
  }
  if (wantsCompleteExecution || values.some((value) => value.id === 'execution_reliability')) {
    inferredPieces.push('turn simple ideas into complete planned execution with validation');
  }
  if (wantsNativeAdaptation) {
    inferredPieces.push('adapt external repository capabilities into SiraGPT-native behavior without copying upstream code');
  }
  if (values.some((value) => value.id === 'human_ai_collaboration')) {
    inferredPieces.push('cooperate with the human while preserving their intent and control');
  }
  if (constraints.length > 0) {
    inferredPieces.push('respect hard constraints from the thread');
  }

  const proactiveSteps = ['reconstruct_thread_goal', 'identify_missing_context_before_guessing'];
  if (trajectory.mode !== 'single_turn' || wantsCompleteExecution) proactiveSteps.push('plan_execute_validate');
  if (wantsNativeAdaptation) proactiveSteps.push('map_upstream_to_native_contracts');
  if (hasAttachments || trajectory.phases?.includes('ground_in_attachments')) proactiveSteps.push('ground_answer_in_attachments');
  if (trajectory.phases?.includes('validate_with_tests')) proactiveSteps.push('self_check_before_delivery');
  if (constraints.length > 0) proactiveSteps.push('enforce_thread_constraints');

  const missingContext = [];
  if (/\b(el\s+documento|la\s+imagen|el\s+archivo|adjunto)\b/i.test(currentText) && !hasAttachments && corefRefs.length === 0) {
    missingContext.push('referenced_attachment_not_available');
  }
  if (/\b(contin[uú]a|sigue|hazlo|corr[ií]gelo)\b/i.test(currentText) && recentTurns.length === 0) {
    missingContext.push('referenced_prior_turn_not_available');
  }

  return {
    source: EMPTY_GOAL_UNDERSTANDING.source,
    explicit_request: clampText(currentText, 240) || null,
    inferred_user_goal: inferredPieces.length > 0
      ? inferredPieces.join('; ')
      : clampText(trajectory.objective || currentText, 240),
    desired_outcome: wantsCompleteExecution
      ? 'complete_task_execution_with_verified_result'
      : 'context_aware_answer_that_matches_user_intent',
    continuity_anchors: Array.from(new Set(continuityAnchors)).slice(0, 8),
    missing_context: missingContext.slice(0, 5),
    proactive_next_steps: Array.from(new Set(proactiveSteps)).slice(0, 8),
    confidence,
  };
}

function summarizeGoalUnderstanding(goalUnderstanding) {
  const goal = goalUnderstanding && typeof goalUnderstanding === 'object'
    ? goalUnderstanding
    : EMPTY_GOAL_UNDERSTANDING;
  return {
    source: String(goal.source || EMPTY_GOAL_UNDERSTANDING.source),
    explicit_request: goal.explicit_request ? clampText(goal.explicit_request, 240) : null,
    inferred_user_goal: goal.inferred_user_goal ? clampText(goal.inferred_user_goal, 360) : null,
    desired_outcome: goal.desired_outcome ? clampText(goal.desired_outcome, 120) : null,
    continuity_anchors: Array.isArray(goal.continuity_anchors)
      ? goal.continuity_anchors.map((item) => clampText(item, 220)).filter(Boolean).slice(0, 8)
      : [],
    missing_context: Array.isArray(goal.missing_context)
      ? goal.missing_context.map(String).filter(Boolean).slice(0, 5)
      : [],
    proactive_next_steps: Array.isArray(goal.proactive_next_steps)
      ? goal.proactive_next_steps.map(String).filter(Boolean).slice(0, 8)
      : [],
    confidence: typeof goal.confidence === 'number' ? Math.max(0, Math.min(1, goal.confidence)) : 0,
  };
}

function buildGoalUnderstandingPromptBlock(goalUnderstanding) {
  const goal = summarizeGoalUnderstanding(goalUnderstanding);
  if (!goal.inferred_user_goal || goal.confidence < 0.65) return null;
  const lines = [
    '## GOAL_UNDERSTANDING_FRAME',
    `- confidence: ${goal.confidence.toFixed(2)}`,
    `- inferred_user_goal: ${goal.inferred_user_goal}`,
  ];
  if (goal.desired_outcome) lines.push(`- desired_outcome: ${goal.desired_outcome}`);
  for (const anchor of goal.continuity_anchors.slice(0, 4)) lines.push(`- continuity_anchor: ${anchor}`);
  for (const step of goal.proactive_next_steps.slice(0, 6)) lines.push(`- proactive_next_step: ${step}`);
  for (const missing of goal.missing_context.slice(0, 3)) lines.push(`- missing_context: ${missing}`);
  return lines.join('\n');
}

function graphNode(id, label, evidence, confidence, kind = 'feature') {
  return {
    id,
    label: clampText(label, 90),
    evidence: clampText(evidence, 160),
    confidence: Math.max(0, Math.min(1, Number(confidence || 0))),
    kind,
  };
}

function graphEdge(from, to, relation, weight) {
  return {
    from,
    to,
    relation: clampText(relation, 120),
    weight: Math.max(0, Math.min(1, Number(weight || 0))),
  };
}

function maybePushNode(nodes, node) {
  if (!node?.id || nodes.some((existing) => existing.id === node.id)) return;
  nodes.push(node);
}

function buildAttributionGraphContext({
  originalText,
  recentTurns = [],
  attachments = [],
  lexiconTerms = [],
  coreference = null,
  repairDetection = null,
  valueContext = EMPTY_VALUE_CONTEXT,
  goalUnderstanding = EMPTY_GOAL_UNDERSTANDING,
} = {}) {
  const currentText = String(originalText || '').trim();
  const nodes = [];
  const edges = [];
  const uncertainty = [];
  const refs = Array.isArray(coreference?.references) ? coreference.references : [];
  const values = Array.isArray(valueContext?.values) ? valueContext.values : [];
  const constraints = Array.isArray(valueContext?.constraints) ? valueContext.constraints : [];
  const trajectory = valueContext?.task_trajectory || EMPTY_VALUE_CONTEXT.task_trajectory;
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  const hasRecentContext = Array.isArray(recentTurns) && recentTurns.length > 0;
  const inferredGoal = goalUnderstanding?.inferred_user_goal || null;

  if (currentText) {
    maybePushNode(nodes, graphNode(
      'current_request',
      'Current user request',
      currentText,
      0.95,
      'input',
    ));
  }

  if (hasRecentContext) {
    const recentUser = recentTurns.filter((turn) => turn.role === 'user').at(-1);
    maybePushNode(nodes, graphNode(
      'recent_thread',
      'Recent thread context',
      recentUser?.text || recentTurns.at(-1)?.text || 'recent conversation turns',
      0.72,
      'context',
    ));
    edges.push(graphEdge('recent_thread', 'current_request', 'provides continuity and prior objective', 0.66));
  }

  if (refs.length > 0) {
    maybePushNode(nodes, graphNode(
      'resolved_references',
      'Resolved references',
      refs.map((ref) => `${ref.span || ref.anaphor} -> ${ref.resolvesTo || 'unresolved'}`).join('; '),
      Math.max(...refs.map((ref) => Number(ref.confidence || 0)), 0),
      'feature',
    ));
    edges.push(graphEdge('resolved_references', 'current_request', 'fills pronouns or implicit references before intent inference', 0.84));
  }

  if (hasAttachments) {
    maybePushNode(nodes, graphNode(
      'attachments',
      'Attached context',
      attachments.map((a) => a?.filename || a?.name || a?.id || 'attachment').join(', '),
      0.76,
      'context',
    ));
    edges.push(graphEdge('attachments', 'current_request', 'grounds the request in supplied files', 0.74));
  }

  if (Array.isArray(lexiconTerms) && lexiconTerms.length > 0) {
    maybePushNode(nodes, graphNode(
      'personal_lexicon',
      'Personal lexicon match',
      lexiconTerms.map((term) => term.term).filter(Boolean).join(', '),
      Math.max(...lexiconTerms.map((term) => Number(term.confidence || 0)), 0.72),
      'feature',
    ));
    edges.push(graphEdge('personal_lexicon', 'current_request', 'adds user-specific meaning for matched terms', 0.7));
  }

  for (const value of values.slice(0, 5)) {
    maybePushNode(nodes, graphNode(
      `value_${value.id}`,
      value.label || value.id,
      value.evidence || value.label || value.id,
      value.confidence,
      'supernode',
    ));
    edges.push(graphEdge('current_request', `value_${value.id}`, `activates ${value.domain || 'contextual'} value`, value.confidence || 0.5));
  }

  if (constraints.length > 0) {
    maybePushNode(nodes, graphNode(
      'hard_constraints',
      'Thread constraints',
      constraints.map((constraint) => `${constraint.id}: ${constraint.label}`).join('; '),
      Math.max(...constraints.map((constraint) => constraint.priority === 'hard' ? 0.9 : 0.68), 0.68),
      'supernode',
    ));
    for (const value of values.slice(0, 3)) {
      edges.push(graphEdge(`value_${value.id}`, 'hard_constraints', 'constrains how the answer should be executed', 0.72));
    }
  }

  if (trajectory.mode && trajectory.mode !== 'single_turn') {
    maybePushNode(nodes, graphNode(
      'task_trajectory',
      'Task trajectory',
      `${trajectory.mode}: ${(trajectory.phases || []).join(' -> ')}`,
      trajectory.confidence || 0.7,
      'supernode',
    ));
    const sourceNode = values.some((value) => value.id === 'execution_reliability')
      ? 'value_execution_reliability'
      : 'current_request';
    edges.push(graphEdge(sourceNode, 'task_trajectory', 'turns intent into expected execution path', trajectory.confidence || 0.7));
  }

  if (repairDetection?.isRepair) {
    maybePushNode(nodes, graphNode(
      'repair_signal',
      'Misunderstanding repair',
      repairDetection.evidence || repairDetection.repairType || 'user is correcting prior interpretation',
      0.86,
      'feature',
    ));
    edges.push(graphEdge('repair_signal', 'hard_constraints', 'prevents repeating the previous wrong interpretation', 0.82));
  }

  if (inferredGoal) {
    maybePushNode(nodes, graphNode(
      'inferred_goal',
      'Inferred user goal',
      inferredGoal,
      goalUnderstanding.confidence || 0.7,
      'hypothesis',
    ));
    const candidateSources = [
      refs.length > 0 ? 'resolved_references' : null,
      values.some((value) => value.id === 'contextual_fidelity') ? 'value_contextual_fidelity' : null,
      values.some((value) => value.id === 'execution_reliability') ? 'value_execution_reliability' : null,
      trajectory.mode !== 'single_turn' ? 'task_trajectory' : null,
      constraints.length > 0 ? 'hard_constraints' : null,
      'current_request',
    ].filter(Boolean);
    for (const source of Array.from(new Set(candidateSources)).slice(0, 5)) {
      edges.push(graphEdge(source, 'inferred_goal', 'supports inferred goal hypothesis', source === 'current_request' ? 0.62 : 0.78));
    }
  }

  if (/\b(link|url|paper|art[ií]culo|investiga|revisa|documentaci[oó]n)\b/i.test(currentText)) {
    maybePushNode(nodes, graphNode(
      'external_source_requirement',
      'External source grounding',
      'request references an external source or review target',
      0.78,
      'feature',
    ));
    edges.push(graphEdge('external_source_requirement', 'inferred_goal', 'requires source-aware interpretation before execution', 0.74));
  }

  if (refs.some((ref) => Number(ref.confidence || 0) < 0.65)) {
    uncertainty.push('Some references are low-confidence; treat them as hints, not facts.');
  }
  if (goalUnderstanding?.missing_context?.length > 0) {
    uncertainty.push(...goalUnderstanding.missing_context.map((item) => `Missing context: ${item}`));
  }
  if (!inferredGoal && nodes.length >= 3) {
    uncertainty.push('No high-confidence goal hypothesis was produced; avoid overcommitting.');
  }

  const prunedNodes = nodes
    .filter((node) => node.confidence >= 0.5 || ['current_request', 'inferred_goal'].includes(node.id))
    .slice(0, 10);
  const keepIds = new Set(prunedNodes.map((node) => node.id));
  const prunedEdges = edges
    .filter((edge) => keepIds.has(edge.from) && keepIds.has(edge.to) && edge.weight >= 0.5)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 12);

  const criticalPaths = [];
  if (keepIds.has('inferred_goal')) {
    for (const edge of prunedEdges.filter((e) => e.to === 'inferred_goal').slice(0, 4)) {
      criticalPaths.push(`${edge.from} -> inferred_goal`);
    }
  }
  if (keepIds.has('task_trajectory') && keepIds.has('inferred_goal')) {
    criticalPaths.unshift('current_request -> task_trajectory -> inferred_goal');
  }

  const confidenceSeeds = [
    goalUnderstanding?.confidence || 0,
    valueContext?.confidence || 0,
    trajectory?.confidence || 0,
    refs.length > 0 ? Math.max(...refs.map((ref) => Number(ref.confidence || 0)), 0) : 0,
  ].filter((n) => n > 0);
  const confidence = confidenceSeeds.length > 0
    ? Math.max(...confidenceSeeds)
    : (prunedNodes.length >= 3 ? 0.58 : 0);

  if (confidence < 0.55 || prunedNodes.length < 2) {
    return { ...EMPTY_ATTRIBUTION_GRAPH_CONTEXT };
  }

  return {
    source: EMPTY_ATTRIBUTION_GRAPH_CONTEXT.source,
    hypothesis: inferredGoal ? clampText(inferredGoal, 300) : 'User intent depends on the active request plus recent context.',
    supernodes: prunedNodes,
    edges: prunedEdges,
    critical_paths: Array.from(new Set(criticalPaths)).slice(0, 5),
    uncertainty: Array.from(new Set(uncertainty)).slice(0, 5),
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

function summarizeAttributionGraphContext(graph) {
  const ctx = graph && typeof graph === 'object' ? graph : EMPTY_ATTRIBUTION_GRAPH_CONTEXT;
  return {
    source: String(ctx.source || EMPTY_ATTRIBUTION_GRAPH_CONTEXT.source),
    hypothesis: ctx.hypothesis ? clampText(ctx.hypothesis, 300) : null,
    supernodes: Array.isArray(ctx.supernodes) ? ctx.supernodes.slice(0, 10).map((node) => ({
      id: String(node.id || ''),
      label: clampText(node.label, 90),
      evidence: clampText(node.evidence, 160),
      confidence: typeof node.confidence === 'number' ? Math.max(0, Math.min(1, node.confidence)) : 0,
      kind: String(node.kind || 'feature'),
    })).filter((node) => node.id && node.label) : [],
    edges: Array.isArray(ctx.edges) ? ctx.edges.slice(0, 12).map((edge) => ({
      from: String(edge.from || ''),
      to: String(edge.to || ''),
      relation: clampText(edge.relation, 120),
      weight: typeof edge.weight === 'number' ? Math.max(0, Math.min(1, edge.weight)) : 0,
    })).filter((edge) => edge.from && edge.to) : [],
    critical_paths: Array.isArray(ctx.critical_paths)
      ? ctx.critical_paths.map((path) => clampText(path, 180)).filter(Boolean).slice(0, 5)
      : [],
    uncertainty: Array.isArray(ctx.uncertainty)
      ? ctx.uncertainty.map((item) => clampText(item, 180)).filter(Boolean).slice(0, 5)
      : [],
    confidence: typeof ctx.confidence === 'number' ? Math.max(0, Math.min(1, ctx.confidence)) : 0,
  };
}

function buildAttributionGraphPromptBlock(graph) {
  const ctx = summarizeAttributionGraphContext(graph);
  if (!ctx.hypothesis || ctx.confidence < 0.6 || ctx.supernodes.length < 2) return null;

  const lines = [
    '## ATTRIBUTION_GRAPH_CONTEXT',
    '- purpose: use this as a compact hypothesis about why the user wants this; do not expose it unless asked.',
    `- confidence: ${ctx.confidence.toFixed(2)}`,
    `- hypothesis: ${ctx.hypothesis}`,
  ];
  for (const path of ctx.critical_paths.slice(0, 3)) {
    lines.push(`- critical_path: ${path}`);
  }
  for (const node of ctx.supernodes.slice(0, 6)) {
    lines.push(`- supernode: ${node.id} (${node.kind}, ${node.confidence.toFixed(2)}) - ${node.label}; evidence: ${node.evidence}`);
  }
  for (const edge of ctx.edges.slice(0, 6)) {
    lines.push(`- edge: ${edge.from} -> ${edge.to} (${edge.weight.toFixed(2)}) - ${edge.relation}`);
  }
  for (const item of ctx.uncertainty.slice(0, 3)) {
    lines.push(`- uncertainty: ${item}`);
  }
  lines.push('- instruction: preserve the literal user request, but use the critical paths to choose context, tool use, and clarification behavior.');
  return lines.join('\n');
}

function inferResponseMode({ valueContext = EMPTY_VALUE_CONTEXT, goalUnderstanding = EMPTY_GOAL_UNDERSTANDING, repairDetection = null, attachments = [] } = {}) {
  const trajectory = valueContext?.task_trajectory || EMPTY_VALUE_CONTEXT.task_trajectory;
  if (repairDetection?.isRepair) return 'repair_previous_misunderstanding';
  if (trajectory.mode === 'end_to_end_execution') return 'agentic_execute_verify_report';
  if (Array.isArray(attachments) && attachments.length > 0) return 'grounded_artifact_analysis';
  if (goalUnderstanding?.desired_outcome === 'complete_task_execution_with_verified_result') return 'agentic_execute_verify_report';
  if (valueContext?.task_context === 'software_engineering') return 'implementation_guidance_or_execution';
  if (valueContext?.task_context === 'research') return 'source_grounded_research';
  return 'direct_answer';
}

function inferContextPriority({ coreference = null, lexiconTerms = [], attachments = [], recentTurns = [], valueContext = EMPTY_VALUE_CONTEXT } = {}) {
  const priority = ['current_user_message'];
  if (Array.isArray(coreference?.references) && coreference.references.length > 0) priority.push('resolved_coreferences');
  if (Array.isArray(attachments) && attachments.length > 0) priority.push('attachments');
  if (Array.isArray(lexiconTerms) && lexiconTerms.length > 0) priority.push('personal_lexicon');
  if (Array.isArray(recentTurns) && recentTurns.length > 0) priority.push('recent_thread_history');
  if (valueContext?.values?.some((value) => value.id === 'contextual_fidelity')) priority.push('thread_goal_hypothesis');
  if (valueContext?.values?.some((value) => value.id === 'evidence_integrity')) priority.push('verified_external_evidence');
  return Array.from(new Set(priority)).slice(0, 8);
}

function buildEvidencePolicy({ valueContext = EMPTY_VALUE_CONTEXT, attachments = [], semanticIntentAnalysis = null } = {}) {
  const policy = [
    'Separate user text, thread history, memory, files, tool output, and web sources before making claims.',
    'Do not invent facts that are not visible in the prompt, files, tools, memory, or cited sources.',
  ];
  if (Array.isArray(attachments) && attachments.length > 0) {
    policy.push('If files or images are present, ground the answer in extracted/visible content before inference.');
  }
  if (valueContext?.values?.some((value) => value.id === 'evidence_integrity')) {
    policy.push('For research or factual claims, cite or name the source channel that supports each important claim.');
  }
  const requiredTools = semanticIntentAnalysis?.structured_intent?.required_tools
    || semanticIntentAnalysis?.routing?.required_tools
    || [];
  if (Array.isArray(requiredTools) && requiredTools.length > 0) {
    policy.push(`Prefer required tools when available: ${requiredTools.slice(0, 8).join(', ')}.`);
  }
  return policy.slice(0, 6);
}

function buildExecutionPolicy({ valueContext = EMPTY_VALUE_CONTEXT, universalTaskContract = null, openclawProfile = null } = {}) {
  const trajectory = valueContext?.task_trajectory || EMPTY_VALUE_CONTEXT.task_trajectory;
  const policy = [];
  if (trajectory.mode !== 'single_turn') {
    policy.push(`Follow trajectory phases: ${(trajectory.phases || []).slice(0, 8).join(' -> ')}.`);
  }
  if (valueContext?.task_context === 'software_engineering') {
    policy.push('For code/app work: inspect relevant code, make scoped changes, run available checks, then report exact verification.');
  }
  if (universalTaskContract?.pipeline) {
    policy.push(`Respect task pipeline: ${universalTaskContract.pipeline}.`);
  }
  if (openclawProfile?.executionDossier?.qualityGates?.length) {
    policy.push(`Satisfy quality gates: ${openclawProfile.executionDossier.qualityGates.slice(0, 8).join(', ')}.`);
  }
  if (!policy.length) policy.push('Answer the current request directly while preserving relevant context.');
  return policy.slice(0, 6);
}

function buildRepairPolicy({ repairDetection = null, recordedSignals = [] } = {}) {
  const policies = [];
  if (repairDetection?.isRepair || (Array.isArray(recordedSignals) && recordedSignals.length > 0)) {
    policies.push('Treat this as a repair turn: identify what was misunderstood and answer from the corrected interpretation.');
    policies.push('Do not repeat the prior failed output shape if the user corrected format, scope, target, or language.');
    if (repairDetection?.repairType) policies.push(`Repair type: ${repairDetection.repairType}.`);
  }
  return policies.slice(0, 5);
}

function buildAmbiguityPolicy({ goalUnderstanding = EMPTY_GOAL_UNDERSTANDING, attributionGraphContext = EMPTY_ATTRIBUTION_GRAPH_CONTEXT, valueContext = EMPTY_VALUE_CONTEXT } = {}) {
  const missing = Array.isArray(goalUnderstanding?.missing_context) ? goalUnderstanding.missing_context : [];
  if (missing.length > 0) return `ask_one_question_if_blocked: ${missing.slice(0, 3).join(', ')}`;
  if ((attributionGraphContext?.confidence || 0) >= 0.72 || (goalUnderstanding?.confidence || 0) >= 0.72) {
    return 'proceed_with_high_confidence_contextual_interpretation';
  }
  if (valueContext?.task_trajectory?.mode === 'end_to_end_execution') return 'make_safe_assumption_and_execute_next_reversible_step';
  return 'answer_directly';
}

function inferOutputContract({ valueContext = EMPTY_VALUE_CONTEXT, goalUnderstanding = EMPTY_GOAL_UNDERSTANDING, repairDetection = null } = {}) {
  const contract = [];
  if (goalUnderstanding?.inferred_user_goal) contract.push('Start from the inferred user goal, not only isolated keywords.');
  if (valueContext?.task_trajectory?.mode !== 'single_turn') contract.push('Report what was executed, what was verified, and what remains blocked.');
  if (repairDetection?.isRepair) contract.push('Make the corrected answer visibly different from the mistaken interpretation.');
  if (valueContext?.constraints?.length) contract.push(`Respect hard constraints: ${valueContext.constraints.map((c) => c.id).slice(0, 5).join(', ')}.`);
  if (!contract.length) contract.push('Give a concise answer that directly satisfies the current request.');
  return contract.slice(0, 6);
}

function inferNoGoRules({ valueContext = EMPTY_VALUE_CONTEXT, openclawProfile = null } = {}) {
  const rules = [
    'Do not claim files, commits, deploys, tests, or web checks happened unless a tool/result confirms it.',
    'Do not collapse uncertain context into facts.',
  ];
  if (valueContext?.constraints?.some((constraint) => constraint.id === 'preserve_interface')) {
    rules.push('Do not change the UI/visual surface when the user asked only for internal behavior.');
  }
  if (valueContext?.constraints?.some((constraint) => constraint.id === 'native_rewrite_only')) {
    rules.push('Do not copy external repository code into active SiraGPT runtime; rewrite behavior behind SiraGPT-owned contracts.');
  }
  if (openclawProfile?.signals?.highRisk) {
    rules.push('Do not perform external or irreversible actions without explicit confirmation.');
  }
  return rules.slice(0, 6);
}

function buildLLMUnderstandingPacket({
  originalText,
  effectiveText = null,
  recentTurns = [],
  attachments = [],
  lexiconTerms = [],
  coreference = null,
  repairDetection = null,
  recordedSignals = [],
  valueContext = EMPTY_VALUE_CONTEXT,
  goalUnderstanding = EMPTY_GOAL_UNDERSTANDING,
  attributionGraphContext = EMPTY_ATTRIBUTION_GRAPH_CONTEXT,
  semanticIntentAnalysis = null,
  universalTaskContract = null,
  openclawProfile = null,
} = {}) {
  const literal = clampText(originalText, 500);
  const goal = summarizeGoalUnderstanding(goalUnderstanding);
  const values = summarizeValueContext(valueContext);
  const graph = summarizeAttributionGraphContext(attributionGraphContext);
  const responseMode = inferResponseMode({ valueContext: values, goalUnderstanding: goal, repairDetection, attachments });
  const inferredTask = goal.inferred_user_goal
    || graph.hypothesis
    || semanticIntentAnalysis?.structured_intent?.intent_primary
    || universalTaskContract?.primary_intent
    || null;
  const confidenceSeeds = [
    goal.confidence,
    values.confidence,
    graph.confidence,
    openclawProfile?.executionDossier?.operatingMode?.confidence || 0,
  ].filter((score) => score > 0);
  const confidence = confidenceSeeds.length
    ? Math.max(...confidenceSeeds)
    : (literal ? 0.45 : 0);

  return {
    source: EMPTY_LLM_UNDERSTANDING_PACKET.source,
    literal_request: literal || null,
    effective_request: effectiveText && effectiveText !== originalText ? clampText(effectiveText, 900) : null,
    inferred_task: inferredTask ? clampText(inferredTask, 360) : null,
    user_goal: goal.inferred_user_goal,
    response_mode: responseMode,
    context_priority: inferContextPriority({ coreference, lexiconTerms, attachments, recentTurns, valueContext: values }),
    evidence_policy: buildEvidencePolicy({ valueContext: values, attachments, semanticIntentAnalysis }),
    ambiguity_policy: buildAmbiguityPolicy({ goalUnderstanding: goal, attributionGraphContext: graph, valueContext: values }),
    execution_policy: buildExecutionPolicy({ valueContext: values, universalTaskContract, openclawProfile }),
    repair_policy: buildRepairPolicy({ repairDetection, recordedSignals }),
    output_contract: inferOutputContract({ valueContext: values, goalUnderstanding: goal, repairDetection }),
    no_go_rules: inferNoGoRules({ valueContext: values, openclawProfile }),
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

function summarizeLLMUnderstandingPacket(packet) {
  const pkt = packet && typeof packet === 'object' ? packet : EMPTY_LLM_UNDERSTANDING_PACKET;
  return {
    source: String(pkt.source || EMPTY_LLM_UNDERSTANDING_PACKET.source),
    literal_request: pkt.literal_request ? clampText(pkt.literal_request, 500) : null,
    effective_request: pkt.effective_request ? clampText(pkt.effective_request, 900) : null,
    inferred_task: pkt.inferred_task ? clampText(pkt.inferred_task, 360) : null,
    user_goal: pkt.user_goal ? clampText(pkt.user_goal, 360) : null,
    response_mode: String(pkt.response_mode || EMPTY_LLM_UNDERSTANDING_PACKET.response_mode),
    context_priority: Array.isArray(pkt.context_priority) ? pkt.context_priority.map(String).slice(0, 8) : [],
    evidence_policy: Array.isArray(pkt.evidence_policy) ? pkt.evidence_policy.map((item) => clampText(item, 220)).filter(Boolean).slice(0, 6) : [],
    ambiguity_policy: clampText(pkt.ambiguity_policy || EMPTY_LLM_UNDERSTANDING_PACKET.ambiguity_policy, 220),
    execution_policy: Array.isArray(pkt.execution_policy) ? pkt.execution_policy.map((item) => clampText(item, 260)).filter(Boolean).slice(0, 6) : [],
    repair_policy: Array.isArray(pkt.repair_policy) ? pkt.repair_policy.map((item) => clampText(item, 240)).filter(Boolean).slice(0, 5) : [],
    output_contract: Array.isArray(pkt.output_contract) ? pkt.output_contract.map((item) => clampText(item, 240)).filter(Boolean).slice(0, 6) : [],
    no_go_rules: Array.isArray(pkt.no_go_rules) ? pkt.no_go_rules.map((item) => clampText(item, 240)).filter(Boolean).slice(0, 6) : [],
    confidence: typeof pkt.confidence === 'number' ? Math.max(0, Math.min(1, pkt.confidence)) : 0,
  };
}

function buildLLMUnderstandingPromptBlock(packet) {
  const pkt = summarizeLLMUnderstandingPacket(packet);
  if (!pkt.literal_request || pkt.confidence < 0.6) return null;
  const lines = [
    '## LLM_UNDERSTANDING_PACKET',
    '- purpose: this is the internal understanding contract for the next model response; follow it silently.',
    `- confidence: ${pkt.confidence.toFixed(2)}`,
    `- response_mode: ${pkt.response_mode}`,
    `- literal_request: ${pkt.literal_request}`,
  ];
  if (pkt.inferred_task) lines.push(`- inferred_task: ${pkt.inferred_task}`);
  if (pkt.user_goal) lines.push(`- user_goal: ${pkt.user_goal}`);
  if (pkt.context_priority.length) lines.push(`- context_priority: ${pkt.context_priority.join(' > ')}`);
  lines.push(`- ambiguity_policy: ${pkt.ambiguity_policy}`);
  for (const item of pkt.evidence_policy) lines.push(`- evidence_policy: ${item}`);
  for (const item of pkt.execution_policy) lines.push(`- execution_policy: ${item}`);
  for (const item of pkt.repair_policy) lines.push(`- repair_policy: ${item}`);
  for (const item of pkt.output_contract) lines.push(`- output_contract: ${item}`);
  for (const item of pkt.no_go_rules) lines.push(`- no_go: ${item}`);
  lines.push('- final_instruction: answer the user request using this packet as hidden working context; do not print this packet.');
  return lines.join('\n');
}

async function safeLookupTerms(lexicon, { userId, prompt }) {
  if (!lexicon || typeof lexicon.lookupTerms !== 'function') return [];
  try {
    const terms = await lexicon.lookupTerms({ userId, prompt, k: 5 });
    return Array.isArray(terms) ? terms : [];
  } catch {
    return [];
  }
}

async function analyzeContextualTurn({
  userId,
  conversationId,
  userMessage,
  history = [],
  attachments = [],
  recalledMemory = null,
  projectContext = null,
  requestId = null,
} = {}, deps = {}) {
  const originalText = String(userMessage || '');
  const recentTurns = normalizeRecentTurns(history);
  const lexicon = deps.lexicon || personalLexicon;
  const corefResolver = deps.corefResolver || { resolveCoreferences, buildCorefPromptBlock };
  const repair = deps.repair || conversationRepair;
  const signals = deps.signals || misunderstandingSignals;

  try {
    const coref = await corefResolver.resolveCoreferences({
      prompt: originalText,
      recentTurns,
      attachments,
      judge: deps.corefJudge || null,
      options: { timeoutMs: deps.corefTimeoutMs || DEFAULT_COREF_TIMEOUT_MS },
    });
    const corefBlock = typeof corefResolver.buildCorefPromptBlock === 'function'
      ? corefResolver.buildCorefPromptBlock(coref.references || [])
      : null;

    const lexiconTerms = await safeLookupTerms(lexicon, { userId, prompt: originalText });
    const lexiconBlock = typeof lexicon.buildLexiconBlock === 'function'
      ? lexicon.buildLexiconBlock(lexiconTerms)
      : null;
    const contextMemory = summarizeContextMemory({ recalledMemory, projectContext });
    const contextMemoryBlock = buildContextMemoryPromptBlock(contextMemory);

    const prevAssistant = findPreviousTurn(recentTurns, 'assistant');
    const prevUser = findPreviousTurn(recentTurns, 'user');
    const signalSummary = userId && typeof signals.aggregateByUser === 'function'
      ? signals.aggregateByUser(userId)
      : null;
    const repairDetection = repair.detectRepair({
      prompt: originalText,
      prevTurn: prevAssistant,
      prevUserPrompt: prevUser?.text || null,
      signals: signalSummary,
    });
    const repairContext = repair.buildRepairContext(repairDetection);

    const recordedSignals = typeof signals.recordFromContext === 'function'
      ? signals.recordFromContext({
        userId,
        sessionId: conversationId,
        turnId: requestId,
        currentPrompt: originalText,
        previousPrompt: prevUser?.text || null,
        msSincePrevious: recentTurns.length > 0 ? 1000 : null,
      })
      : [];

    const valueContext = inferContextualValueContext({
      originalText,
      recentTurns,
      attachments,
      lexiconTerms,
      repairDetection,
      coreference: coref,
    });
    const valueContextBlock = buildContextualValuePromptBlock(valueContext);
    const goalUnderstanding = inferGoalUnderstanding({
      originalText,
      recentTurns,
      attachments,
      valueContext,
      coreference: coref,
      repairDetection,
    });
    const goalUnderstandingBlock = buildGoalUnderstandingPromptBlock(goalUnderstanding);
    const attributionGraphContext = buildAttributionGraphContext({
      originalText,
      recentTurns,
      attachments,
      lexiconTerms,
      coreference: coref,
      repairDetection,
      valueContext,
      goalUnderstanding,
    });
    const attributionGraphBlock = buildAttributionGraphPromptBlock(attributionGraphContext);
    const llmUnderstandingPacket = buildLLMUnderstandingPacket({
      originalText,
      effectiveText: null,
      recentTurns,
      attachments,
      lexiconTerms,
      coreference: coref,
      repairDetection,
      recordedSignals,
      valueContext,
      goalUnderstanding,
      attributionGraphContext,
    });
    const llmUnderstandingBlock = buildLLMUnderstandingPromptBlock(llmUnderstandingPacket);

    const effectiveText = buildEffectiveText({
      originalText,
      corefBlock,
      lexiconBlock,
      contextMemoryBlock,
      repairAddendum: repairContext.systemAddendum,
      valueContextBlock,
      goalUnderstandingBlock,
      attributionGraphBlock,
      llmUnderstandingBlock,
      resolvedPrompt: coref.resolvedPrompt || originalText,
    });
    const applied = effectiveText !== originalText;

    const envelopeContext = {
      applied,
      original_text: originalText,
      effective_text: effectiveText,
      recent_turn_count: recentTurns.length,
      coreference: summarizeCoreference(coref),
      lexicon_terms: summarizeLexiconTerms(lexiconTerms),
      context_memory: contextMemory,
      repair: summarizeRepair(repairDetection, repairContext),
      misunderstanding_signals: recordedSignals,
      value_context: summarizeValueContext(valueContext),
      goal_understanding: summarizeGoalUnderstanding(goalUnderstanding),
      attribution_graph_context: summarizeAttributionGraphContext(attributionGraphContext),
      llm_understanding_packet: summarizeLLMUnderstandingPacket({
        ...llmUnderstandingPacket,
        effective_request: effectiveText !== originalText ? effectiveText : null,
      }),
    };

    return {
      applied,
      originalText,
      effectiveText,
      recentTurns,
      coreference: coref,
      lexiconTerms,
      repairDetection,
      repairContext,
      misunderstandingSignals: recordedSignals,
      contextMemory,
      valueContext,
      attributionGraphContext,
      llmUnderstandingPacket: {
        ...llmUnderstandingPacket,
        effective_request: effectiveText !== originalText ? effectiveText : null,
      },
      envelopeContext,
      error: null,
    };
  } catch (error) {
    return {
      applied: false,
      originalText,
      effectiveText: originalText,
      recentTurns,
      coreference: null,
      lexiconTerms: [],
      repairDetection: { isRepair: false },
      repairContext: { systemAddendum: null, contractOverride: null },
      misunderstandingSignals: [],
      envelopeContext: {
        applied: false,
        original_text: originalText,
        effective_text: originalText,
        recent_turn_count: recentTurns.length,
        coreference: { source: 'error', latency_ms: 0, references: [] },
        lexicon_terms: [],
        context_memory: summarizeContextMemory(),
        repair: { is_repair: false, repair_type: null, contract_override: null },
        misunderstanding_signals: [],
        value_context: summarizeValueContext(EMPTY_VALUE_CONTEXT),
        goal_understanding: summarizeGoalUnderstanding(EMPTY_GOAL_UNDERSTANDING),
        attribution_graph_context: summarizeAttributionGraphContext(EMPTY_ATTRIBUTION_GRAPH_CONTEXT),
        llm_understanding_packet: summarizeLLMUnderstandingPacket(EMPTY_LLM_UNDERSTANDING_PACKET),
      },
      error: error && error.message ? error.message : String(error),
    };
  }
}

module.exports = {
  analyzeContextualTurn,
  normalizeRecentTurns,
  textFromHistoryItem,
  findPreviousTurn,
  buildEffectiveText,
  summarizeCoreference,
  summarizeLexiconTerms,
  summarizeContextMemory,
  buildContextMemoryPromptBlock,
  summarizeRepair,
  inferContextualValueContext,
  summarizeValueContext,
  buildContextualValuePromptBlock,
  inferTaskTrajectory,
  summarizeTaskTrajectory,
  inferGoalUnderstanding,
  summarizeGoalUnderstanding,
  buildGoalUnderstandingPromptBlock,
  buildAttributionGraphContext,
  summarizeAttributionGraphContext,
  buildAttributionGraphPromptBlock,
  buildLLMUnderstandingPacket,
  summarizeLLMUnderstandingPacket,
  buildLLMUnderstandingPromptBlock,
  constants: {
    MAX_RECENT_TURNS,
    MAX_EFFECTIVE_TEXT,
    DEFAULT_COREF_TIMEOUT_MS,
  },
};

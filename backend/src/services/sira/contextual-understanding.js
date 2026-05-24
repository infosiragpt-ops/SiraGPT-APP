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

function clampText(value, max = 500) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
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
  repairAddendum,
  valueContextBlock,
  resolvedPrompt,
}) {
  const basePrompt = String(resolvedPrompt || originalText || '').trim();
  const blocks = [corefBlock, lexiconBlock, repairAddendum, valueContextBlock]
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
  const isEndToEnd = /\b(de\s+inicio\s+a\s+fin|inicio\s+a\s+fin|end[-\s]?to[-\s]?end|completa(?:r|me)?\s+tareas?|hasta\s+que\s+(?:quede|est[eé]|funcione)|trabaja\s+de\s+manera\s+aut[oó]noma|programemos|codifica|implementemos|investiga(?:r)?\s+.+\s+(?:y|e)\s+(?:hag[aá]moslo|programemos|codifica)|sube\s+(?:los\s+)?cambios\s+a\s+github|ci\s+(?:en\s+)?verde)\b/i.test(combined);
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

    const effectiveText = buildEffectiveText({
      originalText,
      corefBlock,
      lexiconBlock,
      repairAddendum: repairContext.systemAddendum,
      valueContextBlock,
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
      repair: summarizeRepair(repairDetection, repairContext),
      misunderstanding_signals: recordedSignals,
      value_context: summarizeValueContext(valueContext),
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
      valueContext,
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
        repair: { is_repair: false, repair_type: null, contract_override: null },
        misunderstanding_signals: [],
        value_context: summarizeValueContext(EMPTY_VALUE_CONTEXT),
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
  summarizeRepair,
  inferContextualValueContext,
  summarizeValueContext,
  buildContextualValuePromptBlock,
  inferTaskTrajectory,
  summarizeTaskTrajectory,
  constants: {
    MAX_RECENT_TURNS,
    MAX_EFFECTIVE_TEXT,
    DEFAULT_COREF_TIMEOUT_MS,
  },
};

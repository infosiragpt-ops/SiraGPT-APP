'use strict';

/**
 * Multi-Hop Intent Reasoner
 *
 * Inspired by the multi-hop reasoning circuits identified in the attribution
 * graphs paper (e.g. "Texas → capital → Austin"). User requests often hide
 * intermediate inferential steps that, once made explicit, change which tools
 * or data the agent should reach for.
 *
 * Example:
 *   user: "make a chart for last quarter's revenue"
 *   hop 0 (literal): generate a chart
 *   hop 1 (subject): the subject is revenue figures
 *   hop 2 (constraint): "last quarter" implies a date range → need to resolve
 *   hop 3 (prerequisite): data must be available; need to fetch or ask
 *   hop 4 (output kind): chart implies visualisation tool
 *
 * Output: an ordered list of hops, each with a label, evidence, confidence,
 * and the prerequisite it surfaces. The caller can use this to decide
 * whether to ask a clarifying question, fetch data, or proceed.
 */

const HOP_KINDS = Object.freeze({
  LITERAL: 'literal',
  SUBJECT: 'subject',
  CONSTRAINT: 'constraint',
  PREREQUISITE: 'prerequisite',
  OUTPUT_KIND: 'output_kind',
  TOOL_MAPPING: 'tool_mapping',
  USER_GOAL: 'user_goal',
});

const OUTPUT_KIND_HINTS = Object.freeze({
  chart: 'visualization',
  graph: 'visualization',
  diagram: 'visualization',
  diagrama: 'visualization',
  grafica: 'visualization',
  gráfica: 'visualization',
  table: 'tabular',
  tabla: 'tabular',
  list: 'list',
  lista: 'list',
  document: 'document',
  documento: 'document',
  pdf: 'document',
  docx: 'document',
  presentation: 'slides',
  presentación: 'slides',
  slides: 'slides',
  diapositivas: 'slides',
  code: 'code',
  codigo: 'code',
  código: 'code',
  script: 'code',
  function: 'code',
  email: 'message',
  correo: 'message',
  message: 'message',
  mensaje: 'message',
  summary: 'summary',
  resumen: 'summary',
  report: 'report',
  reporte: 'report',
  informe: 'report',
});

const TOOL_HINTS = Object.freeze({
  visualization: ['create_chart', 'create_infographic_svg', 'create_dashboard_html'],
  tabular: ['create_comparison_table', 'extract_data'],
  list: ['create_kanban_board', 'create_timeline'],
  document: ['document-pipeline', 'create_document'],
  slides: ['pptx-skill'],
  code: ['code-sandbox', 'agent-tools'],
  message: ['draft-content'],
  summary: ['summarize-channel', 'analysis-pipeline'],
  report: ['document-pipeline', 'analysis-pipeline'],
});

const CONSTRAINT_PATTERNS = [
  { name: 'date_range', re: /\b(last|past|previous|este|último|ultimo|próximo|proximo|next)\s+(quarter|trimestre|month|mes|year|año|week|semana|day|día)\b/i },
  { name: 'count_limit', re: /\b(?:top|first|primer|primeros)\s+\d+\b/i },
  { name: 'language', re: /\b(?:en\s+)?(?:español|english|inglés|french|frances|francés|german|alemán|italiano|portugués|portugues)\b/i },
  { name: 'format_constraint', re: /\b(?:in|como|en\s+formato|format(?:o)?)\s+(json|csv|markdown|html|pdf|docx|xlsx)\b/i },
  { name: 'audience', re: /\b(?:for|para)\s+(executives?|engineers?|investors?|ejecutivos?|ingenieros?|inversionistas?|kids?|niños?)\b/i },
  { name: 'tone', re: /\b(?:formal|casual|professional|profesional|friendly|amistoso|technical|técnico)\b/i },
];

const PREREQ_PATTERNS = [
  { name: 'needs_document', re: /\b(?:this|the|el|este|la|esta)\s+(?:document|file|archivo|documento|pdf|spreadsheet|hoja|sheet)\b/i },
  { name: 'needs_data', re: /\b(?:data|datos|numbers|números|figures|cifras|stats|estadísticas)\b/i },
  { name: 'needs_url', re: /\bhttps?:\/\/\S+/i },
  { name: 'needs_search', re: /\b(?:latest|recent|reciente|último|find|search|busca|investiga|research|investigar?)\b/i },
  { name: 'needs_context', re: /\b(?:my|mi|nuestra|nuestro|our|the team|el equipo|the company|la empresa)\b/i },
];

const USER_GOAL_INFERENCES = [
  {
    name: 'troubleshoot',
    weight: 0.7,
    re: /\b(?:not working|no funciona|broken|roto|error|exception|stuck|atascado|failing|fallando|bug|fault)\b/i,
  },
  {
    name: 'learn',
    weight: 0.55,
    re: /\b(?:explain|explica|what is|qué es|how does|cómo funciona|teach|enseña|aprender|learn)\b/i,
  },
  {
    name: 'decide',
    weight: 0.55,
    re: /\b(?:should i|debería|recommend|recomienda|which is better|cuál es mejor|compare|compara|pros and cons|ventajas)\b/i,
  },
  {
    name: 'produce_deliverable',
    weight: 0.7,
    re: /\b(?:deliver|entrega|final|ship|prod|production|client|cliente|stakeholder|investor|inversor)\b/i,
  },
  {
    name: 'explore',
    weight: 0.4,
    re: /\b(?:brainstorm|ideate|explora|explorar|ideas|options|opciones|possibilities|posibilidades)\b/i,
  },
];

function makeHop(kind, label, opts = {}) {
  return {
    kind,
    label,
    evidence: opts.evidence || [],
    confidence: clamp(opts.confidence ?? 0.5),
    prerequisite: opts.prerequisite || null,
    metadata: opts.metadata || {},
  };
}

function clamp(value, min = 0, max = 1) {
  if (value == null || Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function detectOutputKind(query) {
  if (!query) return null;
  const lower = query.toLowerCase();
  for (const [token, kind] of Object.entries(OUTPUT_KIND_HINTS)) {
    if (lower.includes(token)) return { token, kind };
  }
  return null;
}

function detectConstraints(query) {
  if (!query) return [];
  const matches = [];
  for (const pattern of CONSTRAINT_PATTERNS) {
    const m = query.match(pattern.re);
    if (m) matches.push({ name: pattern.name, evidence: m[0] });
  }
  return matches;
}

function detectPrerequisites(query, context = {}) {
  if (!query) return [];
  const matches = [];
  for (const pattern of PREREQ_PATTERNS) {
    const m = query.match(pattern.re);
    if (m) matches.push({ name: pattern.name, evidence: m[0] });
  }

  const docs = Array.isArray(context.documents) ? context.documents : [];
  if (
    matches.some((p) => p.name === 'needs_document') &&
    docs.length === 0
  ) {
    matches.push({ name: 'document_missing', evidence: 'no attached documents found in context' });
  }
  if (
    matches.some((p) => p.name === 'needs_data') &&
    docs.length === 0 &&
    !context.memoryFacts?.length
  ) {
    matches.push({ name: 'data_missing', evidence: 'request references data but none provided' });
  }
  return matches;
}

function inferUserGoal(query) {
  if (!query) return null;
  let best = null;
  for (const inference of USER_GOAL_INFERENCES) {
    const m = query.match(inference.re);
    if (m && (!best || inference.weight > best.weight)) {
      best = { name: inference.name, weight: inference.weight, evidence: m[0] };
    }
  }
  return best;
}

function reason(query, context = {}) {
  const hops = [];

  const text = typeof query === 'string' ? query.trim() : '';
  if (!text) {
    return {
      hops: [],
      finalIntent: null,
      missingPrerequisites: [],
      suggestedTools: [],
      needsClarification: false,
      reason: 'empty query',
    };
  }

  hops.push(
    makeHop(HOP_KINDS.LITERAL, `Raw request: ${text.slice(0, 140)}`, {
      confidence: 0.99,
      evidence: [text.slice(0, 200)],
    }),
  );

  const subjectEntities = (text.match(/\b[A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+){0,2}\b/g) || []).slice(0, 4);
  if (subjectEntities.length > 0) {
    hops.push(
      makeHop(HOP_KINDS.SUBJECT, `Subject(s): ${subjectEntities.join(', ')}`, {
        confidence: 0.6,
        evidence: subjectEntities,
      }),
    );
  }

  const constraints = detectConstraints(text);
  for (const constraint of constraints) {
    hops.push(
      makeHop(HOP_KINDS.CONSTRAINT, `Constraint: ${constraint.name}`, {
        confidence: 0.7,
        evidence: [constraint.evidence],
        metadata: { name: constraint.name },
      }),
    );
  }

  const prereqs = detectPrerequisites(text, context);
  for (const prereq of prereqs) {
    const missing = prereq.name === 'document_missing' || prereq.name === 'data_missing';
    hops.push(
      makeHop(HOP_KINDS.PREREQUISITE, `Prerequisite: ${prereq.name}`, {
        confidence: missing ? 0.85 : 0.55,
        evidence: [prereq.evidence],
        prerequisite: prereq.name,
        metadata: { unresolved: missing },
      }),
    );
  }

  const output = detectOutputKind(text);
  if (output) {
    hops.push(
      makeHop(HOP_KINDS.OUTPUT_KIND, `Output kind: ${output.kind}`, {
        confidence: 0.75,
        evidence: [output.token],
        metadata: { kind: output.kind, token: output.token },
      }),
    );
  }

  const suggestedTools = [];
  if (output && TOOL_HINTS[output.kind]) {
    suggestedTools.push(...TOOL_HINTS[output.kind]);
    hops.push(
      makeHop(HOP_KINDS.TOOL_MAPPING, `Likely tools: ${TOOL_HINTS[output.kind].join(', ')}`, {
        confidence: 0.6,
        evidence: TOOL_HINTS[output.kind],
        metadata: { tools: TOOL_HINTS[output.kind] },
      }),
    );
  }

  const goal = inferUserGoal(text);
  if (goal) {
    hops.push(
      makeHop(HOP_KINDS.USER_GOAL, `Underlying goal: ${goal.name}`, {
        confidence: goal.weight,
        evidence: [goal.evidence],
        metadata: { goalName: goal.name },
      }),
    );
  }

  const missingPrerequisites = prereqs.filter((p) => p.name === 'document_missing' || p.name === 'data_missing');
  const needsClarification =
    missingPrerequisites.length > 0 ||
    (output == null && hops.filter((h) => h.kind === HOP_KINDS.CONSTRAINT).length === 0 && text.length < 25);

  return {
    hops,
    finalIntent: {
      outputKind: output?.kind || null,
      constraints: constraints.map((c) => c.name),
      goal: goal?.name || null,
    },
    missingPrerequisites: missingPrerequisites.map((p) => p.name),
    suggestedTools,
    needsClarification,
    summary: summarize(hops),
  };
}

function summarize(hops) {
  if (!Array.isArray(hops) || hops.length === 0) return '';
  const parts = [];
  for (const hop of hops) {
    parts.push(`[${hop.kind}] ${hop.label}`);
  }
  return parts.join(' → ');
}

function buildMultiHopPrompt(result, opts = {}) {
  if (!result || !Array.isArray(result.hops) || result.hops.length === 0) return '';
  const lines = ['### Multi-hop Intent Reasoning'];
  lines.push('The system decomposed the request into these inferential hops:');
  for (const hop of result.hops) {
    lines.push(`- **${hop.kind}** — ${hop.label} (confidence ${Math.round(hop.confidence * 100)}%)`);
  }
  if (result.missingPrerequisites.length > 0) {
    lines.push(
      `Missing prerequisites detected: ${result.missingPrerequisites.join(', ')}. Consider asking the user before producing output.`,
    );
  }
  if (result.suggestedTools.length > 0) {
    lines.push(`Suggested tools: ${result.suggestedTools.join(', ')}`);
  }
  if (result.needsClarification && opts.allowClarification !== false) {
    lines.push('Heads up: the request is under-specified. A single clarifying question is cheaper than a wrong artefact.');
  }
  return lines.join('\n');
}

module.exports = {
  HOP_KINDS,
  OUTPUT_KIND_HINTS,
  TOOL_HINTS,
  reason,
  detectConstraints,
  detectPrerequisites,
  detectOutputKind,
  inferUserGoal,
  buildMultiHopPrompt,
};

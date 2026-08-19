'use strict';

/**
 * intent-planner.js
 *
 * Detects implicit sub-goals in a user request and produces an explicit
 * plan that the assistant can execute step-by-step.
 *
 * Background: Anthropic's circuit-tracing paper shows that LLMs sometimes
 * "plan ahead" several tokens before they emit them (e.g. choosing a rhyme
 * scheme line two before writing line one). We cannot inspect the model's
 * future plans directly, but we can detect when a user request *implies*
 * planning is needed (multi-output deliverables, sequential steps, branching
 * decisions) and pre-decompose the request into a plan node list.
 *
 * Each plan node has:
 *   { id, label, kind, depends_on, deliverable, estCost, optional }
 *
 * - `kind` ∈ {gather, analyze, decide, generate, verify, deliver}
 * - `estCost` is a rough relative cost in {low, medium, high}
 *
 * Pure heuristic, no LLM. The orchestrator can feed the plan into the
 * system prompt; the AI route may choose to execute one node per turn.
 */

const conceptExtractor = require('./concept-extractor');

const MAX_PLAN_NODES = 12;

const DELIVERABLE_PATTERNS = [
  { kind: 'document', test: /\b(?:documento|document|pdf|word|docx|report|reporte|informe|whitepaper|essay|ensayo)\b/i, cost: 'high' },
  { kind: 'spreadsheet', test: /\b(?:spreadsheet|excel|xlsx|csv|hoja\s+de\s+c[aá]lculo|tabla)\b/i, cost: 'medium' },
  { kind: 'slides', test: /\b(?:slides?|presentaci[oó]n|pptx|powerpoint|deck|pitch)\b/i, cost: 'high' },
  { kind: 'code', test: /\b(?:c[oó]digo|code|implementa|implement|funci[oó]n|function|m[oó]dulo|module|script)\b/i, cost: 'medium' },
  { kind: 'design', test: /\b(?:dise[ñn]o|design|figma|mockup|wireframe|prototipo|prototype|landing)\b/i, cost: 'high' },
  { kind: 'plan', test: /\b(?:plan|roadmap|cronograma|schedule|timeline|estrategia|strategy)\b/i, cost: 'medium' },
  { kind: 'analysis', test: /\b(?:analiza|analyze|an[aá]lisis|analysis|insight|hallazgo|finding)\b/i, cost: 'medium' },
  { kind: 'message', test: /\b(?:mensaje|message|correo|email|carta|letter|publicaci[oó]n|post|tuit|tweet)\b/i, cost: 'low' },
  { kind: 'visualization', test: /\b(?:gr[aá]fico|chart|gr[aá]fica|diagram|diagrama|infograf[ií]a|infographic|dashboard|kpi)\b/i, cost: 'medium' },
];

const SEQUENCE_MARKERS = [
  /\b(?:primero|paso\s+\d+|step\s+\d+|first[,]|then[,]?|despu[eé]s|luego|al\s+final|finally|por\s+[uú]ltimo|next|after\s+(?:that|you))\b/gi,
];

const BRANCH_MARKERS = [
  /\b(?:o(?:r|\s+sino)|either|cualquiera|whichever|si\s+(?:es|sirve|funciona)|if\s+(?:it|that)\s+(?:works|fits)|si\s+no|otherwise)\b/i,
];

const VERIFICATION_MARKERS = [
  /\b(?:test|prueba|verifica|verify|valida|validate|chequea|check|qa|quality\s+assurance|review|revisi[oó]n)\b/i,
];

// ── Helpers ────────────────────────────────────────────────────────────────

function safeText(s) { return String(s == null ? '' : s).slice(0, 4000); }

function detectDeliverables(prompt) {
  const out = [];
  const safe = safeText(prompt);
  for (const d of DELIVERABLE_PATTERNS) {
    const m = safe.match(d.test);
    if (m) out.push({ kind: d.kind, surface: m[0], cost: d.cost });
  }
  return out;
}

function countSequenceMarkers(prompt) {
  const safe = safeText(prompt);
  let n = 0;
  for (const re of SEQUENCE_MARKERS) {
    const matches = safe.match(re);
    if (matches) n += matches.length;
  }
  return n;
}

function hasBranching(prompt) {
  return BRANCH_MARKERS.some((re) => re.test(safeText(prompt)));
}

function hasVerification(prompt) {
  return VERIFICATION_MARKERS.some((re) => re.test(safeText(prompt)));
}

function makeNode(label, kind, opts = {}) {
  return {
    id: `node_${(opts.idx || 0) + 1}`,
    label: String(label || '').slice(0, 140),
    kind,
    depends_on: opts.depends_on || [],
    deliverable: opts.deliverable || null,
    estCost: opts.estCost || 'low',
    optional: !!opts.optional,
  };
}

// ── Main planner ───────────────────────────────────────────────────────────

function buildPlan({ prompt = '', history = [], files = [], memories = [] } = {}) {
  const safe = safeText(prompt);
  if (!safe.trim()) {
    return { planRequired: false, nodes: [], reasoning: 'empty prompt' };
  }

  const deliverables = detectDeliverables(safe);
  const seqMarkers = countSequenceMarkers(safe);
  const branching = hasBranching(safe);
  const verifying = hasVerification(safe);
  const { concepts } = conceptExtractor.extractConcepts(safe);
  const goalConcepts = concepts.filter((c) => c.type === 'goal').slice(0, 3);
  const namedEntities = concepts.filter((c) => c.kind === 'entity.named');
  const constraints = concepts.filter((c) => c.type === 'constraint');

  // Decide whether a plan is needed.
  const planRequired =
    deliverables.length >= 2 ||
    (deliverables.length === 1 && (seqMarkers >= 1 || branching || verifying)) ||
    goalConcepts.length >= 2 ||
    seqMarkers >= 2 ||
    /\b(?:plan|roadmap|paso\s+a\s+paso|step\s+by\s+step|fases|phases|milestones|sequence|secuencia)\b/i.test(safe);

  const nodes = [];
  if (!planRequired) {
    return {
      planRequired: false,
      nodes: [],
      deliverables,
      goalConcepts,
      reasoning: 'Request is single-deliverable, no sequencing, branching, or planning markers.',
    };
  }

  // Always start with gather + analyze of context.
  let idx = 0;
  if (files.length || history.length || memories.length) {
    nodes.push(makeNode('Gather relevant context: prior turns, attached files, active memory', 'gather', {
      idx: idx++,
      estCost: 'low',
    }));
  }

  if (constraints.length || namedEntities.length >= 2) {
    nodes.push(makeNode('Extract user constraints and named entities; treat each entity as a separate scope', 'analyze', {
      idx: idx++,
      depends_on: nodes.length ? [nodes[nodes.length - 1].id] : [],
      estCost: 'low',
    }));
  }

  if (branching) {
    nodes.push(makeNode('Surface decision branches to the user before generating; pick a default if no answer arrives', 'decide', {
      idx: idx++,
      depends_on: nodes.length ? [nodes[nodes.length - 1].id] : [],
      estCost: 'low',
    }));
  }

  // One generate node per deliverable.
  if (deliverables.length) {
    for (const d of deliverables) {
      nodes.push(makeNode(`Generate ${d.kind} (clue: "${d.surface}")`, 'generate', {
        idx: idx++,
        depends_on: nodes.length ? [nodes[nodes.length - 1].id] : [],
        deliverable: d.kind,
        estCost: d.cost,
      }));
      if (nodes.length >= MAX_PLAN_NODES - 2) break;
    }
  } else if (goalConcepts.length) {
    for (const g of goalConcepts) {
      nodes.push(makeNode(`Execute goal: ${g.surface}`, 'generate', {
        idx: idx++,
        depends_on: nodes.length ? [nodes[nodes.length - 1].id] : [],
        estCost: 'medium',
      }));
      if (nodes.length >= MAX_PLAN_NODES - 2) break;
    }
  } else {
    nodes.push(makeNode('Produce the requested output', 'generate', {
      idx: idx++,
      depends_on: nodes.length ? [nodes[nodes.length - 1].id] : [],
      estCost: 'medium',
    }));
  }

  if (verifying || deliverables.length >= 2) {
    nodes.push(makeNode('Verify each deliverable against the explicit constraints', 'verify', {
      idx: idx++,
      depends_on: nodes.length ? [nodes[nodes.length - 1].id] : [],
      estCost: 'low',
    }));
  }

  nodes.push(makeNode('Deliver consolidated response with traceability to the gathered context', 'deliver', {
    idx: idx++,
    depends_on: nodes.length ? [nodes[nodes.length - 1].id] : [],
    estCost: 'low',
  }));

  return {
    planRequired: true,
    nodes: nodes.slice(0, MAX_PLAN_NODES),
    deliverables,
    goalConcepts,
    metrics: {
      deliverables: deliverables.length,
      sequenceMarkers: seqMarkers,
      branching,
      verifying,
      namedEntities: namedEntities.length,
      constraints: constraints.length,
    },
    reasoning: planExplanation({ deliverables, seqMarkers, branching, verifying, goalConcepts }),
  };
}

function planExplanation({ deliverables = [], seqMarkers = 0, branching = false, verifying = false, goalConcepts = [] } = {}) {
  const reasons = [];
  if (deliverables.length >= 2) reasons.push(`${deliverables.length} distinct deliverables`);
  if (seqMarkers >= 1) reasons.push(`${seqMarkers} sequencing marker(s)`);
  if (branching) reasons.push('explicit decision branch');
  if (verifying) reasons.push('user asks for verification');
  if (goalConcepts.length >= 2) reasons.push(`${goalConcepts.length} stated goals`);
  return reasons.length ? `Plan triggered: ${reasons.join(' + ')}` : 'Plan triggered by heuristic combination.';
}

function renderPlanBlock(plan, opts = {}) {
  if (!plan || !plan.planRequired || !plan.nodes.length) return '';
  const lines = [];
  lines.push('## DERIVED EXECUTION PLAN');
  lines.push(`Reason: ${plan.reasoning}`);
  lines.push('Execute internally in order; you may parallelise nodes with disjoint dependencies. Do not skip the verify node.');
  for (const n of plan.nodes) {
    const dep = n.depends_on?.length ? ` [needs ${n.depends_on.join(',')}]` : '';
    const cost = n.estCost ? ` (cost=${n.estCost})` : '';
    lines.push(`- ${n.id} [${n.kind}]${dep}${cost}: ${n.label}${n.optional ? ' (optional)' : ''}`);
  }
  const cap = Math.max(700, Number(opts.maxChars) || 1800);
  const out = lines.join('\n');
  if (out.length > cap) return `${out.slice(0, cap - 80).trimEnd()}\n… [plan truncated]`;
  return out;
}

module.exports = {
  buildPlan,
  renderPlanBlock,
  detectDeliverables,
  DELIVERABLE_PATTERNS,
};

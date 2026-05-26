'use strict';

/**
 * Context Attribution Graph
 *
 * Inspired by Anthropic's "On the Biology of a Large Language Model" /
 * attribution graphs research (transformer-circuits.pub/2025/attribution-graphs).
 *
 * Builds a directed acyclic graph that explains WHICH signals from the user
 * query, chat history, memory, and attached documents contributed HOW MUCH
 * to an inferred intent. The graph has three layers, analogous to the paper:
 *
 *   surface signals  →  mid-level abstractions  →  inferred intents
 *
 * Each edge carries a contribution weight in [0, 1]. The graph is purely
 * heuristic (no LLM call) so it is cheap to compute on every turn and can
 * be persisted, audited, or rendered in the UI.
 */

const SIGNAL_TYPES = Object.freeze({
  IMPERATIVE: 'imperative',
  EXPLICIT_TOKEN: 'explicit_token',
  NAMED_ENTITY: 'named_entity',
  TEMPORAL_CUE: 'temporal_cue',
  QUANTITY_CUE: 'quantity_cue',
  EMOTIONAL_CUE: 'emotional_cue',
  REFERENCE_CUE: 'reference_cue',
  DOCUMENT_REF: 'document_ref',
  MEMORY_FACT: 'memory_fact',
  HISTORICAL: 'historical',
});

const INTENT_KINDS = Object.freeze({
  ANALYZE: 'analyze',
  GENERATE: 'generate',
  SEARCH: 'search',
  SUMMARIZE: 'summarize',
  TRANSLATE: 'translate',
  COMPARE: 'compare',
  EXTRACT: 'extract',
  EXPLAIN: 'explain',
  CODE: 'code',
  PLAN: 'plan',
  VISUALIZE: 'visualize',
  REVIEW: 'review',
  CONVERSE: 'converse',
});

const IMPERATIVE_TO_INTENT = Object.freeze({
  analyze: INTENT_KINDS.ANALYZE,
  analiza: INTENT_KINDS.ANALYZE,
  analizar: INTENT_KINDS.ANALYZE,
  review: INTENT_KINDS.REVIEW,
  revisa: INTENT_KINDS.REVIEW,
  revisar: INTENT_KINDS.REVIEW,
  audit: INTENT_KINDS.REVIEW,
  generate: INTENT_KINDS.GENERATE,
  genera: INTENT_KINDS.GENERATE,
  generar: INTENT_KINDS.GENERATE,
  create: INTENT_KINDS.GENERATE,
  crear: INTENT_KINDS.GENERATE,
  crea: INTENT_KINDS.GENERATE,
  make: INTENT_KINDS.GENERATE,
  haz: INTENT_KINDS.GENERATE,
  build: INTENT_KINDS.GENERATE,
  construir: INTENT_KINDS.GENERATE,
  construye: INTENT_KINDS.GENERATE,
  draft: INTENT_KINDS.GENERATE,
  write: INTENT_KINDS.GENERATE,
  escribe: INTENT_KINDS.GENERATE,
  escribir: INTENT_KINDS.GENERATE,
  redacta: INTENT_KINDS.GENERATE,
  implement: INTENT_KINDS.CODE,
  implementa: INTENT_KINDS.CODE,
  implementar: INTENT_KINDS.CODE,
  code: INTENT_KINDS.CODE,
  refactor: INTENT_KINDS.CODE,
  refactoriza: INTENT_KINDS.CODE,
  debug: INTENT_KINDS.CODE,
  fix: INTENT_KINDS.CODE,
  arregla: INTENT_KINDS.CODE,
  arreglar: INTENT_KINDS.CODE,
  corrige: INTENT_KINDS.CODE,
  search: INTENT_KINDS.SEARCH,
  busca: INTENT_KINDS.SEARCH,
  buscar: INTENT_KINDS.SEARCH,
  find: INTENT_KINDS.SEARCH,
  encuentra: INTENT_KINDS.SEARCH,
  encontrar: INTENT_KINDS.SEARCH,
  summarize: INTENT_KINDS.SUMMARIZE,
  summary: INTENT_KINDS.SUMMARIZE,
  resume: INTENT_KINDS.SUMMARIZE,
  resumir: INTENT_KINDS.SUMMARIZE,
  resumen: INTENT_KINDS.SUMMARIZE,
  translate: INTENT_KINDS.TRANSLATE,
  traduce: INTENT_KINDS.TRANSLATE,
  traducir: INTENT_KINDS.TRANSLATE,
  compare: INTENT_KINDS.COMPARE,
  compara: INTENT_KINDS.COMPARE,
  comparar: INTENT_KINDS.COMPARE,
  contrast: INTENT_KINDS.COMPARE,
  diff: INTENT_KINDS.COMPARE,
  extract: INTENT_KINDS.EXTRACT,
  extrae: INTENT_KINDS.EXTRACT,
  extraer: INTENT_KINDS.EXTRACT,
  parse: INTENT_KINDS.EXTRACT,
  explain: INTENT_KINDS.EXPLAIN,
  explica: INTENT_KINDS.EXPLAIN,
  explicar: INTENT_KINDS.EXPLAIN,
  describe: INTENT_KINDS.EXPLAIN,
  describir: INTENT_KINDS.EXPLAIN,
  plan: INTENT_KINDS.PLAN,
  planea: INTENT_KINDS.PLAN,
  planear: INTENT_KINDS.PLAN,
  roadmap: INTENT_KINDS.PLAN,
  visualize: INTENT_KINDS.VISUALIZE,
  visualiza: INTENT_KINDS.VISUALIZE,
  chart: INTENT_KINDS.VISUALIZE,
  diagram: INTENT_KINDS.VISUALIZE,
  diagrama: INTENT_KINDS.VISUALIZE,
  grafica: INTENT_KINDS.VISUALIZE,
});

const TEMPORAL_TERMS = [
  'today',
  'tomorrow',
  'yesterday',
  'now',
  'soon',
  'urgent',
  'asap',
  'inmediato',
  'hoy',
  'ahora',
  'mañana',
  'ayer',
  'pronto',
  'urgente',
  'antes de',
  'before',
  'after',
  'this week',
  'esta semana',
  'next week',
  'próxima semana',
  'este mes',
  'this month',
];

const EMOTION_TERMS = [
  'please',
  'por favor',
  'urgent',
  'urgente',
  'critical',
  'crítico',
  'important',
  'importante',
  'help',
  'ayuda',
  'broken',
  'roto',
  'failing',
  'fallando',
  'stuck',
  'atascado',
  'frustrated',
  'frustrado',
];

const REFERENCE_PHRASES = [
  /\bthat (one|file|doc|document|chart|table)\b/i,
  /\beste (archivo|documento|gráfico|tabla)\b/i,
  /\bel anterior\b/i,
  /\bthe previous\b/i,
  /\babove\b/i,
  /\barriba\b/i,
  /\blast (message|response|answer)\b/i,
  /\búltimo (mensaje|respuesta)\b/i,
];

function clamp(value, min = 0, max = 1) {
  if (Number.isNaN(value) || value == null) return min;
  return Math.max(min, Math.min(max, value));
}

function makeId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function makeSignal(type, value, weight, opts = {}) {
  return {
    id: makeId('sig'),
    layer: 'surface',
    type,
    value,
    weight: clamp(weight, 0, 1),
    source: opts.source || 'query',
    span: opts.span || null,
    metadata: opts.metadata || {},
  };
}

function makeAbstraction(label, weight, supports = [], opts = {}) {
  return {
    id: makeId('abs'),
    layer: 'abstraction',
    label,
    weight: clamp(weight, 0, 1),
    supports,
    metadata: opts.metadata || {},
  };
}

function makeIntent(kind, weight, supports = [], opts = {}) {
  return {
    id: makeId('int'),
    layer: 'intent',
    kind,
    weight: clamp(weight, 0, 1),
    supports,
    metadata: opts.metadata || {},
  };
}

function extractImperative(query) {
  if (!query) return null;
  const text = String(query).trim().toLowerCase();
  if (!text) return null;

  const leading = text.match(/^(?:por favor|please|hey,?\s+)?(?:can you|could you|would you|puedes|podrías)?\s*([a-záéíóúñ]+)/i);
  const firstVerb = leading?.[1] || (text.split(/\s+/)[0] || '').replace(/[^a-záéíóúñ]/g, '');
  if (firstVerb && IMPERATIVE_TO_INTENT[firstVerb]) {
    return { verb: firstVerb, intent: IMPERATIVE_TO_INTENT[firstVerb] };
  }

  for (const token of text.split(/\s+/)) {
    const clean = token.replace(/[^a-záéíóúñ]/g, '');
    if (clean && IMPERATIVE_TO_INTENT[clean]) {
      return { verb: clean, intent: IMPERATIVE_TO_INTENT[clean] };
    }
  }
  return null;
}

function extractNamedEntities(query) {
  if (!query || typeof query !== 'string') return [];
  const entities = new Set();

  const url = query.match(/https?:\/\/[^\s)]+/g);
  if (url) url.forEach((u) => entities.add(u));

  const proper = query.match(/\b[A-Z][a-zA-Z0-9]{2,}(?:\s+[A-Z][a-zA-Z0-9]+){0,3}\b/g);
  if (proper) {
    for (const cand of proper) {
      if (cand.length >= 3 && cand.length <= 80) entities.add(cand);
    }
  }

  const quoted = query.match(/"([^"]{2,80})"/g);
  if (quoted) quoted.forEach((q) => entities.add(q.replace(/^"|"$/g, '')));

  const tags = query.match(/#[A-Za-z0-9_]{2,30}/g);
  if (tags) tags.forEach((t) => entities.add(t));

  return [...entities].slice(0, 12);
}

function extractTemporalCues(query) {
  const text = String(query || '').toLowerCase();
  const found = new Set();
  for (const term of TEMPORAL_TERMS) {
    if (text.includes(term)) found.add(term);
  }
  if (/\b(?:20\d{2}|19\d{2})\b/.test(text)) found.add('explicit_year');
  if (/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/.test(text)) found.add('explicit_date');
  return [...found];
}

function extractQuantityCues(query) {
  if (!query) return [];
  const matches = query.match(/\b\d+(?:[.,]\d+)?\s*(?:%|percent|usd|eur|mxn|k|m|b|million|billion|miles|millones)?/gi);
  return matches ? matches.slice(0, 8) : [];
}

function extractEmotionalCues(query) {
  const text = String(query || '').toLowerCase();
  const found = new Set();
  for (const term of EMOTION_TERMS) {
    if (text.includes(term)) found.add(term);
  }
  if (/!{2,}/.test(query || '')) found.add('exclamation_emphasis');
  if (/\?{2,}/.test(query || '')) found.add('question_emphasis');
  return [...found];
}

function extractReferenceCues(query) {
  if (!query) return [];
  const found = [];
  for (const pattern of REFERENCE_PHRASES) {
    const m = String(query).match(pattern);
    if (m) found.push(m[0]);
  }
  return found;
}

function buildSurfaceSignals(query, context = {}) {
  const signals = [];
  if (!query) return signals;

  const imperative = extractImperative(query);
  if (imperative) {
    signals.push(
      makeSignal(SIGNAL_TYPES.IMPERATIVE, imperative.verb, 0.92, {
        metadata: { mapsTo: imperative.intent },
      }),
    );
  }

  for (const entity of extractNamedEntities(query)) {
    signals.push(makeSignal(SIGNAL_TYPES.NAMED_ENTITY, entity, 0.78));
  }

  for (const cue of extractTemporalCues(query)) {
    signals.push(makeSignal(SIGNAL_TYPES.TEMPORAL_CUE, cue, 0.55));
  }

  for (const cue of extractQuantityCues(query)) {
    signals.push(makeSignal(SIGNAL_TYPES.QUANTITY_CUE, cue, 0.45));
  }

  for (const cue of extractEmotionalCues(query)) {
    signals.push(makeSignal(SIGNAL_TYPES.EMOTIONAL_CUE, cue, 0.4));
  }

  for (const cue of extractReferenceCues(query)) {
    signals.push(makeSignal(SIGNAL_TYPES.REFERENCE_CUE, cue, 0.7));
  }

  const documents = Array.isArray(context.documents) ? context.documents : [];
  for (const doc of documents.slice(0, 6)) {
    const name = doc?.name || doc?.fileName || doc?.id || 'document';
    signals.push(
      makeSignal(SIGNAL_TYPES.DOCUMENT_REF, name, 0.85, {
        source: 'documents',
        metadata: { mime: doc?.mime || doc?.mimeType || null },
      }),
    );
  }

  const memoryFacts = Array.isArray(context.memoryFacts) ? context.memoryFacts : [];
  for (const fact of memoryFacts.slice(0, 6)) {
    signals.push(
      makeSignal(SIGNAL_TYPES.MEMORY_FACT, String(fact).slice(0, 160), 0.6, {
        source: 'memory',
      }),
    );
  }

  const history = Array.isArray(context.history) ? context.history : [];
  for (const turn of history.slice(-3)) {
    const summary = String(turn?.content || turn || '').slice(0, 120);
    if (summary) {
      signals.push(
        makeSignal(SIGNAL_TYPES.HISTORICAL, summary, 0.45, {
          source: 'history',
          metadata: { role: turn?.role || 'user' },
        }),
      );
    }
  }

  return signals;
}

function buildAbstractions(signals) {
  const abstractions = [];

  const imperativeSignals = signals.filter((s) => s.type === SIGNAL_TYPES.IMPERATIVE);
  if (imperativeSignals.length > 0) {
    const top = imperativeSignals[0];
    abstractions.push(
      makeAbstraction(`action:${top.value}`, 0.9, [top.id], {
        metadata: { mapsTo: top.metadata?.mapsTo || null },
      }),
    );
  }

  const entitySignals = signals.filter((s) => s.type === SIGNAL_TYPES.NAMED_ENTITY);
  if (entitySignals.length > 0) {
    abstractions.push(
      makeAbstraction(
        'subject:entities',
        Math.min(0.9, 0.5 + entitySignals.length * 0.08),
        entitySignals.map((s) => s.id),
        { metadata: { entities: entitySignals.map((s) => s.value) } },
      ),
    );
  }

  const docSignals = signals.filter((s) => s.type === SIGNAL_TYPES.DOCUMENT_REF);
  if (docSignals.length > 0) {
    abstractions.push(
      makeAbstraction(
        'scope:documents',
        Math.min(0.95, 0.6 + docSignals.length * 0.08),
        docSignals.map((s) => s.id),
        { metadata: { documentCount: docSignals.length } },
      ),
    );
  }

  const memorySignals = signals.filter((s) => s.type === SIGNAL_TYPES.MEMORY_FACT);
  if (memorySignals.length > 0) {
    abstractions.push(
      makeAbstraction(
        'context:memory',
        Math.min(0.8, 0.4 + memorySignals.length * 0.06),
        memorySignals.map((s) => s.id),
      ),
    );
  }

  const histSignals = signals.filter((s) => s.type === SIGNAL_TYPES.HISTORICAL);
  if (histSignals.length > 0) {
    abstractions.push(
      makeAbstraction('context:history', 0.45, histSignals.map((s) => s.id)),
    );
  }

  const refSignals = signals.filter((s) => s.type === SIGNAL_TYPES.REFERENCE_CUE);
  if (refSignals.length > 0) {
    abstractions.push(
      makeAbstraction('coreference', 0.75, refSignals.map((s) => s.id), {
        metadata: { needsResolution: true },
      }),
    );
  }

  const tempSignals = signals.filter((s) => s.type === SIGNAL_TYPES.TEMPORAL_CUE);
  if (tempSignals.length > 0) {
    abstractions.push(
      makeAbstraction('modifier:temporal', 0.5, tempSignals.map((s) => s.id)),
    );
  }

  const emoSignals = signals.filter((s) => s.type === SIGNAL_TYPES.EMOTIONAL_CUE);
  if (emoSignals.length > 0) {
    abstractions.push(
      makeAbstraction('modifier:urgency', 0.45, emoSignals.map((s) => s.id)),
    );
  }

  return abstractions;
}

function buildIntents(signals, abstractions) {
  const intentBuckets = new Map();
  const addToIntent = (kind, weight, supportingId) => {
    if (!kind) return;
    const existing = intentBuckets.get(kind);
    if (!existing) {
      intentBuckets.set(kind, { weight, supports: [supportingId] });
    } else {
      existing.weight = clamp(existing.weight + weight * 0.5, 0, 1);
      existing.supports.push(supportingId);
    }
  };

  for (const abs of abstractions) {
    const mapped = abs.metadata?.mapsTo;
    if (mapped) addToIntent(mapped, abs.weight, abs.id);
    if (abs.label === 'scope:documents') {
      addToIntent(INTENT_KINDS.ANALYZE, 0.3, abs.id);
      addToIntent(INTENT_KINDS.SUMMARIZE, 0.2, abs.id);
    }
    if (abs.label === 'coreference') {
      addToIntent(INTENT_KINDS.EXPLAIN, 0.25, abs.id);
    }
    if (abs.label === 'modifier:urgency') {
      for (const intent of intentBuckets.values()) {
        intent.weight = clamp(intent.weight + 0.05, 0, 1);
      }
    }
  }

  if (intentBuckets.size === 0) {
    const fallback = signals.length > 0 ? INTENT_KINDS.CONVERSE : INTENT_KINDS.CONVERSE;
    addToIntent(fallback, 0.4, signals[0]?.id || 'none');
  }

  const intents = [];
  for (const [kind, data] of intentBuckets.entries()) {
    intents.push(makeIntent(kind, data.weight, data.supports));
  }
  intents.sort((a, b) => b.weight - a.weight);
  return intents;
}

function buildEdges(signals, abstractions, intents) {
  const edges = [];
  for (const abs of abstractions) {
    for (const supportId of abs.supports) {
      const signal = signals.find((s) => s.id === supportId);
      if (!signal) continue;
      edges.push({
        from: supportId,
        to: abs.id,
        weight: clamp(signal.weight * 0.8 + abs.weight * 0.2, 0, 1),
      });
    }
  }
  for (const intent of intents) {
    for (const supportId of intent.supports) {
      const abs = abstractions.find((a) => a.id === supportId);
      const weight = abs ? clamp(abs.weight * 0.6 + intent.weight * 0.4, 0, 1) : intent.weight;
      edges.push({ from: supportId, to: intent.id, weight });
    }
  }
  return edges;
}

function buildGraph(query, context = {}) {
  const signals = buildSurfaceSignals(query, context);
  const abstractions = buildAbstractions(signals);
  const intents = buildIntents(signals, abstractions);
  const edges = buildEdges(signals, abstractions, intents);

  const primaryIntent = intents[0] || null;
  const confidence = primaryIntent ? primaryIntent.weight : 0;

  return {
    query: String(query || '').slice(0, 500),
    signals,
    abstractions,
    intents,
    edges,
    primaryIntent: primaryIntent
      ? { id: primaryIntent.id, kind: primaryIntent.kind, weight: primaryIntent.weight }
      : null,
    confidence,
    createdAt: Date.now(),
  };
}

function topContributors(graph, limit = 5) {
  if (!graph || !graph.signals) return [];
  return [...graph.signals]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map((s) => ({ type: s.type, value: s.value, weight: Number(s.weight.toFixed(3)) }));
}

function buildAttributionPrompt(graph, opts = {}) {
  if (!graph || !graph.primaryIntent) return '';
  const lines = ['### Context Attribution'];
  lines.push(
    `Primary inferred intent: **${graph.primaryIntent.kind}** (confidence ${Math.round(graph.confidence * 100)}%)`,
  );

  const alternates = graph.intents
    .slice(1, 3)
    .map((i) => `${i.kind} (${Math.round(i.weight * 100)}%)`);
  if (alternates.length > 0) {
    lines.push(`Alternate intents considered: ${alternates.join(', ')}`);
  }

  const contributors = topContributors(graph, opts.limit || 5);
  if (contributors.length > 0) {
    lines.push('Key signals that drove this interpretation:');
    for (const c of contributors) {
      const v = typeof c.value === 'string' ? c.value.slice(0, 80) : String(c.value);
      lines.push(`- ${c.type} → "${v}" (weight ${c.weight})`);
    }
  }

  lines.push(
    'If the primary intent feels wrong, ask one clarifying question rather than guessing — the user can correct course cheaply now.',
  );

  return lines.join('\n');
}

module.exports = {
  SIGNAL_TYPES,
  INTENT_KINDS,
  buildGraph,
  buildSurfaceSignals,
  buildAbstractions,
  buildIntents,
  topContributors,
  buildAttributionPrompt,
};

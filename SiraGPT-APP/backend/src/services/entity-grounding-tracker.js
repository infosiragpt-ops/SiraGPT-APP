'use strict';

/**
 * Entity Grounding Tracker
 *
 * Inspired by the attribution-graphs paper's "entity recognition" circuits:
 * the model has features that fire when a named entity appears in context vs
 * when it is being introduced for the first time. We approximate the same
 * distinction by surface-matching extracted entities (people, orgs, places,
 * products, numbers, URLs) against the available context (documents, memory,
 * chat history, user query) and tagging each as:
 *
 *   - grounded_current_turn: appears in the user's current message
 *   - grounded_documents:    appears in attached docs / RAG context
 *   - grounded_memory:       appears in active memory
 *   - grounded_history:      appears in prior chat history
 *   - newly_introduced:      appears only in the agent's draft
 *
 * Newly-introduced entities are confabulation suspects and should be
 * verified or hedged before being asserted.
 */

const ENTITY_PATTERNS = Object.freeze([
  { kind: 'url', re: /https?:\/\/[^\s)]+/g },
  { kind: 'email', re: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g },
  { kind: 'phone', re: /\+?\d{1,3}[ -]?\(?\d{2,4}\)?[ -]?\d{3,4}[ -]?\d{3,4}\b/g },
  { kind: 'money', re: /(?:USD|EUR|MXN|GBP|\$|€|£)\s*\d+(?:[.,]\d+)?(?:\s*(?:million|billion|k|m|b|miles|millones))?/gi },
  { kind: 'percent', re: /\b\d+(?:[.,]\d+)?\s*%/g },
  { kind: 'date', re: /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g },
  { kind: 'year', re: /\b(?:20\d{2}|19\d{2})\b/g },
  { kind: 'proper_noun', re: /\b[A-Z][a-zA-Z0-9]{2,}(?:\s+[A-Z][a-zA-Z0-9]+){0,3}\b/g },
  { kind: 'acronym', re: /\b[A-Z]{2,6}\b/g },
  { kind: 'hashtag', re: /#[A-Za-z0-9_]{2,30}/g },
  { kind: 'mention', re: /@[A-Za-z0-9_.]{2,30}/g },
]);

const STOP_PROPER_NOUNS = new Set([
  'I',
  'You',
  'We',
  'They',
  'He',
  'She',
  'It',
  'The',
  'A',
  'An',
  'This',
  'That',
  'These',
  'Those',
  'Yes',
  'No',
  'Ok',
  'OK',
  'Yo',
  'Tu',
  'Tú',
  'Usted',
  'Nosotros',
  'Vosotros',
  'Ellos',
  'Ellas',
  'El',
  'Él',
  'La',
  'Los',
  'Las',
  'Este',
  'Esta',
  'Estos',
  'Estas',
  'Eso',
  'Esa',
]);

function clamp(value, min = 0, max = 1) {
  if (value == null || Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function extractEntities(text) {
  if (!text || typeof text !== 'string') return [];
  const found = new Map();
  for (const pattern of ENTITY_PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = m[0].trim();
      if (!value) continue;
      if (pattern.kind === 'proper_noun' && STOP_PROPER_NOUNS.has(value)) continue;
      if (pattern.kind === 'acronym' && value.length < 2) continue;
      const key = `${pattern.kind}::${value.toLowerCase()}`;
      const existing = found.get(key);
      if (existing) {
        existing.occurrences += 1;
      } else {
        found.set(key, { kind: pattern.kind, value, occurrences: 1, firstOffset: m.index });
      }
      if (found.size >= 100) break;
    }
    if (found.size >= 100) break;
  }
  return [...found.values()];
}

function searchIn(value, text) {
  if (!value || !text) return 0;
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'gi');
  return (String(text).match(re) || []).length;
}

function classifyEntity(entity, sources) {
  const groundings = [];
  if (sources.currentTurn && searchIn(entity.value, sources.currentTurn) > 0) {
    groundings.push('current_turn');
  }
  if (sources.documents && searchIn(entity.value, sources.documents) > 0) {
    groundings.push('documents');
  }
  if (sources.memory && searchIn(entity.value, sources.memory) > 0) {
    groundings.push('memory');
  }
  if (sources.history && searchIn(entity.value, sources.history) > 0) {
    groundings.push('history');
  }

  let status;
  let confidence;
  if (groundings.length === 0) {
    status = 'newly_introduced';
    confidence = 0.3;
  } else if (groundings.includes('current_turn') || groundings.includes('documents')) {
    status = 'strongly_grounded';
    confidence = clamp(0.8 + groundings.length * 0.05);
  } else if (groundings.includes('memory')) {
    status = 'memory_grounded';
    confidence = clamp(0.65 + groundings.length * 0.05);
  } else {
    status = 'history_grounded';
    confidence = 0.55;
  }

  return {
    ...entity,
    status,
    confidence: Number(confidence.toFixed(3)),
    groundings,
    suggestedAction:
      status === 'newly_introduced'
        ? 'verify_before_asserting'
        : status === 'history_grounded'
        ? 'restate_with_context_reference'
        : 'ok',
  };
}

function trackEntities(text, context = {}) {
  const entities = extractEntities(text);

  const sources = {
    currentTurn: context.currentTurn || context.userQuery || '',
    documents: (Array.isArray(context.documents) ? context.documents : [])
      .map((d) => `${d?.name || ''} ${d?.summary || ''} ${d?.text || ''}`)
      .join('\n'),
    memory: (Array.isArray(context.memoryFacts) ? context.memoryFacts : []).join('\n'),
    history: (Array.isArray(context.history) ? context.history : [])
      .map((t) => (typeof t === 'string' ? t : t?.content || ''))
      .join('\n'),
  };

  const classified = entities.map((e) => classifyEntity(e, sources));

  const counts = classified.reduce(
    (acc, e) => {
      acc.total += 1;
      acc[e.status] = (acc[e.status] || 0) + 1;
      return acc;
    },
    { total: 0 },
  );

  const newlyIntroduced = classified.filter((e) => e.status === 'newly_introduced');
  const groundingRate = entities.length === 0 ? 1 : 1 - newlyIntroduced.length / entities.length;

  let severity = 'low';
  if (groundingRate < 0.4) severity = 'high';
  else if (groundingRate < 0.7) severity = 'medium';

  return {
    entities: classified,
    counts,
    groundingRate: Number(groundingRate.toFixed(3)),
    severity,
    summary: summarize(classified, groundingRate),
  };
}

function summarize(classified, groundingRate) {
  if (!classified.length) return 'no entities detected';
  const grounded = classified.filter((e) => e.status !== 'newly_introduced').length;
  return `${classified.length} entities · grounded=${grounded} (${Math.round(groundingRate * 100)}%)`;
}

function buildEntityGroundingPrompt(result, opts = {}) {
  if (!result || !result.entities?.length) return '';
  const lines = ['### Entity Grounding'];
  lines.push(`Grounding scan: ${result.summary}`);
  const newlyIntroduced = result.entities
    .filter((e) => e.status === 'newly_introduced')
    .slice(0, opts.limit || 5);
  if (newlyIntroduced.length > 0) {
    lines.push('Entities you would be introducing without grounding — verify before stating as fact:');
    for (const e of newlyIntroduced) {
      lines.push(`- (${e.kind}) ${String(e.value).slice(0, 80)} → ${e.suggestedAction}`);
    }
  }
  if (result.severity === 'high') {
    lines.push('Most entities lack grounding. Either (a) ask the user, (b) fetch real sources, or (c) hedge each one.');
  }
  return lines.join('\n');
}

module.exports = {
  ENTITY_PATTERNS,
  extractEntities,
  trackEntities,
  classifyEntity,
  buildEntityGroundingPrompt,
};

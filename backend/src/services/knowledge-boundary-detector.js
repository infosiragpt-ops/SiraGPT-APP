'use strict';

/**
 * Knowledge Boundary Detector
 *
 * Inspired by the attribution-graphs paper's findings on "known/unknown
 * entity" features and confabulation circuits — the parts of the model that
 * fire when it is genuinely retrieving vs filling in a plausible-sounding
 * answer it does not actually have.
 *
 * For each candidate claim (extracted by surface heuristics from a user
 * query or model draft answer), we ask: does the agent have grounding for
 * this in the available context — RAG documents, attached files, active
 * memory, chat history, or explicit user statements? Claims with no
 * grounding are flagged as confabulation risks, with a suggested action.
 *
 * Heuristic-only; no LLM calls. Designed to run on every turn at sub-ms
 * latency so it can gate response generation.
 */

const CLAIM_PATTERNS = Object.freeze([
  { kind: 'number_claim', re: /\b\d+(?:[.,]\d+)?\s*(?:%|percent|usd|eur|mxn|million|billion|miles|millones)\b/gi },
  { kind: 'date_claim', re: /\b(?:20\d{2}|19\d{2})\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g },
  { kind: 'named_entity_claim', re: /\b[A-Z][a-zA-Z0-9]{2,}(?:\s+[A-Z][a-zA-Z0-9]+){0,3}\b/g },
  { kind: 'url_claim', re: /https?:\/\/[^\s)]+/g },
  { kind: 'quotation', re: /"([^"]{6,200})"/g },
]);

const HEDGE_TERMS = [
  'might',
  'maybe',
  'perhaps',
  'possibly',
  'could be',
  'i think',
  'creo',
  'tal vez',
  'quizá',
  'quizás',
  'posiblemente',
  'puede ser',
  'parece',
  'seems',
  'appears',
  'reportedly',
];

const ASSERTION_VERBS = [
  'is',
  'are',
  'was',
  'were',
  'has',
  'have',
  'had',
  'will',
  'must',
  'grew',
  'fell',
  'rose',
  'dropped',
  'increased',
  'decreased',
  'gained',
  'lost',
  'reached',
  'reported',
  'announced',
  'launched',
  'acquired',
  'signed',
  'closed',
  'raised',
  'declined',
  'expanded',
  'released',
  'shipped',
  'es',
  'son',
  'era',
  'eran',
  'fue',
  'fueron',
  'tiene',
  'tienen',
  'tendrá',
  'será',
  'creció',
  'cayó',
  'subió',
  'aumentó',
  'disminuyó',
  'alcanzó',
  'anunció',
  'adquirió',
  'reportó',
];

function clamp(value, min = 0, max = 1) {
  if (value == null || Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function buildContextHaystack(context = {}) {
  const parts = [];

  const documents = Array.isArray(context.documents) ? context.documents : [];
  for (const doc of documents) {
    if (doc?.text) parts.push(String(doc.text));
    if (doc?.summary) parts.push(String(doc.summary));
    if (doc?.name) parts.push(String(doc.name));
  }

  const memoryFacts = Array.isArray(context.memoryFacts) ? context.memoryFacts : [];
  for (const fact of memoryFacts) parts.push(String(fact));

  const history = Array.isArray(context.history) ? context.history : [];
  for (const turn of history) {
    const content = typeof turn === 'string' ? turn : turn?.content;
    if (content) parts.push(String(content));
  }

  if (context.userQuery) parts.push(String(context.userQuery));
  if (context.systemPrompt) parts.push(String(context.systemPrompt));

  return parts.join('\n');
}

function extractClaims(text) {
  if (!text || typeof text !== 'string') return [];
  const claims = [];
  const seen = new Set();

  for (const pattern of CLAIM_PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = (m[1] || m[0]).trim();
      if (!value) continue;
      const key = `${pattern.kind}::${value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push({
        kind: pattern.kind,
        value,
        offset: m.index,
        contextSnippet: text.slice(Math.max(0, m.index - 32), m.index + value.length + 32),
      });
      if (claims.length >= 50) break;
    }
    if (claims.length >= 50) break;
  }

  return claims;
}

function hedgePresence(snippet) {
  if (!snippet) return false;
  const lower = snippet.toLowerCase();
  return HEDGE_TERMS.some((t) => lower.includes(t));
}

function assertionStrength(snippet) {
  if (!snippet) return 0.5;
  const lower = snippet.toLowerCase();
  let strength = 0.4;
  for (const verb of ASSERTION_VERBS) {
    if (new RegExp(`\\b${verb}\\b`, 'i').test(lower)) {
      strength += 0.2;
      break;
    }
  }
  if (hedgePresence(lower)) strength -= 0.25;
  if (/!{1,}/.test(snippet)) strength += 0.05;
  return clamp(strength);
}

function findGrounding(claim, haystack) {
  if (!claim?.value || !haystack) return { found: false, occurrences: 0 };
  const escaped = claim.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'gi');
  const matches = haystack.match(re);
  if (!matches) return { found: false, occurrences: 0 };
  return { found: true, occurrences: matches.length };
}

function classifyClaim(claim, haystack) {
  const grounding = findGrounding(claim, haystack);
  const strength = assertionStrength(claim.contextSnippet);
  const hedged = hedgePresence(claim.contextSnippet);

  let status;
  let confidence;
  let action;

  if (grounding.found && grounding.occurrences >= 1) {
    status = 'grounded';
    confidence = clamp(0.7 + Math.min(grounding.occurrences, 5) * 0.05);
    action = 'cite_source';
  } else if (hedged) {
    status = 'hedged_uncertain';
    confidence = clamp(0.55 - strength * 0.3);
    action = 'either_verify_or_keep_hedged';
  } else if (strength >= 0.55) {
    status = 'ungrounded_assertion';
    confidence = clamp(0.65 + strength * 0.2);
    action = 'verify_or_hedge';
  } else {
    status = 'low_confidence_mention';
    confidence = 0.4;
    action = 'no_action_needed';
  }

  return {
    ...claim,
    status,
    confidence,
    assertionStrength: Number(strength.toFixed(3)),
    grounded: grounding.found,
    groundingOccurrences: grounding.occurrences,
    action,
  };
}

function detectBoundaries(text, context = {}) {
  const claims = extractClaims(text);
  const haystack = buildContextHaystack(context);
  const classified = claims.map((c) => classifyClaim(c, haystack));

  const counts = classified.reduce(
    (acc, c) => {
      acc.total += 1;
      acc[c.status] = (acc[c.status] || 0) + 1;
      return acc;
    },
    { total: 0 },
  );

  const ungroundedCount = counts.ungrounded_assertion || 0;
  const riskScore = clamp(
    ungroundedCount === 0
      ? 0
      : Math.min(0.95, 0.2 + ungroundedCount * 0.12 + (counts.hedged_uncertain || 0) * 0.04),
  );

  let severity = 'low';
  if (riskScore >= 0.7) severity = 'high';
  else if (riskScore >= 0.4) severity = 'medium';

  return {
    claims: classified,
    counts,
    riskScore: Number(riskScore.toFixed(3)),
    severity,
    summary: summarize(classified, severity),
  };
}

function summarize(classified, severity) {
  if (!classified.length) return 'No verifiable claims detected.';
  const grounded = classified.filter((c) => c.status === 'grounded').length;
  const ungrounded = classified.filter((c) => c.status === 'ungrounded_assertion').length;
  const hedged = classified.filter((c) => c.status === 'hedged_uncertain').length;
  return `${classified.length} claims · grounded=${grounded}, ungrounded=${ungrounded}, hedged=${hedged} · severity=${severity}`;
}

function buildKnowledgeBoundaryPrompt(result, opts = {}) {
  if (!result || !result.claims?.length) return '';
  const lines = ['### Knowledge Boundary'];
  lines.push(`Boundary scan: ${result.summary}`);
  const ungrounded = result.claims
    .filter((c) => c.status === 'ungrounded_assertion')
    .slice(0, opts.limit || 5);
  if (ungrounded.length > 0) {
    lines.push('Claims without grounding in available context — verify or hedge:');
    for (const c of ungrounded) {
      lines.push(`- (${c.kind}) "${String(c.value).slice(0, 80)}" → ${c.action}`);
    }
  }
  if (result.severity === 'high') {
    lines.push(
      'High confabulation risk. Prefer "according to the data provided…" framing, or ask the user to confirm specifics before stating them as fact.',
    );
  }
  return lines.join('\n');
}

module.exports = {
  extractClaims,
  detectBoundaries,
  classifyClaim,
  buildKnowledgeBoundaryPrompt,
};

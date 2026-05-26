'use strict';

/**
 * document-claim-attribution.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Given a candidate claim sentence (from document-deep-analyzer) and the
 * named entities extracted from the same document (from
 * document-insights-engine), figure out *who* is making the claim:
 *
 *    "According to Acme Corp, revenue grew 24%."
 *      → { source: "Acme Corp", sourceType: "org", anchor: "according to",
 *          confidence: 0.92 }
 *
 *    "Maria Solís reports that the deadline shifted to 2026-07-15."
 *      → { source: "Maria Solís", sourceType: "person", anchor: "reports", ... }
 *
 *    "Revenue grew 24% in Q3."
 *      → { source: null, sourceType: "document", confidence: 0.4 }
 *      (no attribution → defaults to the document itself)
 *
 * Why deterministic:
 *   The deep-analyzer is sync + deterministic by contract. Attribution
 *   must match that profile so the whole "DEEP DOCUMENT ANALYSIS" block
 *   stays sync, < 15 ms, no LLM, no network.
 *
 * Bilingual (Spanish / English). No external deps.
 *
 * Public API:
 *   attributeClaim(sentence, opts)  →  AttributionResult
 *   annotateClaims(claims, opts)    →  AttributionResult[]
 */

const ATTRIBUTION_ANCHORS = [
  // Pre-anchor: ANCHOR + (the) + NAME
  // Spanish
  { re: /\bseg[úu]n\s+(?:el|la|los|las|los? estudios? de\s+)?([A-ZÁÉÍÓÚÑ][^.,;:]{1,60}?)(?=[.,;:]|\s+(?:afirma|sostiene|reporta|indica|cree|dice|estima|asegura|publica)\b|$)/i, anchor: 'según', conf: 0.9 },
  { re: /\bde acuerdo (?:a|con)\s+([A-ZÁÉÍÓÚÑ][^.,;:]{1,60}?)(?=[.,;:]|$)/i, anchor: 'de acuerdo con', conf: 0.88 },
  // English
  { re: /\baccording to\s+([A-Z][^.,;:]{1,60}?)(?=[.,;:]|\s+(?:said|says|stated|reported|noted)\b|$)/i, anchor: 'according to', conf: 0.92 },
  { re: /\bper\s+([A-Z][^.,;:]{1,60}?)(?=[.,;:]|$)/i, anchor: 'per', conf: 0.7 },
  { re: /\bas (?:reported|noted|stated) by\s+([A-Z][^.,;:]{1,60}?)(?=[.,;:]|$)/i, anchor: 'as reported by', conf: 0.9 },
];

// Post-anchor: NAME + verb. We match the noun phrase BEFORE the verb.
const POST_ANCHOR_VERBS = {
  // Spanish — captured group is the subject (1–4 capitalised tokens, optionally
  // preceded by a determiner like "El/La" which we strip).
  es: /(?:^|[.;]\s+)(?:el|la|los|las\s+)?([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ.-]+(?:\s+[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ.-]+){0,3})\s+(?:afirma|afirmó|sostiene|sostuvo|reporta|report[óo]|indica|indic[óo]|estima|estim[óo]|asegura|asegur[óo]|publica|publicó|dice|dijo|cree|crey[óo])\b/,
  en: /(?:^|[.;]\s+)([A-Z][\w.-]+(?:\s+[A-Z][\w.-]+){0,3})\s+(?:said|says|stated|reported|reports?|notes?|noted|finds?|found|shows?|showed|concludes?|concluded|estimates?|estimated|announces?|announced)\b/,
};

const COMMON_DET = /^(?:the|a|an|el|la|los|las|un|una)\s+/i;
const TRAILING_FILLER = /\b(?:que|en|to|para|de|del|of|in|on|at|for)\s*$/i;

function cleanCandidate(s) {
  if (!s) return '';
  let out = String(s).trim().replace(COMMON_DET, '').replace(/[\s,;.:]+$/g, '').trim();
  // Drop trailing function words (e.g. "Acme Corp en" → "Acme Corp")
  while (TRAILING_FILLER.test(out)) {
    out = out.replace(TRAILING_FILLER, '').trim();
  }
  return out;
}

function safeArr(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length > 0) : [];
}

function matchEntity(candidate, lists) {
  const c = candidate.toLowerCase();
  if (!c) return null;
  for (const { type, names } of lists) {
    for (const name of names) {
      const n = name.toLowerCase();
      if (!n) continue;
      // Exact or strict-substring match in either direction (entity in
      // candidate, or candidate in entity) so "Maria" matches "Maria Solís"
      // and vice versa.
      if (c === n || c.includes(n) || (n.length >= 4 && n.includes(c))) {
        return { type, name };
      }
    }
  }
  return null;
}

/**
 * @param {string} sentence
 * @param {{ persons?: string[], organizations?: string[], places?: string[] }} [opts]
 * @returns {{ source: string|null, sourceType: 'person'|'org'|'place'|'unknown'|'document', anchor: string|null, confidence: number }}
 */
function attributeClaim(sentence, opts = {}) {
  const text = typeof sentence === 'string' ? sentence : '';
  if (!text) {
    return { source: null, sourceType: 'document', anchor: null, confidence: 0 };
  }

  const entityLists = [
    { type: 'person', names: safeArr(opts.persons) },
    { type: 'org', names: safeArr(opts.organizations) },
    { type: 'place', names: safeArr(opts.places) },
  ];

  // 1. Pre-anchor patterns (highest confidence — the attribution is
  //    syntactically explicit).
  for (const { re, anchor, conf } of ATTRIBUTION_ANCHORS) {
    const m = text.match(re);
    if (m && m[1]) {
      const candidate = cleanCandidate(m[1]);
      const matched = matchEntity(candidate, entityLists);
      if (matched) {
        return {
          source: matched.name,
          sourceType: matched.type,
          anchor,
          confidence: Math.min(1, conf + 0.05),
        };
      }
      if (candidate.length >= 2) {
        return {
          source: candidate,
          sourceType: 'unknown',
          anchor,
          confidence: conf,
        };
      }
    }
  }

  // 2. Post-anchor verb patterns (subject precedes a reporting verb).
  for (const re of [POST_ANCHOR_VERBS.es, POST_ANCHOR_VERBS.en]) {
    const m = text.match(re);
    if (m && m[1]) {
      const candidate = cleanCandidate(m[1]);
      const matched = matchEntity(candidate, entityLists);
      if (matched) {
        return {
          source: matched.name,
          sourceType: matched.type,
          anchor: 'verb',
          confidence: 0.85,
        };
      }
      if (candidate.length >= 2) {
        return {
          source: candidate,
          sourceType: 'unknown',
          anchor: 'verb',
          confidence: 0.55,
        };
      }
    }
  }

  // 3. Mere co-occurrence — a known entity appears in the sentence,
  //    fallback attribution with low confidence.
  for (const { type, names } of entityLists) {
    for (const name of names) {
      if (!name) continue;
      // Word-boundary-ish match. Use case-insensitive includes — the
      // entity name is already a known string from insights extraction.
      if (text.toLowerCase().includes(name.toLowerCase())) {
        return { source: name, sourceType: type, anchor: 'co-occurrence', confidence: 0.45 };
      }
    }
  }

  // 4. No attribution → the document itself is the implicit source.
  return { source: null, sourceType: 'document', anchor: null, confidence: 0.35 };
}

/**
 * Batch helper — annotate an ordered list of claim sentences with their
 * attribution, preserving order.
 *
 * @param {string[]} claims
 * @param {object} [opts]    same as attributeClaim
 * @returns {Array<ReturnType<typeof attributeClaim> & { claim: string }>}
 */
function annotateClaims(claims, opts = {}) {
  if (!Array.isArray(claims)) return [];
  return claims
    .filter((c) => typeof c === 'string')
    .map((c) => ({ claim: c, ...attributeClaim(c, opts) }));
}

/**
 * Render an attribution as a compact suffix the deep-analyzer can append
 * to a claim line. Empty string when the attribution is the implicit
 * "document" source.
 */
function renderAttributionSuffix(attr) {
  if (!attr || !attr.source) return '';
  const labelMap = { person: 'persona', org: 'organización', place: 'lugar', unknown: 'fuente' };
  const label = labelMap[attr.sourceType] || 'fuente';
  return ` — _${label}: ${attr.source}_`;
}

module.exports = {
  attributeClaim,
  annotateClaims,
  renderAttributionSuffix,
  _internal: {
    cleanCandidate,
    matchEntity,
    ATTRIBUTION_ANCHORS,
    POST_ANCHOR_VERBS,
  },
};

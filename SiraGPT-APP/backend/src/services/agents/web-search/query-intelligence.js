'use strict';

/**
 * query-intelligence.js — deterministic, zero-dep "semantic-ish" query
 * understanding for the web-search relevance layer.
 *
 * The base relevance ranker matched on literal tokens only, so a result
 * titled "inteligencia artificial" was wrongly dropped for the query "IA",
 * and "investigaciones" didn't match "investigación". This module closes that
 * gap WITHOUT embeddings or an LLM call:
 *
 *   - light bilingual (ES/EN) stemming so inflections collapse
 *     (investigación/investigaciones/investigar → investig),
 *   - a curated synonym + acronym lexicon that bridges ES↔EN and short forms
 *     (IA ↔ inteligencia artificial ↔ AI, EEUU ↔ USA, ML ↔ machine learning),
 *   - query-variant generation for optional multi-query fan-out,
 *   - a fast language detector to tune locale-aware providers.
 *
 * Everything is pure and deterministic — it runs in microseconds and is fully
 * unit-testable with no network.
 */

// ── language detection ───────────────────────────────────────────────
const ES_MARKERS = /\b(?:el|la|los|las|un|una|que|qué|de|del|por|para|con|cómo|como|cuál|cuándo|dónde|quién|es|son|hoy|sobre|según|también|más|así|información|sobre)\b|[ñáéíóú¿¡]/i;
const EN_MARKERS = /\b(?:the|a|an|of|and|or|is|are|what|which|who|how|when|where|why|with|for|about|latest|news|today)\b/i;

function detectLanguage(text) {
  const s = String(text || '');
  if (!s.trim()) return 'und';
  const es = (s.match(ES_MARKERS) ? 1 : 0) + ((s.match(/[ñáéíóú¿¡]/i) ? 1 : 0));
  const en = s.match(EN_MARKERS) ? 1 : 0;
  if (es > en) return 'es';
  if (en > es) return 'en';
  return 'und';
}

// ── light bilingual stemmer ──────────────────────────────────────────
// Conservative: only strips inflectional/derivational suffixes that reliably
// preserve meaning, with a minimum stem length so we never over-truncate.
const MIN_STEM = 4;

// Combined, accent-free, de-duplicated suffix list, sorted longest-first so the
// most specific suffix is stripped first (this also makes ES/EN ordering
// irrelevant, keeping `stem("transformers")` and `stem("transformer")` equal).
const SUFFIXES = Array.from(new Set([
  // Spanish
  'aciones', 'iciones', 'amientos', 'imientos', 'amiento', 'imiento',
  'adoras', 'adores', 'idades', 'amente', 'ancias', 'encias', 'acion',
  'idad', 'istas', 'ista', 'ismos', 'ismo', 'ables', 'ible', 'able',
  'mente', 'ciones', 'cion', 'sion', 'ados', 'idos', 'adas', 'idas',
  'ando', 'iendo', 'aron', 'eria', 'es', 'os', 'as', 'a', 'o', 's',
  // English
  'izations', 'ization', 'isations', 'isation', 'fulness', 'ousness',
  'iveness', 'ements', 'ement', 'ations', 'ation', 'ingly', 'ies', 'ied',
  'ively', 'fully', 'ness', 'ment', 'ings', 'ing', 'edly', 'edness',
  'est', 'ers', 'er', 'ed', 'ly',
])).sort((a, b) => b.length - a.length);

function stripDiacritics(s) {
  return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Light bilingual stem of a single token. Strips the longest matching suffix
 * (from the combined list) and repeats once more so layered inflections
 * collapse (transformers → transformer → transform). Never truncates below
 * MIN_STEM; returns the token unchanged if nothing strips cleanly.
 */
function stem(token) {
  let t = stripDiacritics(String(token || '').toLowerCase());
  for (let pass = 0; pass < 2; pass++) {
    if (t.length <= MIN_STEM) break;
    let stripped = false;
    for (const suf of SUFFIXES) {
      if (suf.length >= t.length) continue;
      if (t.endsWith(suf) && t.length - suf.length >= MIN_STEM) {
        t = t.slice(0, t.length - suf.length);
        stripped = true;
        break;
      }
    }
    if (!stripped) break;
  }
  return t;
}

// ── synonym + acronym lexicon ────────────────────────────────────────
// Each group is a set of interchangeable terms; expansion maps any member to
// the whole group. Keys/values are lowercased + accent-free (matched against
// stripDiacritics tokens). Multi-word phrases are stored as space-joined and
// also contribute their individual tokens to the expansion.
const SYNONYM_GROUPS = [
  ['ia', 'ai', 'inteligencia artificial', 'artificial intelligence'],
  ['ml', 'machine learning', 'aprendizaje automatico', 'aprendizaje de maquina'],
  ['dl', 'deep learning', 'aprendizaje profundo'],
  ['llm', 'large language model', 'modelo de lenguaje', 'modelos de lenguaje'],
  ['nlp', 'pln', 'natural language processing', 'procesamiento de lenguaje natural'],
  ['eeuu', 'usa', 'us', 'estados unidos', 'united states'],
  ['uk', 'reino unido', 'united kingdom'],
  ['ue', 'eu', 'union europea', 'european union'],
  ['btc', 'bitcoin'],
  ['eth', 'ethereum'],
  ['cripto', 'crypto', 'criptomoneda', 'cryptocurrency', 'criptomonedas'],
  ['coche', 'auto', 'automovil', 'carro', 'car', 'vehiculo', 'vehicle'],
  ['movil', 'celular', 'telefono', 'smartphone', 'mobile', 'phone'],
  ['ordenador', 'computadora', 'computador', 'pc', 'computer'],
  ['precio', 'costo', 'coste', 'price', 'cost'],
  ['empresa', 'compania', 'company', 'firma', 'corporacion'],
  ['investigacion', 'estudio', 'research', 'study', 'paper'],
  ['enfermedad', 'disease', 'dolencia', 'padecimiento'],
  ['cancer', 'cancer', 'tumor', 'neoplasia', 'oncologia', 'oncology'],
  ['vacuna', 'vaccine', 'inmunizacion', 'immunization'],
  ['cambio climatico', 'climate change', 'calentamiento global', 'global warming'],
  ['energia', 'energy', 'energetica', 'energetico'],
  ['electricidad', 'electricity', 'electrico', 'electrica', 'electric'],
  ['emisiones', 'emissions', 'emision', 'emission'],
  ['salud', 'health', 'sanidad', 'sanitario'],
  ['agua', 'water', 'hidrico', 'hidrica'],
  ['educacion', 'education', 'educativo', 'educativa', 'ensenanza'],
  ['gobierno', 'government', 'estado', 'administracion'],
  ['mercado', 'market', 'mercados', 'markets'],
  ['seguridad', 'security', 'safety', 'seguro'],
  ['noticias', 'news', 'actualidad', 'titulares', 'headlines'],
  ['tutorial', 'guia', 'guide', 'how to', 'como hacer'],
  ['error', 'bug', 'fallo', 'defecto', 'issue'],
  ['rapido', 'fast', 'veloz', 'quick'],
  ['gratis', 'free', 'gratuito'],
];

// Build a lookup: term (single or phrase, stripped) → Set of expansion terms.
const SYNONYM_INDEX = new Map();
for (const group of SYNONYM_GROUPS) {
  const norm = group.map((g) => stripDiacritics(g.toLowerCase()).trim());
  const all = new Set();
  for (const term of norm) {
    all.add(term);
    for (const w of term.split(/\s+/)) if (w.length >= 2) all.add(w);
  }
  for (const term of norm) {
    const existing = SYNONYM_INDEX.get(term) || new Set();
    for (const a of all) existing.add(a);
    SYNONYM_INDEX.set(term, existing);
  }
}

/**
 * Expand a single token into the set of forms that should count as a match:
 * the token itself, its stem, and any synonym-group members (+ their stems).
 */
function expandTerm(token) {
  const base = stripDiacritics(String(token || '').toLowerCase());
  const out = new Set();
  if (!base) return out;
  out.add(base);
  out.add(stem(base));
  const syns = SYNONYM_INDEX.get(base);
  if (syns) {
    for (const s of syns) {
      out.add(s);
      out.add(stem(s));
    }
  }
  return out;
}

/**
 * Expand a list of content tokens (and detect any 2-word phrases that map to a
 * synonym group, e.g. "machine learning" → ml/ia-family). Returns a flat Set
 * of stemmed match forms used by the relevance matcher.
 */
function expandTerms(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  const out = new Set();
  for (const t of list) for (const e of expandTerm(t)) out.add(e);
  // Detect adjacent 2-grams that are themselves synonym keys.
  for (let i = 0; i < list.length - 1; i++) {
    const bigram = `${stripDiacritics(String(list[i]).toLowerCase())} ${stripDiacritics(String(list[i + 1]).toLowerCase())}`;
    const syns = SYNONYM_INDEX.get(bigram);
    if (syns) for (const s of syns) { out.add(s); out.add(stem(s)); }
  }
  return out;
}

/**
 * Build per-query-token match groups (each a Set of acceptable stemmed forms)
 * so the relevance scorer can test a doc token against the right group and
 * award field/coverage credit per original query term.
 */
function matchGroups(queryTokens) {
  return (Array.isArray(queryTokens) ? queryTokens : []).map((t) => expandTerm(t));
}

/**
 * Generate a small set of query-string variants for optional multi-query
 * fan-out (recall boost). Always includes the original; adds a synonym-
 * substituted variant for the first expandable token. Deduped, capped.
 */
function queryVariants(query, opts = {}) {
  const max = Math.max(1, Math.min(Number(opts.max) || 3, 6));
  const original = String(query || '').trim();
  const variants = [original].filter(Boolean);
  const tokens = original.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length && variants.length < max; i++) {
    const base = stripDiacritics(tokens[i].toLowerCase());
    const syns = SYNONYM_INDEX.get(base);
    if (!syns) continue;
    // Pick the longest synonym phrase that differs from the token (most info).
    const candidates = [...syns]
      .filter((s) => s !== base && s.includes(' '))
      .sort((a, b) => b.length - a.length);
    if (candidates.length) {
      const repl = tokens.slice();
      repl[i] = candidates[0];
      const v = repl.join(' ');
      if (!variants.includes(v)) variants.push(v);
    }
  }
  return variants.slice(0, max);
}

module.exports = {
  detectLanguage,
  stem,
  stripDiacritics,
  expandTerm,
  expandTerms,
  matchGroups,
  queryVariants,
  SYNONYM_INDEX,
};

'use strict';

/**
 * research-query-intelligence — turn a raw, natural-language research request
 * into a structured search plan: detected language, content terms, extracted
 * filters (year range / study type / language / open-access), and a small set
 * of expanded query variants (bilingual ES/EN synonyms + translations) so the
 * unified scientific search casts a wider, smarter net than the user's literal
 * phrasing.
 *
 * Fully deterministic + offline (no LLM, no network). A compact bilingual
 * research lexicon drives synonym/translation expansion; everything degrades
 * gracefully to the normalised literal query when nothing matches.
 */

function _stripDia(s) {
  return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

// Diacritics are stripped on both the input (in contentTerms) and here, so a
// Spanish stopword written with an accent still matches an un-accented token.
const STOPWORDS = new Set((
  'the a an of and or in on for to with from by at as is are be was were this that these those ' +
  'about over under between into during such using based study studies research paper papers article articles ' +
  'una un el la los las de del y o en con por para a al se su sus es son lo le les como sobre entre ' +
  'segun según mas más muy entre cuales cuáles sobre acerca trabajo articulo artículo artículos estudio estudios ' +
  'busca buscame búscame encuentra dame quiero necesito hazme sobre tema temas cientifico científico cientificos científicos ' +
  'publicado publicada publicados publicadas publicacion publicación publicaciones published publication publications'
).split(/\s+/).filter(Boolean).map((w) => _stripDia(w.toLowerCase())));

// Bilingual research-domain lexicon: each entry maps a concept to its ES + EN
// surface forms. Used both to TRANSLATE detected terms across languages and to
// add near-synonyms, broadening recall without drifting off-topic.
const LEXICON = [
  {
    es: ['aprendizaje autorregulado', 'autorregulacion del aprendizaje', 'autorregulación del aprendizaje', 'autorregulado'],
    en: ['self-regulated learning', 'self regulated learning', 'learning self-regulation'],
  },
  {
    es: ['educacion superior', 'educación superior', 'universidad', 'universitario'],
    en: ['higher education', 'university', 'tertiary education'],
  },
  { es: ['gestion', 'gestión', 'administracion', 'administración'], en: ['management', 'administration'] },
  { es: ['empresa', 'empresas', 'empresarial'], en: ['business', 'enterprise', 'firm', 'company'] },
  { es: ['educacion', 'educación', 'educativo'], en: ['education', 'educational', 'learning'] },
  { es: ['salud', 'sanitario'], en: ['health', 'healthcare'] },
  { es: ['aprendizaje'], en: ['learning'] },
  { es: ['inteligencia artificial', 'ia'], en: ['artificial intelligence', 'ai', 'machine learning'] },
  { es: ['rendimiento', 'desempeño', 'desempeno'], en: ['performance'] },
  { es: ['productividad'], en: ['productivity'] },
  { es: ['liderazgo'], en: ['leadership'] },
  { es: ['motivacion', 'motivación'], en: ['motivation'] },
  { es: ['calidad'], en: ['quality'] },
  { es: ['sostenibilidad', 'sostenible'], en: ['sustainability', 'sustainable'] },
  { es: ['innovacion', 'innovación'], en: ['innovation'] },
  { es: ['estrategia', 'estrategico', 'estratégico'], en: ['strategy', 'strategic'] },
  { es: ['publico', 'público', 'publica', 'pública'], en: ['public'] },
  { es: ['mercado', 'marketing'], en: ['market', 'marketing'] },
  { es: ['clima organizacional', 'organizacional'], en: ['organizational', 'organisational'] },
  { es: ['psicologia', 'psicología'], en: ['psychology', 'psychological'] },
  { es: ['cambio climatico', 'cambio climático', 'clima'], en: ['climate change', 'climate'] },
  { es: ['energia', 'energía'], en: ['energy'] },
  { es: ['agua'], en: ['water'] },
  { es: ['genero', 'género'], en: ['gender'] },
  { es: ['pobreza'], en: ['poverty'] },
  { es: ['economia', 'economía', 'economico', 'económico'], en: ['economy', 'economic', 'economics'] },
  { es: ['finanzas', 'financiero'], en: ['finance', 'financial'] },
  { es: ['turismo'], en: ['tourism'] },
  { es: ['agricultura'], en: ['agriculture', 'agricultural'] },
  { es: ['tecnologia', 'tecnología'], en: ['technology', 'technological'] },
  { es: ['software', 'programacion', 'programación'], en: ['software', 'programming'] },
  { es: ['datos', 'big data'], en: ['data', 'big data'] },
  { es: ['ciberseguridad', 'seguridad informatica'], en: ['cybersecurity', 'information security'] },
  { es: ['covid', 'covid-19', 'coronavirus', 'pandemia'], en: ['covid-19', 'coronavirus', 'pandemic'] },
  { es: ['vacuna', 'vacunacion', 'vacunación'], en: ['vaccine', 'vaccination'] },
  { es: ['cancer', 'cáncer'], en: ['cancer'] },
  { es: ['diabetes'], en: ['diabetes'] },
];

// Study-type detectors (bilingual). Drives both filter extraction and the
// synthesiser's evidence-quality weighting.
const STUDY_TYPES = [
  { type: 'meta_analysis', re: /\bmeta[- ]?an[aá]lisis\b|\bmeta[- ]?analysis\b/i },
  { type: 'systematic_review', re: /\brevisi[oó]n sistem[aá]tica\b|\bsystematic review\b/i },
  { type: 'review', re: /\brevisi[oó]n( de literatura| bibliogr[aá]fica)?\b|\bliterature review\b|\bscoping review\b/i },
  { type: 'rct', re: /\bensayo cl[ií]nico( aleatorizado)?\b|\brandomi[sz]ed controlled trial\b|\brct\b/i },
  { type: 'cohort', re: /\bestudio de cohorte\b|\bcohort study\b/i },
  { type: 'case_study', re: /\bestudio de caso\b|\bcase study\b/i },
  { type: 'qualitative', re: /\bcualitativ[oa]\b|\bqualitative\b/i },
  { type: 'quantitative', re: /\bcuantitativ[oa]\b|\bquantitative\b/i },
];

const stripDiacritics = _stripDia;

function detectLanguage(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  const esHits = (t.match(/[áéíóúñ¿¡]| de | la | el | los | las | con | por | para | gestión | búscame | artículos /g) || []).length;
  const enHits = (t.match(/ the | of | and | with | for | management | research | study /g) || []).length;
  if (esHits > enHits) return 'es';
  if (enHits > esHits) return 'en';
  return esHits > 0 ? 'es' : 'en';
}

function contentTerms(text) {
  const cleaned = stripDiacritics(String(text || '').toLowerCase())
    .replace(/[^a-z0-9áéíóúñ\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const raw = stripDiacritics(cleaned).split(' ');
  const out = [];
  const seen = new Set();
  for (const w of raw) {
    const word = w.trim();
    if (!word || word.length < 3) continue;
    if (STOPWORDS.has(word)) continue;
    if (/^\d+$/.test(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

function retrievalText(text) {
  return String(text || '')
    // A trailing preference clause describes how to rank the evidence, not the
    // scientific topic itself. Keeping it in the provider query made words
    // such as "sistemática", "DOI" or "pertinencia" outweigh the actual topic.
    .replace(/(?:^|[.;])\s*(?:prioriza(?:r)?|priorice|prefiere|preferir|prioriti[sz]e|prefer)\b[\s\S]*$/i, ' ')
    .replace(/\b(?:de\s+)?acceso abierto\b|\bopen access\b/gi, ' ')
    .replace(/\bdoi(?:\s+verificable)?\b|\bverifiable doi\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFilters(text) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  const filters = {};
  const nowYear = new Date().getFullYear();

  // Explicit "desde YYYY" / "since YYYY" / "after YYYY"
  const since = lower.match(/\b(?:desde|since|after|posteriores? a|a partir de)\s+(\d{4})\b/);
  if (since) filters.yearFrom = parseInt(since[1], 10);
  const until = lower.match(/\b(?:hasta|until|before|antes de|previos? a)\s+(\d{4})\b/);
  if (until) filters.yearTo = parseInt(until[1], 10);
  // "entre 2018 y 2022" / "between 2018 and 2022"
  const between = lower.match(/\b(?:entre|between)\s+(\d{4})\s+(?:y|and|-)\s+(\d{4})\b/);
  if (between) {
    filters.yearFrom = parseInt(between[1], 10);
    filters.yearTo = parseInt(between[2], 10);
  }
  // "últimos N años" / "last N years". No leading \b: it fails before an
  // accented 'ú' (JS \b is ASCII-\w only), so we anchor on start/whitespace.
  const lastN = lower.match(/(?:^|\s)(?:[uú]ltimos?|last|past)\s+(\d{1,2})\s+(?:a[nñ]os|years)/);
  if (lastN) filters.yearFrom = nowYear - parseInt(lastN[1], 10);
  // "recientes" / "recent" → last 5 years
  if (!filters.yearFrom && /\brecientes?\b|\brecent\b|\b[uú]ltimamente\b/.test(lower)) {
    filters.yearFrom = nowYear - 5;
  }

  // Language preference
  if (/\ben espa[nñ]ol\b|\bin spanish\b|\bidioma espa[nñ]ol\b/.test(lower)) filters.language = 'es';
  else if (/\ben ingl[eé]s\b|\bin english\b/.test(lower)) filters.language = 'en';

  // Open access
  if (/\bopen access\b|\bacceso abierto\b|\bgratis\b|\bgratuit[oa]s?\b|\bdescargables?\b/.test(lower)) {
    filters.openAccessOnly = true;
  }

  // Study type
  for (const s of STUDY_TYPES) {
    if (s.re.test(t)) { filters.studyType = s.type; break; }
  }

  return filters;
}

// Expand the content terms across the bilingual lexicon: every matched concept
// contributes its synonyms in BOTH languages. Returns a de-duplicated list of
// expansion tokens/phrases (excluding the originals).
function expandTerms(terms, fullTextLower) {
  const expansions = new Set();
  const haystack = ` ${fullTextLower} `;
  for (const entry of LEXICON) {
    const all = [...entry.es, ...entry.en];
    const matched = all.some((form) => {
      const f = stripDiacritics(form.toLowerCase());
      const formTerms = f.split(/\s+/).filter(Boolean);
      const termMatch = formTerms.length === 1
        ? terms.includes(formTerms[0])
        : formTerms.every((term) => terms.includes(term));
      return termMatch || haystack.includes(` ${form.toLowerCase()} `) || haystack.includes(` ${f} `);
    });
    if (matched) {
      for (const form of all) expansions.add(form.toLowerCase());
    }
  }
  // Don't echo the literal topic back as an "expansion". Normalise accents so
  // "educación superior" and "educacion superior" collapse to one concept,
  // leaving the limited query budget for actual cross-language alternatives.
  const literal = ` ${stripDiacritics(fullTextLower)} `;
  const seen = new Set();
  const useful = [];
  for (const form of expansions) {
    const key = stripDiacritics(String(form).toLowerCase()).replace(/\s+/g, ' ').trim();
    if (!key || terms.includes(key) || literal.includes(` ${key} `) || seen.has(key)) continue;
    seen.add(key);
    useful.push(form);
  }
  return useful;
}

/**
 * analyzeQuery — full structured search plan for a raw research request.
 *
 * @param {string} rawQuery
 * @param {object} [opts] { maxQueries=3 }
 * @returns {{
 *   original: string, normalized: string, language: 'es'|'en',
 *   terms: string[], filters: object, expansions: string[],
 *   searchQueries: string[]
 * }}
 */
function analyzeQuery(rawQuery, opts = {}) {
  const maxQueries = Number.isFinite(opts.maxQueries) && opts.maxQueries > 0 ? opts.maxQueries : 3;
  const original = String(rawQuery || '');
  const normalized = original.replace(/\s+/g, ' ').trim();
  const language = detectLanguage(normalized);
  const topicText = retrievalText(normalized) || normalized;
  const terms = contentTerms(topicText);
  const filters = extractFilters(normalized);
  const fullLower = stripDiacritics(topicText.toLowerCase());
  const expansions = expandTerms(terms, fullLower);

  // Build search-query variants:
  //   1. the core content terms (literal intent, stopwords stripped)
  //   2. core terms + cross-language synonyms (broader recall)
  //   3. the English-leaning variant (most providers index English best)
  const coreQuery = terms.join(' ') || normalized;
  const searchQueries = [];
  const pushQ = (q) => {
    const v = q.replace(/\s+/g, ' ').trim();
    if (v && !searchQueries.includes(v)) searchQueries.push(v);
  };
  pushQ(coreQuery);
  if (expansions.length) {
    pushQ(`${coreQuery} ${expansions.slice(0, 8).join(' ')}`);
    // English-leaning: prefer expansions that look English (ascii-only words).
    const englishish = expansions.filter((e) => /^[a-z0-9 -]+$/.test(e));
    if (englishish.length) pushQ(englishish.slice(0, 8).join(' '));
  }
  if (!searchQueries.length) pushQ(normalized);

  return {
    original,
    normalized,
    topicText,
    language,
    terms,
    filters,
    expansions,
    searchQueries: searchQueries.slice(0, maxQueries),
  };
}

module.exports = {
  analyzeQuery,
  detectLanguage,
  contentTerms,
  extractFilters,
  expandTerms,
  STUDY_TYPES,
  _internal: { stripDiacritics, retrievalText, STOPWORDS, LEXICON },
};

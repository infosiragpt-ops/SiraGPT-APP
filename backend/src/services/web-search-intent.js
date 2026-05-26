'use strict';

/**
 * web-search-intent — detect whether a user prompt needs fresh web data.
 *
 * Spec §7.18: "El sistema debe detectar automáticamente cuándo el usuario
 * necesita información actualizada en internet, incluso si no selecciona
 * manualmente la herramienta."
 *
 * The existing semantic-intent-router has `matchesResearchAsk` which
 * covers explicit verbs ("buscar", "investigar"). What it does NOT
 * detect is the temporal/freshness signal — questions about events
 * that happened recently or about current state of the world, where
 * cached LLM knowledge is stale and the answer must come from the web.
 *
 * Heuristics, in order:
 *   1. Explicit URLs in the prompt → user pasted a link to discuss.
 *   2. Temporal markers ("hoy", "actual", "última", "2026", "now").
 *   3. Live-event markers ("precio", "cotización", "noticias", "score",
 *      "weather", "election").
 *   4. Recency questions ("what's new", "qué pasó con X", "novedades").
 *   5. Future-tense or upcoming-event markers ("cuándo será", "when is").
 *   6. Explicit web-search request (already covered by the existing
 *      semantic-intent-router; we still flag it so callers using only
 *      this module get a consistent answer).
 *
 * Returns:
 *   {
 *     needsWebSearch: boolean,
 *     confidence: number 0..1,
 *     signals: string[]    // names of signals that fired
 *   }
 *
 * Pure functions, deterministic, zero deps. Future enhancement: a
 * lightweight LLM verifier for ambiguous prompts. The hook is here
 * via `opts.llm` but not implemented by default.
 */

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/i;

const TEMPORAL_PATTERNS = [
  { name: 'today', re: /\b(?:hoy|today|esta\s+ma[ñn]ana|esta\s+tarde|esta\s+noche)\b/i, weight: 0.25 },
  { name: 'current', re: /\b(?:actual(?:es|mente)?|current(?:ly)?|al?\s+d[ií]a|ahora|right\s+now|presente)\b/i, weight: 0.20 },
  { name: 'latest', re: /\b(?:[uú]ltim[ao]s?|latest|recent(?:e|es|emente)?|most\s+recent|new(?:est)?|nuev[ao]s?|reciente(?:s|mente)?)\b/i, weight: 0.18 },
  { name: 'this_year', re: /\b(?:este\s+a[ñn]o|this\s+year|en\s+(?:20[2-9]\d)|in\s+(?:20[2-9]\d)|para\s+(?:20[2-9]\d))\b/i, weight: 0.20 },
  { name: 'this_week_month', re: /\b(?:esta\s+semana|this\s+week|este\s+mes|this\s+month|past\s+(?:week|month)|[uú]ltima\s+semana|[uú]ltimo\s+mes)\b/i, weight: 0.22 },
  { name: 'live_now', re: /\b(?:en\s+vivo|live(?:\s+now)?|streaming|en\s+directo|right\s+now)\b/i, weight: 0.30 },
  { name: 'currency_year', re: /\b(?:20[3-9]\d|202[5-9])\b/, weight: 0.18 },
];

const LIVE_EVENT_PATTERNS = [
  { name: 'price_quote', re: /\b(?:precio(?:s)?\s+(?:de\s+|del\s+)?|cotizaci[oó]n|stock\s+price|share\s+price|bolsa|cryptocurrency|crypto|bitcoin|ethereum|usd\s*\/|tipo\s+de\s+cambio|exchange\s+rate)\b/i, weight: 0.40 },
  { name: 'news', re: /\b(?:noticias?|news\s+about|qu[eé]\s+pas[oó]|qu[eé]\s+pasa|breaking|titular(?:es)?|headline(?:s)?|[uú]ltima\s+hora)\b/i, weight: 0.40 },
  { name: 'weather', re: /\b(?:clima|tiempo\s+(?:de|en|para)|weather|temperatura|pron[oó]stico|forecast|llover[aá]|raining|snow)\b/i, weight: 0.40 },
  { name: 'sports_score', re: /\b(?:marcador|score|resultado(?:s)?\s+(?:del?|of)|partido\s+de|jug[oó]\s+ayer|won\s+yesterday|ganador|champion|standings)\b/i, weight: 0.40 },
  { name: 'election_politics', re: /\b(?:elecci[oó]n(?:es)?|election(?:s)?|votaci[oó]n|results?\s+of|encuesta|polls?|presidente|gobierno)\b/i, weight: 0.25 },
  { name: 'release_date', re: /\b(?:lanzamiento|launch\s+date|release\s+date|cu[aá]ndo\s+sale|when\s+is\s+the|premiere|estreno)\b/i, weight: 0.40 },
];

const RECENCY_QUESTION_PATTERNS = [
  { name: 'whats_new', re: /\b(?:qu[eé]\s+(?:hay|tiene)\s+de\s+nuevo|what(?:'?s)?\s+new|novedades?|cambios?\s+recientes?)\b/i, weight: 0.25 },
  { name: 'whats_happening', re: /\b(?:qu[eé]\s+est[aá]\s+pasando|qu[eé]\s+sucede|qu[eé]\s+est[aá]\s+ocurriendo|what(?:'?s|\s+(?:is|are))?\s+happening|going\s+on|qu[eé]\s+ocurre)\b/i, weight: 0.25 },
  { name: 'what_happened', re: /\b(?:qu[eé]\s+pas[oó]\s+con|what\s+happened\s+to|noticias\s+sobre)\b/i, weight: 0.25 },
];

const FUTURE_EVENT_PATTERNS = [
  { name: 'when_future', re: /\b(?:cu[aá]ndo\s+ser[aá]|when\s+is\s+the\s+next|when\s+will|pr[oó]xim[ao]\s+(?:partido|evento|reuni[oó]n)|next\s+game|next\s+event)\b/i, weight: 0.22 },
];

const EXPLICIT_WEB_PATTERNS = [
  { name: 'explicit_search', re: /\b(?:busca(?:r|me)?\s+en\s+(?:internet|google|la\s+web|web)|web\s*search|search\s+the\s+web|googlea(?:r|me)?)\b/i, weight: 0.40 },
  { name: 'explicit_url', re: URL_RE, weight: 0.35 },
];

const NEGATIVE_PATTERNS = [
  // Pure code-generation asks rarely need web context unless the user
  // names a specific library version, but the version match already
  // hits currency_year. Keep this defensive — don't add weight here.
  { name: 'creative_writing', re: /\b(?:escribe(?:me)?\s+(?:un\s+)?(?:cuento|poema|historia|relato)|write\s+(?:a|me\s+a)\s+(?:story|poem|tale))\b/i, weight: -0.30 },
  { name: 'math_problem', re: /\b(?:resuelve|calcula|integra(?:l)?|deriva(?:da)?|solve|simplify|factoriza)\b/i, weight: -0.20 },
];

const ALL_GROUPS = [
  { name: 'temporal', patterns: TEMPORAL_PATTERNS },
  { name: 'live_event', patterns: LIVE_EVENT_PATTERNS },
  { name: 'recency', patterns: RECENCY_QUESTION_PATTERNS },
  { name: 'future', patterns: FUTURE_EVENT_PATTERNS },
  { name: 'explicit', patterns: EXPLICIT_WEB_PATTERNS },
  { name: 'negative', patterns: NEGATIVE_PATTERNS },
];

function normalise(text) {
  if (!text || typeof text !== 'string') return '';
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/**
 * Detect web-search intent for a single prompt.
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {number} [opts.threshold=0.35] — confidence at or above this
 *     flips needsWebSearch to true.
 * @param {boolean} [opts.includeNegatives=true] — apply negative
 *     signals that reduce confidence (creative writing, math).
 */
function detectWebSearchIntent(prompt, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : 0.35;
  const includeNegatives = opts.includeNegatives !== false;
  const text = normalise(prompt);
  if (!text) {
    return { needsWebSearch: false, confidence: 0, signals: [] };
  }

  let confidence = 0;
  const signals = [];

  for (const group of ALL_GROUPS) {
    if (group.name === 'negative' && !includeNegatives) continue;
    for (const pat of group.patterns) {
      if (pat.re.test(text)) {
        confidence += pat.weight;
        signals.push(`${group.name}:${pat.name}`);
      }
    }
  }

  // Clamp 0..1.
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;

  const needsWebSearch = confidence >= threshold;
  return {
    needsWebSearch,
    confidence: Math.round(confidence * 100) / 100,
    signals,
    threshold,
  };
}

/**
 * Batch helper for testing or multi-message contexts.
 */
function detectBatch(prompts, opts = {}) {
  return (prompts || []).map((p) => detectWebSearchIntent(p, opts));
}

module.exports = {
  detectWebSearchIntent,
  detectBatch,
  TEMPORAL_PATTERNS,
  LIVE_EVENT_PATTERNS,
  RECENCY_QUESTION_PATTERNS,
  FUTURE_EVENT_PATTERNS,
  EXPLICIT_WEB_PATTERNS,
  NEGATIVE_PATTERNS,
};

'use strict';

const { createBm25Index, DEFAULT_STOPWORDS } = require('./bm25');

// Question words and function words that the shared BM25 list lacks. In
// document search they match every passage («¿cuál es…?», «what are…») and
// dilute the terms that carry the question. Kept local to document search:
// the shared list in bm25.js serves other indexes. Words that are also
// content nouns in real documents stay searchable: «will» (testament),
// «can», «era», «not» (negation can be the point of a clause).
const QUESTION_STOPWORDS = [
  'cual', 'cuales', 'como', 'donde', 'cuando', 'cuanto', 'cuanta', 'cuantos', 'cuantas', 'quien', 'quienes',
  'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas', 'esto', 'eso', 'aquel', 'aquella',
  'hay', 'muy', 'tambien', 'segun', 'sobre', 'entre', 'cada', 'otro', 'otra', 'otros', 'otras',
  'mi', 'mis', 'tu', 'tus', 'nos', 'les', 'ya', 'han', 'ha', 'he', 'estan', 'eran', 'sea', 'sean',
  'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how', 'about', 'into', 'there',
  'their', 'they', 'them', 'could', 'would', 'should', 'does', 'any', 'some',
];

const STOPWORDS = new Set([...DEFAULT_STOPWORDS, ...QUESTION_STOPWORDS]
  .map(word => word.normalize('NFD').replace(/\p{M}/gu, '')));

// Light PLURAL folding for Spanish and English. The surface token is always
// kept (an exact match still scores on both forms); singular candidates are
// added so «riesgo» finds «riesgos», «evaluación» finds «evaluaciones»,
// «interés» finds «intereses», «study» finds «studies», «source» finds
// «sources». Gender is NOT folded: dropping a final a/o/e conflated
// plazo/plaza, marco/marca, cuento/cuenta, and docintel treats any shared
// term as evidence. Alphabetic tokens of 5+ letters only.
const STEM_MIN_LENGTH = 5;
const STEM_MIN_RESULT = 4;
function lightStems(token) {
  if (token.length < STEM_MIN_LENGTH || !/^\p{L}+$/u.test(token)) return [];
  const out = [];
  const add = (candidate, minLength = STEM_MIN_RESULT) => {
    if (candidate !== token && candidate.length >= minLength && !out.includes(candidate)) out.push(candidate);
  };
  if (token.endsWith('ciones')) add(`${token.slice(0, -6)}cion`);
  else if (token.endsWith('siones')) add(`${token.slice(0, -6)}sion`);
  else if (token.endsWith('ies')) add(`${token.slice(0, -3)}y`);
  else if (token.endsWith('ces')) {
    add(`${token.slice(0, -3)}z`, 3); // veces → vez, luces → luz, voces → voz
    add(token.slice(0, -1)); // prices → price, sources → source
  } else if (/[lrndjzs]es$/.test(token)) {
    add(token.slice(0, -2)); // ciudades → ciudad, intereses → interes, classes → class
    add(token.slice(0, -1)); // files → file, cases → case
  } else if (token.endsWith('s') && !token.endsWith('ss') && !/(?:is|us)$/.test(token)) {
    add(token.slice(0, -1));
  }
  return out;
}

// Normalize only the search representation. Stored text and cited excerpts
// retain original accents, table line breaks, decimal punctuation and values.
function documentTokens(text) {
  if (typeof text !== 'string' || !text) return [];
  const normalized = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  const raw = normalized.match(/[\p{L}_][\p{L}\p{N}_]*(?:[-./][\p{L}\p{N}_]+)*|\p{N}+(?:[.,]\p{N}+)*/gu) || [];
  const tokens = [];
  for (const token of raw) {
    if (STOPWORDS.has(token)) continue;
    // Decimal values stay whole: 0,05 is not interchangeable with 0,01.
    // File names and identifiers also retain their exact compound token.
    if (token.length > 1 || /^\p{N}$/u.test(token)) tokens.push(token);
    for (const stem of lightStems(token)) tokens.push(stem);
    if (/^\p{L}/u.test(token) && /[-./]/.test(token)) {
      for (const part of token.split(/[-./]/)) {
        if ((part.length > 1 || /^\p{N}$/u.test(part)) && !STOPWORDS.has(part)) tokens.push(part);
      }
    }
  }
  return tokens;
}

// A pre-tokenized term list is used as-is. Re-tokenizing terms joined into a
// string stemmed the stems a second time («intereses» → «interes» → «inter»,
// which then matched unrelated compound parts such as «inter-institucional»).
function lexicalTokens(input) {
  return Array.isArray(input) ? input : documentTokens(input);
}

function searchDocumentLexical(entries, query, k = 10) {
  const index = createBm25Index({ tokenize: lexicalTokens, k1: 1.5 });
  const queryTerms = new Set(lexicalTokens(query));
  const matchingTerms = new Set();
  const coverage = new Map();
  entries.forEach((entry, position) => {
    const text = [entry.title, entry.text].filter(Boolean).join('\n');
    index.add(position, text);
    const tokens = new Set(documentTokens(text));
    let matched = 0;
    for (const term of queryTerms) {
      if (tokens.has(term)) { matched += 1; matchingTerms.add(term); }
    }
    coverage.set(position, matched);
  });
  return index.search(query, { topK: k }).map(hit => ({
    doc: { _idx: hit.id },
    score: hit.score,
    // Evidence matching all searchable query terms is stronger than a
    // partial hit. This breaks otherwise identical opposing RRF ranks.
    coverage: matchingTerms.size ? coverage.get(hit.id) / matchingTerms.size : 0,
  }));
}

// Broad comparisons need evidence from several documents. Promote each
// source's best competitive hit without guaranteeing a slot to a weak source.
function diversifyDocumentSources(pool, k) {
  const topScore = Math.max(0, ...pool.map(hit => Number(hit.score) || 0));
  const selected = [];
  const sources = new Set();
  for (const hit of pool) {
    if (selected.length >= k) break;
    if (!hit.source || sources.has(hit.source) || hit.score < topScore * 0.75) continue;
    if (!(hit.textScore > 0 || hit.vectorScore > 0)) continue;
    sources.add(hit.source);
    selected.push(hit);
  }
  const picked = new Set(selected);
  for (const hit of pool) {
    if (selected.length >= k) break;
    if (!picked.has(hit)) selected.push(hit);
  }
  return selected;
}

/** Return a bounded, verbatim span containing the best local query evidence. */
function queryFocusedExcerpt(text, query, maxChars) {
  if (typeof text !== 'string' || !text) return '';
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 1200;
  if (!limit) return '';
  if (text.length <= limit) return text;
  if (!documentTokens(query).length) return text.slice(0, limit);

  // Overlapping windows inspect the complete text, including a final tail
  // window. A bounded index keeps a large document from creating millions
  // of tiny windows if a caller requests an unusually small excerpt.
  const windowSize = Math.max(160, limit);
  const stride = Math.max(80, Math.floor(windowSize / 2));
  const starts = new Set([0, Math.max(0, text.length - windowSize)]);
  for (let rough = stride; rough < text.length; rough += stride) {
    const lineStart = text.lastIndexOf('\n', rough - 1) + 1;
    starts.add(rough - lineStart < windowSize / 4 ? lineStart : rough);
  }
  const windows = [...starts].sort((a, b) => a - b).map(start => ({ start, text: text.slice(start, start + windowSize) }));
  const [best] = searchDocumentLexical(windows, query, 1);
  if (!best) return text.slice(0, limit);
  const winner = windows[best.doc._idx];
  const terms = new Set(documentTokens(query));
  const matches = [...winner.text.matchAll(/[\p{L}\p{N}_.,/-]+/gu)]
    .filter(match => documentTokens(match[0]).some(token => terms.has(token)));
  const first = matches[0];
  const last = matches[matches.length - 1];
  const center = first ? Math.floor((first.index + last.index + last[0].length) / 2) : 0;
  let start = Math.max(0, Math.min(text.length - limit, winner.start + center - Math.floor(limit / 2)));
  // Re-center the evidence rather than leaving a matched row at the window
  // boundary, where its value or following unit could otherwise be cut off.
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  if (start - lineStart < limit / 8) start = lineStart;
  return text.slice(start, start + limit);
}

module.exports = { documentTokens, searchDocumentLexical, queryFocusedExcerpt, diversifyDocumentSources };

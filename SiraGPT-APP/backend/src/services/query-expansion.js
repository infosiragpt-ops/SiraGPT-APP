/**
 * query-expansion — extract meaningful keywords from a conversational query.
 *
 * Users phrase questions conversationally ("hey, can you find me the bit
 * about pricing in the doc?"). Embedding that directly works, but the
 * signal is diluted by the stop-words and fillers. Extracting the
 * content words ("pricing", "doc") and embedding *also* those as a
 * separate retrieval pass improves recall on short corpora where a
 * single embedding can miss the right chunk.
 *
 * Two entry points:
 *   - extractKeywords(query)  → string[] of content words
 *   - expandQuery(query)      → { original, keywords, expanded }
 *     where `expanded` is a space-joined "query + keywords" string
 *     suitable for a second embedding pass.
 *
 * Stop-word lists cover EN + ES because siraGPT's users write in both.
 * Pattern reference: Iliagpt.io server/memory/queryExpansion.ts.
 */

const STOP_WORDS_EN = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they', 'them',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'can', 'may', 'might',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'about',
  'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'under', 'over',
  'and', 'or', 'but', 'if', 'then', 'because', 'as', 'while',
  'when', 'where', 'what', 'which', 'who', 'how', 'why',
  'yesterday', 'today', 'tomorrow', 'earlier', 'later', 'recently', 'ago', 'just', 'now',
  'thing', 'things', 'stuff', 'something', 'anything', 'everything', 'nothing',
  'please', 'help', 'find', 'show', 'get', 'tell', 'give', 'make',
  'hey', 'hi', 'hello', 'ok', 'okay', 'thanks', 'thank',
]);

const STOP_WORDS_ES = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
  'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas',
  'yo', 'me', 'mi', 'mis', 'nosotros', 'nosotras', 'nuestro', 'nuestra',
  'tu', 'tus', 'usted', 'ustedes', 'ellos', 'ellas', 'su', 'sus',
  'de', 'del', 'a', 'al', 'en', 'con', 'por', 'para',
  'sobre', 'entre', 'hacia', 'desde', 'hasta', 'sin',
  'y', 'o', 'u', 'e', 'pero', 'si', 'porque', 'como',
  'es', 'son', 'fue', 'fueron', 'era', 'eran', 'ser', 'estar',
  'haber', 'tener', 'hacer', 'estoy', 'estamos', 'está', 'están',
  'ayer', 'hoy', 'mañana', 'antes', 'despues', 'después', 'ahora', 'recientemente',
  'que', 'qué', 'cómo', 'cuando', 'cuándo', 'donde', 'dónde', 'por qué',
  'favor', 'ayuda', 'hola', 'gracias', 'buenos', 'buenas',
  'cosa', 'cosas', 'algo', 'nada', 'todo', 'todos', 'todas',
  // very common filler verbs in chat
  'dime', 'dame', 'quiero', 'necesito', 'puedes', 'podrías',
  // interjections
  'oye', 'oiga', 'mira', 'vale', 'bueno',
]);

const MIN_TOKEN_LEN = 3;

function isValidKeyword(token) {
  if (!token || token.length < MIN_TOKEN_LEN) return false;
  // Drop pure numbers — chunk numbers like "2026" can be useful context but
  // also dominate noise ("page 12", "section 3.4"); safer to drop by default.
  if (/^\d+$/.test(token)) return false;
  return true;
}

/**
 * Split on whitespace and punctuation, keeping Unicode letters and
 * digits together. Lowercases everything.
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  const normalized = text.toLowerCase().trim();
  const segments = normalized.split(/[\s\p{P}\p{S}]+/u).filter(Boolean);
  return segments;
}

/**
 * Return the ordered, de-duplicated content words of a query.
 */
function extractKeywords(query) {
  const tokens = tokenize(query);
  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    if (STOP_WORDS_EN.has(t) || STOP_WORDS_ES.has(t)) continue;
    if (!isValidKeyword(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Produce an expanded query string that mixes the original text with
 * extracted keywords. Used as the input to a second embedding pass so
 * retrieval gets both the conversational framing and the raw content
 * terms.
 *
 * If no keywords survive filtering, falls back to the original query
 * unchanged.
 */
function expandQuery(query) {
  const original = (query || '').trim();
  const keywords = extractKeywords(original);
  const expanded = keywords.length > 0 ? `${original} ${keywords.join(' ')}` : original;
  return { original, keywords, expanded };
}

module.exports = {
  tokenize,
  extractKeywords,
  expandQuery,
  STOP_WORDS_EN,
  STOP_WORDS_ES,
};

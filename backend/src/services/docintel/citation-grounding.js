/**
 * citation-grounding — gate that rejects a generated answer if ANY
 * factual claim is not grounded in ≥ 1 of the supplied sources.
 *
 * A "claim" is a sentence in the answer that is factual in nature
 * (contains a number, a named entity, or a strong assertion verb).
 * We do NOT do natural-language entailment here. Grounding is
 * approximated by token-overlap (bag-of-words Jaccard) between the
 * claim and each source's text, plus a substring-match bonus for
 * long phrases and a numeric-match bonus (numbers, percentages,
 * dates, currency figures).
 *
 * Deterministic. Pure JS. No external deps.
 *
 * Output:
 *   {
 *     ok,                         // all claims grounded
 *     stats: { claims, grounded, flagged, coverage },
 *     claims: [
 *       { id, sentence, is_factual, grounded, best_source_id,
 *         best_score, matched_numbers, matched_spans }
 *     ],
 *     flagged: [ ... only the ungrounded factual claims ... ]
 *   }
 */

const FACTUAL_VERBS = new Set([
  "increased", "decreased", "grew", "fell", "rose", "reached",
  "reported", "announced", "declared", "found", "showed", "revealed",
  "concluded", "indicates", "proves", "confirmed", "released",
  "published", "filed", "approved", "rejected", "acquired", "sold",
  "launched", "discovered", "estimates", "projects", "forecasts",
  "founded", "established", "invented", "built", "signed",
]);

const NAMED_ENTITY_HINT = /\b([A-Z][a-z]{2,}(?:\s[A-Z][a-z]+)*)\b/;
const NUMBER_REGEX = /(\$\s?\d[\d.,]*|\d[\d.,]*\s?%|\d{4}(?:-\d{2}-\d{2})?|\d[\d.,]*)/g;
const STOP = new Set([
  "the", "a", "an", "of", "to", "in", "on", "at", "for", "by", "with",
  "and", "or", "but", "as", "is", "are", "was", "were", "be", "been",
  "being", "this", "that", "these", "those", "it", "its", "their",
  "his", "her", "from", "into", "about", "than", "then", "so", "not",
  "no", "yes", "he", "she", "we", "they", "you", "i", "me", "us",
  "our", "your", "them", "which", "who", "whom", "whose", "there",
  "here", "have", "has", "had", "do", "does", "did", "will", "would",
  "can", "could", "should", "may", "might", "must", "shall", "also",
]);

const SHINGLE_LEN = 4;
const SHINGLE_MIN_TOKENS = 3;

function groundClaims({ answer, sources, thresholds = {} } = {}) {
  if (typeof answer !== "string" || answer.trim().length === 0) {
    return shellEmpty("answer (non-empty string) required");
  }
  if (!Array.isArray(sources) || sources.length === 0) {
    return shellEmpty("sources (array) required");
  }
  const minScore = thresholds.min_score ?? 0.18;
  const minNumberMatch = thresholds.min_number_match ?? 1;
  const minPhraseLen = thresholds.min_phrase_len ?? SHINGLE_LEN;

  const indexed = sources.map((s, i) => ({
    id: s.id || `src_${i + 1}`,
    text: typeof s.text === "string" ? s.text : "",
    tokens: tokenize(typeof s.text === "string" ? s.text : ""),
    token_set: new Set(tokenize(typeof s.text === "string" ? s.text : "")),
    numbers: extractNumbers(typeof s.text === "string" ? s.text : ""),
  }));

  const sentences = splitSentences(answer);
  const claims = sentences.map((sentence, i) => {
    const factual = isFactual(sentence);
    const analysis = bestMatch(sentence, indexed, { minPhraseLen });
    const grounded = !factual ? true : (
      analysis.score >= minScore ||
      analysis.matched_numbers.length >= minNumberMatch && analysis.score >= minScore * 0.6 ||
      analysis.matched_spans.length >= 1
    );
    return {
      id: `c_${i + 1}`,
      sentence,
      is_factual: factual,
      grounded,
      best_source_id: analysis.source_id,
      best_score: Math.round(analysis.score * 100) / 100,
      matched_numbers: analysis.matched_numbers,
      matched_spans: analysis.matched_spans,
    };
  });

  const factualClaims = claims.filter(c => c.is_factual);
  const flagged = factualClaims.filter(c => !c.grounded);
  const grounded = factualClaims.length - flagged.length;
  const coverage = factualClaims.length === 0 ? 1 : Math.round((grounded / factualClaims.length) * 100) / 100;

  return {
    ok: flagged.length === 0,
    stats: {
      claims: claims.length,
      factual: factualClaims.length,
      grounded,
      flagged: flagged.length,
      coverage,
    },
    claims,
    flagged,
  };
}

function shellEmpty(msg) {
  return {
    ok: false,
    stats: { claims: 0, factual: 0, grounded: 0, flagged: 0, coverage: 0 },
    claims: [],
    flagged: [],
    error: msg,
  };
}

function splitSentences(text) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const parts = cleaned.split(/(?<=[.!?])\s+(?=[A-ZÀ-Þ0-9"(])/);
  return parts.map(p => p.trim()).filter(p => p.length >= 8);
}

function isFactual(sentence) {
  if (NUMBER_REGEX.test(sentence)) { NUMBER_REGEX.lastIndex = 0; return true; }
  NUMBER_REGEX.lastIndex = 0;
  // Named-entity test: skip the sentence-initial word (always capitalized),
  // then look for ≥ 1 remaining capitalized multi-char token.
  const afterFirst = sentence.replace(/^\s*\S+\s*/, "");
  if (NAMED_ENTITY_HINT.test(afterFirst)) return true;
  const tokens = sentence.toLowerCase().split(/\W+/).filter(Boolean);
  if (tokens.some(t => FACTUAL_VERBS.has(t))) return true;
  return false;
}

function bestMatch(sentence, indexed, opts) {
  const stoks = tokenize(sentence);
  const stokSet = new Set(stoks);
  const numbers = extractNumbers(sentence);

  let best = { score: 0, source_id: null, matched_numbers: [], matched_spans: [] };

  for (const src of indexed) {
    if (src.tokens.length === 0) continue;
    const jaccard = jaccardScore(stokSet, src.token_set);
    const numMatches = [...numbers].filter(n => src.numbers.has(n));
    const phrases = longestCommonShingles(stoks, src.tokens, opts.minPhraseLen);
    const phraseBonus = phrases.length >= 1 ? 0.25 : 0;
    const numBonus = numMatches.length > 0 ? Math.min(0.2, numMatches.length * 0.08) : 0;
    const score = jaccard + phraseBonus + numBonus;

    if (score > best.score) {
      best = {
        score,
        source_id: src.id,
        matched_numbers: numMatches,
        matched_spans: phrases.slice(0, 5),
      };
    }
  }
  return best;
}

function tokenize(text) {
  return String(text).toLowerCase()
    .split(/[^a-z0-9à-ÿ]+/i)
    .filter(t => t.length >= 3 && !STOP.has(t));
}

function jaccardScore(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function extractNumbers(text) {
  const out = new Set();
  const matches = String(text).match(NUMBER_REGEX) || [];
  for (const m of matches) {
    const normalized = m.replace(/\s/g, "").replace(/,/g, "");
    if (normalized.length > 0) out.add(normalized);
  }
  return out;
}

function longestCommonShingles(a, b, minLen) {
  if (a.length < minLen || b.length < minLen) return [];
  const shA = new Set();
  for (let i = 0; i <= a.length - minLen; i++) shA.add(a.slice(i, i + minLen).join(" "));
  const hits = [];
  for (let i = 0; i <= b.length - minLen; i++) {
    const s = b.slice(i, i + minLen).join(" ");
    if (shA.has(s)) hits.push(s);
  }
  return dedupe(hits);
}

function dedupe(arr) {
  return [...new Set(arr)];
}

module.exports = {
  groundClaims,
  splitSentences,
  isFactual,
  extractNumbers,
  tokenize,
};

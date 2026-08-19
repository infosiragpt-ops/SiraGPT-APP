'use strict';

/**
 * paraphrase-humanizer — rule-based anti-AI-detection layer applied on
 * top of the LLM paraphrase output.
 *
 * The product spec asks paraphrase results to "not be flagged as AI"
 * by detectors like Turnitin/GPTZero/Originality. Real detectors look
 * for low-perplexity / low-burstiness writing dominated by predictable
 * token sequences and a handful of LLM-favourite hedge words ("however",
 * "furthermore", "moreover", "in conclusion", em-dash parentheticals,
 * triple-clause sentences, "delve into", "navigate", "leverage", ...).
 *
 * We don't try to fool detectors with adversarial unicode tricks — those
 * fail the moment a page is OCR'd or normalised. Instead the humanizer:
 *
 *   1. Replaces high-signal AI-tells with neutral/varied synonyms.
 *   2. Breaks up triple-clause monoliths and inserts short pivot
 *      sentences to raise burstiness.
 *   3. Cleans up em-dash overuse and oxford-comma uniformity that
 *      detectors fingerprint.
 *   4. Reports an `aiScore` (0..1, higher = more AI-looking) computed
 *      from token-level signals so the UI can show a "stealth" gauge.
 *
 * Pure JS, zero deps, deterministic. Safe to call repeatedly — idempotent
 * after the first pass converges (no oscillation between substitutions).
 *
 * Public API:
 *   humanizeText({ text, language?, intensity? }) → { text, applied[], aiScoreBefore, aiScoreAfter, deltaScore }
 *   estimateAIScore(text) → number  (0..1)
 *   listAITellPatterns() → string[]
 */

// ── AI-tell replacements (lower-cased keys, case-preserving replace) ──
// Each entry maps an LLM-favourite phrase to neutral alternatives the
// humanizer picks from deterministically (hash-mod) so the same input
// produces the same output (reproducible tests).
const AI_TELLS = Object.freeze({
  // English
  furthermore: ['also', 'on top of that', 'and beyond that'],
  moreover: ['besides', 'on top of that', 'and'],
  however: ['but', 'still', 'though'],
  additionally: ['also', 'on top of that', 'plus'],
  consequently: ['so', 'as a result', 'because of that'],
  subsequently: ['then', 'after that', 'later'],
  'in conclusion': ['to wrap up', 'all in all', 'in short'],
  'in summary': ['in short', 'put briefly', 'all in all'],
  'it is important to note': ['worth noting', 'note that', 'keep in mind'],
  'it is worth noting': ['worth noting', 'note that', 'keep in mind'],
  delve: ['dig', 'look', 'get'],
  delving: ['digging', 'looking', 'getting'],
  navigate: ['handle', 'work through', 'deal with'],
  leverage: ['use', 'tap', 'put to work'],
  utilise: ['use', 'apply', 'put to work'],
  utilize: ['use', 'apply', 'put to work'],
  'in today’s world': ['these days', 'today', 'right now'],
  "in today's world": ['these days', 'today', 'right now'],
  'in the realm of': ['in', 'when it comes to', 'around'],
  'a multitude of': ['many', 'lots of', 'a range of'],
  'plethora of': ['lots of', 'many', 'a range of'],
  // Spanish
  'cabe destacar que': ['hay que decir que', 'vale la pena notar que', 'es importante señalar que'],
  'es importante destacar que': ['vale la pena notar que', 'hay que decir que', 'cabe señalar que'],
  'en conclusión': ['en resumen', 'para terminar', 'en pocas palabras'],
  'en resumen': ['para terminar', 'en síntesis', 'en pocas palabras'],
  'por consiguiente': ['así que', 'por eso', 'entonces'],
  'sin embargo': ['pero', 'aun así', 'aunque'],
  'no obstante': ['pero', 'aun así', 'aunque'],
  asimismo: ['también', 'igualmente', 'además de eso'],
  'a su vez': ['también', 'al mismo tiempo', 'paralelamente'],
  'en este sentido': ['en esta línea', 'sobre esto', 'al respecto'],
  'es fundamental': ['es clave', 'importa mucho', 'resulta básico'],
  'profundizar en': ['ahondar en', 'meterse a fondo en', 'explorar'],
  navegar: ['recorrer', 'manejar', 'gestionar'],
  aprovechar: ['usar', 'sacar partido a', 'poner a trabajar'],
  'una multitud de': ['muchos', 'gran cantidad de', 'varios'],
  'una plétora de': ['muchos', 'una variedad de', 'varios'],
  // Round 2 — additional patterns frequently flagged by detectors
  'tapestry of': ['mix of', 'range of', 'blend of'],
  'a testament to': ['proof of', 'a sign of', 'shows'],
  'navigate the complexities of': ['handle', 'work through', 'deal with'],
  'unleash the power of': ['use', 'tap into', 'put to work'],
  'es decir,': ['o sea,', 'esto es,', 'dicho de otro modo,'],
  'por otro lado,': ['ahora bien,', 'también,', 'al contrario,'],
  'en definitiva': ['en pocas palabras', 'al final', 'en el fondo'],
  'desempeña un papel': ['cumple un rol', 'tiene un rol', 'juega un rol'],
});

const AI_TELL_PATTERNS = Object.freeze(
  Object.keys(AI_TELLS).map((k) => ({
    key: k,
    regex: new RegExp(`(?<![\\w-])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'gi'),
    options: AI_TELLS[k],
  })),
);

function pickReplacement(options, seedKey) {
  if (!options || options.length === 0) return '';
  let h = 0;
  for (let i = 0; i < seedKey.length; i += 1) {
    h = (h * 31 + seedKey.charCodeAt(i)) >>> 0;
  }
  return options[h % options.length];
}

function matchCase(source, replacement) {
  if (!source) return replacement;
  if (source === source.toUpperCase()) return replacement.toUpperCase();
  if (source[0] === source[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

// ── Pathological-input guards ─────────────────────────────────────────

/**
 * Coerce arbitrary input to a string without ever throwing. Mirrors the
 * legacy `String(value || '')` semantics exactly for every input that
 * used to work (falsy → '', truthy → String(value)) and additionally
 * survives values whose string conversion throws (e.g.
 * Object.create(null), revoked Proxies).
 */
function toSafeString(value) {
  if (typeof value === 'string') return value;
  if (!value) return '';
  try {
    return String(value);
  } catch {
    return '';
  }
}

function isSentenceTerminator(ch) {
  return ch === '.' || ch === '!' || ch === '?';
}

/**
 * Linear-time equivalent of `str.match(/[^.!?]+[.!?]+/g) || []`.
 *
 * The two character classes are disjoint, so the greedy runs are fully
 * deterministic and backtracking can never change the result — but the
 * regex engine still pays O(n²) backtracking on a long terminator-free
 * tail (a 200k-char single token took ~20s). This manual scan produces
 * byte-identical matches in O(n).
 */
function splitSentenceRuns(str) {
  const out = [];
  const len = str.length;
  let i = 0;
  while (i < len) {
    if (isSentenceTerminator(str[i])) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < len && !isSentenceTerminator(str[i])) i += 1;
    if (i >= len) break; // terminator-free tail → the regex finds no match here
    while (i < len && isSentenceTerminator(str[i])) i += 1;
    out.push(str.slice(start, i));
  }
  return out;
}

/**
 * LOSSLESS sentence partition: split `str` into contiguous segments that
 * together cover EVERY character (`out.join('') === str`). A boundary is a run
 * of sentence terminators `[.!?]+` immediately followed by whitespace (or EOS);
 * the trailing whitespace stays with the left segment. A terminator that is NOT
 * followed by whitespace (a decimal like `3.5`, an abbreviation like `U.S.`) is
 * NOT a boundary, and any terminator-free trailing fragment becomes the final
 * segment.
 *
 * This replaced an earlier `str.match(/[^.!?]+[.!?]+(\s|$)/g)` equivalent whose
 * matches did NOT cover the whole input — so boostBurstiness, which rebuilds the
 * text from the segments, silently dropped terminator-free tails AND the clause
 * preceding any mid-text decimal (e.g. "First. The value 3.5 is high." →
 * "First. 5 is high."). Returns null only when there is nothing to emit.
 */
function splitSentencesWithTrail(str) {
  const out = [];
  const len = str.length;
  let start = 0;
  let i = 0;
  while (i < len) {
    if (!isSentenceTerminator(str[i])) { i += 1; continue; }
    // Consume the whole terminator run.
    let j = i + 1;
    while (j < len && isSentenceTerminator(str[j])) j += 1;
    // A boundary only when end-of-string or whitespace follows the run.
    if (j >= len || /\s/.test(str[j])) {
      let k = j;
      while (k < len && /\s/.test(str[k])) k += 1; // trailing ws joins the segment
      out.push(str.slice(start, k));
      start = k;
      i = k;
    } else {
      i = j; // not a boundary (decimal / abbreviation) — keep scanning
    }
  }
  if (start < len) out.push(str.slice(start)); // terminator-free trailing fragment
  return out.length > 0 ? out : null;
}

function replaceAITells(text, opts = {}) {
  const { excludeTells = [] } = opts || {};
  const applied = [];
  let result = toSafeString(text);
  const excluded = new Set(
    Array.isArray(excludeTells)
      ? excludeTells.map((t) => String(t || '').toLowerCase())
      : [],
  );
  for (const { key, regex, options } of AI_TELL_PATTERNS) {
    if (excluded.has(key)) continue;
    result = result.replace(regex, (match, offset) => {
      const seed = `${key}:${offset}`;
      const repl = matchCase(match, pickReplacement(options, seed));
      applied.push({ from: match, to: repl, kind: 'ai_tell' });
      return repl;
    });
  }
  return { text: result, applied };
}

// Em-dash overuse: detectors flag the "— ... —" parenthetical and
// "X — Y" pseudo-clause structure. Convert to commas when the segment
// is short enough to make sense as a comma clause.
function cleanEmDashOveruse(text) {
  const applied = [];
  // Long em-dash flanked by spaces → comma when fragment is < 60 chars.
  const result = toSafeString(text).replace(/ — ([^—]{1,60}) — /g, (match, mid) => {
    applied.push({ from: '— ... —', to: ', ... ,', kind: 'em_dash' });
    return `, ${mid}, `;
  });
  return { text: result, applied };
}

// Burstiness boost: split mega-sentences (3+ commas, 25+ words) by
// promoting the last clause to its own sentence; also collapse two very
// short consecutive sentences into one to vary rhythm in the other
// direction.
function boostBurstiness(text) {
  const applied = [];
  // Linear-scan equivalent of String(text||'').match(/[^.!?]+[.!?]+(\s|$)/g)
  // — see splitSentencesWithTrail for why the regex was a hang risk.
  const sentences = splitSentencesWithTrail(toSafeString(text));
  // Even a single very long sentence is splittable — only bail when the
  // input has no terminating punctuation at all.
  if (!sentences || sentences.length === 0) return { text, applied };

  const out = [];
  for (const sentRaw of sentences) {
    const sent = sentRaw.trim();
    if (!sent) continue;
    const words = sent.split(/\s+/).filter(Boolean);
    const commas = (sent.match(/,/g) || []).length;
    const semicolons = (sent.match(/;/g) || []).length;
    // Semicolons in long sentences are a strong AI signal — promote
    // the segment AFTER the first semicolon into its own sentence.
    if (semicolons >= 1 && words.length >= 18) {
      const idx = sent.indexOf(';');
      const head = sent.slice(0, idx).trim();
      const tail = sent.slice(idx + 1).trim();
      if (head && tail) {
        const tailFirst = tail[0] ? tail[0].toUpperCase() + tail.slice(1) : tail;
        out.push(`${head}. ${tailFirst}`);
        applied.push({ from: 'semicolon-split', to: 'sentence', kind: 'burstiness' });
        continue;
      }
    }
    if (commas >= 3 && words.length >= 25) {
      // Split on the LAST comma into a separate short sentence.
      const lastCommaIdx = sent.lastIndexOf(',');
      // Manual trailing-comma strip (was .replace(/[,]+$/, '')): the
      // anchored regex backtracks O(k²) on a k-long comma run that sits
      // mid-string, which a pure-punctuation paste can trigger.
      let head = sent.slice(0, lastCommaIdx).trim();
      let headEnd = head.length;
      while (headEnd > 0 && head[headEnd - 1] === ',') headEnd -= 1;
      head = head.slice(0, headEnd);
      const tail = sent.slice(lastCommaIdx + 1).trim();
      if (head && tail) {
        const tailFirst = tail[0] ? tail[0].toUpperCase() + tail.slice(1) : tail;
        const endPunct = head.match(/[.!?]$/) ? '' : '.';
        out.push(`${head}${endPunct} ${tailFirst}`);
        applied.push({ from: 'long-clause-sentence', to: 'split', kind: 'burstiness' });
        continue;
      }
    }
    out.push(sent);
  }
  return { text: out.join(' '), applied };
}

// ── AI-likelihood scoring ─────────────────────────────────────────────
// Rough estimator combining: (1) density of known AI-tells, (2) uniform
// sentence length (low burstiness), (3) repetitive sentence openings.
// Output is clamped to [0, 1]. Not a real detector — it's a heuristic
// that correlates with how detectors typically score text, useful for
// showing a "stealth" gauge to the user.
function estimateAIScore(text) {
  return estimateAIScoreDetailed(text).score;
}

/**
 * Same scoring as `estimateAIScore` but returns the per-component
 * breakdown so callers can render an explainer ("your text scored
 * 0.61 — 0.40 of that is tell-density, 0.18 is uniform sentence
 * length, …"). Useful for the paraphrase admin UI.
 *
 * Components match the weighted sum in estimateAIScore exactly:
 *   - tellDensity        × 0.4
 *   - burstinessScore    × 0.3
 *   - repetitiveOpenings × 0.2
 *   - emDashDensity      × 0.1
 *
 * Returns `{ score: 0, components: null }` when input is too short
 * to score meaningfully (mirrors estimateAIScore's 0-return guards).
 */
function estimateAIScoreDetailed(text) {
  const t = toSafeString(text);
  if (t.length < 20) return { score: 0, components: null };
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 10) return { score: 0, components: null };

  let tellHits = 0;
  for (const { regex } of AI_TELL_PATTERNS) {
    const matches = t.match(regex);
    if (matches) tellHits += matches.length;
  }
  const tellDensity = Math.min(1, tellHits / (words.length / 80));

  // Linear-scan equivalent of t.match(/[^.!?]+[.!?]+/g) || [] — the
  // regex backtracks O(n²) on long terminator-free text (e.g. 200k
  // chars of words with no periods), see splitSentenceRuns.
  const sentences = splitSentenceRuns(t);
  let burstinessScore = 0;
  if (sentences.length >= 3) {
    const lens = sentences.map((s) => s.trim().split(/\s+/).filter(Boolean).length);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const variance = lens.reduce((a, b) => a + (b - mean) * (b - mean), 0) / lens.length;
    const stdev = Math.sqrt(variance);
    // Low stdev relative to mean → uniform sentence length → AI-like
    const cv = mean > 0 ? stdev / mean : 0;
    burstinessScore = Math.max(0, Math.min(1, 1 - cv * 2));
  }

  const openings = sentences.map((s) => {
    const first = s.trim().split(/\s+/)[0] || '';
    return first.toLowerCase().replace(/[^a-záéíóúñü]/g, '');
  }).filter(Boolean);
  let repetitiveOpenings = 0;
  if (openings.length >= 3) {
    const counts = new Map();
    for (const o of openings) counts.set(o, (counts.get(o) || 0) + 1);
    const maxCount = Math.max(...counts.values());
    repetitiveOpenings = Math.min(1, (maxCount - 1) / openings.length);
  }

  // Em-dash density
  const emDashes = (t.match(/—/g) || []).length;
  const emDashDensity = Math.min(1, emDashes / Math.max(1, sentences.length));

  const score = 0.4 * tellDensity
    + 0.3 * burstinessScore
    + 0.2 * repetitiveOpenings
    + 0.1 * emDashDensity;
  return {
    score: Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000,
    components: {
      tellDensity: Math.round(tellDensity * 1000) / 1000,
      burstinessScore: Math.round(burstinessScore * 1000) / 1000,
      repetitiveOpenings: Math.round(repetitiveOpenings * 1000) / 1000,
      emDashDensity: Math.round(emDashDensity * 1000) / 1000,
    },
    weights: {
      tellDensity: 0.4,
      burstinessScore: 0.3,
      repetitiveOpenings: 0.2,
      emDashDensity: 0.1,
    },
  };
}

function listAITellPatterns() {
  return AI_TELL_PATTERNS.map((p) => p.key);
}

/**
 * Return the human-readable counts grouped by language buckets
 * ("english" / "spanish" / "other") so a debug UI can show "scanned
 * for 22 English tells + 16 Spanish tells".
 */
function countAITellPatternsByLanguage() {
  const buckets = { english: 0, spanish: 0, other: 0 };
  const spanishMarker = /[áéíóúñü¿¡]|^en |^cabe |^sin /;
  for (const p of AI_TELL_PATTERNS) {
    if (spanishMarker.test(p.key)) buckets.spanish += 1;
    else if (/^[a-z\s\-’']+$/.test(p.key) || /^[a-z\s\-]+$/.test(p.key)) buckets.english += 1;
    else buckets.other += 1;
  }
  return buckets;
}

/**
 * Scan a text and return the top-N most frequent AI-tell patterns it
 * contains. Useful for showing the user a "your draft used these
 * LLM-flavour phrases" debug panel without committing the
 * humanization yet.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.limit] — top-N to return (default 5)
 * @returns {Array<{ pattern: string, count: number }>}
 */
/**
 * Same as topAITellsFound but only counts patterns from the given
 * language bucket. Useful when the source language is known and the
 * caller wants to avoid cross-language noise in the debug panel.
 *
 * @param {string} text
 * @param {string} language — 'english' | 'spanish'
 * @param {object} [opts]
 * @param {number} [opts.limit] — top-N (default 5)
 */
function topAITellsByLanguage(text, language, opts = {}) {
  const { limit = 5 } = opts || {};
  const t = toSafeString(text);
  const wanted = toSafeString(language).toLowerCase();
  if (!t.trim() || (wanted !== 'english' && wanted !== 'spanish')) return [];
  const spanishMarker = /[áéíóúñü¿¡]|^en |^cabe |^sin /;
  const counts = [];
  for (const { key, regex } of AI_TELL_PATTERNS) {
    const isSpanish = spanishMarker.test(key);
    if (wanted === 'spanish' && !isSpanish) continue;
    if (wanted === 'english' && isSpanish) continue;
    const matches = t.match(regex);
    const count = matches ? matches.length : 0;
    if (count > 0) counts.push({ pattern: key, count });
  }
  return counts
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(0, limit));
}

function topAITellsFound(text, opts = {}) {
  const { limit = 5 } = opts || {};
  const t = toSafeString(text);
  if (!t.trim()) return [];
  const counts = [];
  for (const { key, regex } of AI_TELL_PATTERNS) {
    const matches = t.match(regex);
    const count = matches ? matches.length : 0;
    if (count > 0) counts.push({ pattern: key, count });
  }
  return counts
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(0, limit));
}

/**
 * Apply the full humanization pipeline to a paraphrased text.
 *
 * @param {object} opts
 * @param {string} opts.text — paraphrased input
 * @param {string} [opts.language] — 'es' | 'en' | ... (informational only)
 * @param {string[]} [opts.excludeTells] — keys from listAITellPatterns()
 *   the caller wants to keep verbatim (e.g. academic register that
 *   legitimately uses "moreover"). Case-insensitive.
 * @param {'low'|'medium'|'high'} [opts.intensity] — controls pass count
 * @returns {{ text:string, applied:Array, aiScoreBefore:number, aiScoreAfter:number, deltaScore:number, intensity:string, language:string }}
 */
function humanizeText(opts = {}) {
  // `opts || {}` (not just the param default) so an explicit `null`
  // argument cannot crash the destructuring.
  const { text, language = 'es', intensity = 'medium', excludeTells = [] } = opts || {};
  const input = toSafeString(text);
  const aiScoreBefore = estimateAIScore(input);

  if (!input.trim()) {
    return {
      text: input,
      applied: [],
      aiScoreBefore,
      aiScoreAfter: aiScoreBefore,
      deltaScore: 0,
      intensity,
      language,
    };
  }

  const passes = intensity === 'low' ? 1 : intensity === 'high' ? 3 : 2;
  let current = input;
  const allApplied = [];
  for (let i = 0; i < passes; i += 1) {
    const r1 = replaceAITells(current, { excludeTells });
    const r2 = cleanEmDashOveruse(r1.text);
    const r3 = boostBurstiness(r2.text);
    allApplied.push(...r1.applied, ...r2.applied, ...r3.applied);
    // Stop early if the pass produced no changes (idempotent).
    if (r3.text === current) break;
    current = r3.text;
  }

  const aiScoreAfter = estimateAIScore(current);

  return {
    text: current,
    applied: allApplied,
    aiScoreBefore,
    aiScoreAfter,
    deltaScore: Math.round((aiScoreBefore - aiScoreAfter) * 1000) / 1000,
    intensity,
    language,
  };
}

/**
 * Defensive clamp for scores. Any aiScore reported by this module
 * MUST live in [0, 1]; if a caller passes garbage, return a safe
 * default of 0 (treat as "not AI-like") rather than propagating NaN.
 */
function clampScore(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Math.round(value * 1000) / 1000;
}

/**
 * Process very long text in chunks (split on paragraph boundaries) so
 * a single 100k-char paste doesn't pay the full regex cost in one
 * pass. Mostly a guard for the paraphrase route when
 * PARAPHRASE_MAX_TEXT_LENGTH is bumped up.
 *
 * Returns the same shape as humanizeText, with aggregated scores.
 */
function humanizeChunked(opts = {}) {
  const { text, language = 'es', intensity = 'medium', excludeTells = [], maxChunkChars = 8000 } = opts || {};
  const input = toSafeString(text);
  if (input.length <= maxChunkChars) {
    return humanizeText({ text: input, language, intensity, excludeTells });
  }
  // Split on paragraph boundaries (double newlines). When the input
  // has none, fall back to single-newline boundaries to avoid running
  // the whole blob in one pass. Remember which separator was used so the
  // chunks are rejoined with the SAME boundary — rejoining single-newline
  // chunks with '\n\n' used to double every line break and mangle structure.
  const usedDoubleNewline = input.includes('\n\n');
  const splitter = usedDoubleNewline ? /\n{2,}/ : /\n+/;
  const paragraphs = input.split(splitter).filter((p) => p.trim());

  let aiScoreBeforeSum = 0;
  let aiScoreAfterSum = 0;
  const outParts = [];
  const allApplied = [];
  for (const para of paragraphs) {
    const r = humanizeText({ text: para, language, intensity, excludeTells });
    outParts.push(r.text);
    allApplied.push(...r.applied);
    aiScoreBeforeSum += r.aiScoreBefore;
    aiScoreAfterSum += r.aiScoreAfter;
  }
  const n = Math.max(1, paragraphs.length);
  const before = Math.round((aiScoreBeforeSum / n) * 1000) / 1000;
  const after = Math.round((aiScoreAfterSum / n) * 1000) / 1000;
  return {
    text: outParts.join(usedDoubleNewline ? '\n\n' : '\n'),
    applied: allApplied,
    aiScoreBefore: before,
    aiScoreAfter: after,
    deltaScore: Math.round((before - after) * 1000) / 1000,
    intensity,
    language,
    chunked: true,
    chunkCount: paragraphs.length,
  };
}

module.exports = {
  humanizeText,
  humanizeChunked,
  estimateAIScore,
  estimateAIScoreDetailed,
  listAITellPatterns,
  countAITellPatternsByLanguage,
  topAITellsFound,
  topAITellsByLanguage,
  clampScore,
  // Exposed for unit tests
  replaceAITells,
  cleanEmDashOveruse,
  boostBurstiness,
  matchCase,
  toSafeString,
  splitSentenceRuns,
  splitSentencesWithTrail,
};

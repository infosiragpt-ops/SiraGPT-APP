'use strict';

/**
 * passage-extractor — turn a source's text (markdown/HTML/snippet) into the
 * sentences most relevant to a query, so the answer-synthesizer can quote
 * grounded, citable passages (Perplexity-style) instead of whole pages.
 *
 * Pure + deterministic: relevance is the stem/synonym-aware token overlap from
 * query-intelligence, so it runs in microseconds with no model or network.
 */

const qi = require('../agents/web-search/query-intelligence');

/** Strip markdown + HTML to readable plain text. */
function cleanText(input) {
  let s = String(input || '');
  // Remove fenced code blocks and inline code (rarely citable prose).
  s = s.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  // Markdown links/images → keep the visible text.
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // HTML tags → space.
  s = s.replace(/<[^>]+>/g, ' ');
  // Markdown emphasis / headers / list markers / blockquotes.
  s = s.replace(/^[#>\-*+\s]{0,6}/gm, ' ').replace(/[*_~]{1,3}/g, '');
  // HTML entities (common).
  s = s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
  // Collapse whitespace.
  return s.replace(/\s+/g, ' ').trim();
}

// Common abbreviations whose trailing period must NOT end a sentence.
const ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'sra', 'srta', 'vs', 'etc', 'ej',
  'p', 'pp', 'fig', 'no', 'núm', 'num', 'art', 'ed', 'eds', 'vol', 'inc',
  'ltd', 'co', 'st', 'ave', 'ph', 'al', 'i.e', 'e.g', 'ca', 'aprox',
]);

/**
 * Split text into sentences. Conservative: splits on . ! ? … followed by
 * whitespace + an uppercase/opening char, but not after a known abbreviation
 * or a single capital initial. Also splits on hard line breaks.
 */
function splitSentences(text) {
  const clean = cleanText(text);
  if (!clean) return [];
  const out = [];
  // First split on sentence terminators keeping reasonable boundaries.
  const parts = clean.split(/(?<=[.!?…])\s+(?=[“"'(¿¡A-ZÁÉÍÓÚÑ0-9])/u);
  for (const raw of parts) {
    const seg = raw.trim();
    if (!seg) continue;
    // Re-join an over-split fragment caused by an abbreviation at the end of
    // the previous segment (e.g. "Dr." | "Smith ...").
    const prev = out[out.length - 1];
    const lastWord = prev ? (prev.match(/([A-Za-zÁÉÍÓÚÑáéíóúñ.]+)\.$/) || [])[1] : null;
    if (prev && lastWord && ABBREV.has(lastWord.toLowerCase().replace(/\.$/, ''))) {
      out[out.length - 1] = `${prev} ${seg}`;
    } else {
      out.push(seg);
    }
  }
  return out;
}

/**
 * Extract the top-scoring passages (sentences) from a source's text for a
 * query. Returns [{ text, score, index }] sorted by descending relevance.
 *
 * @param {string} text       source text (markdown/HTML/plain).
 * @param {string} query      user query.
 * @param {object} [opts]
 * @param {number} [opts.maxPassages=3]   keep at most this many per source.
 * @param {number} [opts.minScore=0.15]   drop sentences below this relevance.
 * @param {number} [opts.minWords=5]      ignore very short fragments.
 * @param {number} [opts.maxWords=60]     ignore run-on fragments.
 */
function extractPassages(text, query, opts = {}) {
  const maxPassages = Math.max(1, Math.min(Number(opts.maxPassages) || 3, 10));
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0.15;
  const minWords = Number.isFinite(opts.minWords) ? opts.minWords : 5;
  const maxWords = Number.isFinite(opts.maxWords) ? opts.maxWords : 60;

  const qTokens = require('../agents/web-search/relevance').contentTokens(query);
  if (qTokens.length === 0) return [];
  const groups = qi.matchGroups(qTokens);

  const sentences = splitSentences(text);
  const scored = [];
  for (let i = 0; i < sentences.length; i++) {
    const sent = sentences[i];
    const words = sent.split(/\s+/).filter(Boolean);
    if (words.length < minWords || words.length > maxWords) continue;
    const forms = new Set();
    for (const w of words) {
      const t = qi.stripDiacritics(w.toLowerCase()).replace(/[^a-z0-9]/g, '');
      if (!t) continue;
      forms.add(t);
      forms.add(qi.stem(t));
    }
    let hits = 0;
    for (const g of groups) {
      for (const form of g) { if (forms.has(form)) { hits += 1; break; } }
    }
    if (hits === 0) continue;
    // Coverage of query terms + a tiny prior for earlier (lead) sentences.
    const coverage = hits / groups.length;
    const positionPrior = 1 - Math.min(i, 20) / 60; // 1.0 → ~0.67
    const score = coverage * 0.85 + positionPrior * 0.15;
    if (score < minScore) continue;
    scored.push({ text: sent, score, index: i });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, maxPassages);
}

module.exports = {
  cleanText,
  splitSentences,
  extractPassages,
};

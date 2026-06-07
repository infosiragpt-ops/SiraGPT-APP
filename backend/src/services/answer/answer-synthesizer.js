'use strict';

/**
 * answer-synthesizer — turn ranked sources into a grounded, professionally
 * cited answer (Perplexity / ChatGPT-search style): inline [n] citations, a
 * numbered reference list, de-duplicated passages and suggested follow-ups.
 *
 * The core is deterministic & extractive (selects the most relevant sentences
 * from each source and attributes them). An optional LLM rewrite step lives in
 * the answer-engine; this module never needs a model or the network, so it is
 * fully unit-testable.
 */

const { extractPassages, cleanText } = require('./passage-extractor');
const { contentTokens, rawTokens, scoreResult } = require('../agents/web-search/relevance');
const qi = require('../agents/web-search/query-intelligence');

/** Bounded query↔text relevance, reused for the snippet-fallback gate. */
function relevanceScore(query, result) {
  return scoreResult(query, result);
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** Normalised token set of a passage, for near-duplicate detection. */
function passageTokenSet(text) {
  return new Set(rawTokens(text));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Generate 3-4 deterministic follow-up questions from the query subject.
 */
function relatedQuestions(query, lang = 'es', aspects = []) {
  const subject = String(query || '').replace(/[¿?¡!.]+/g, '').trim();
  if (!subject) return [];
  const out = [];
  if (lang === 'en') {
    out.push(`How does ${subject} work?`);
    out.push(`What are the advantages and disadvantages of ${subject}?`);
    out.push(`What is the latest on ${subject}?`);
  } else {
    out.push(`¿Cómo funciona ${subject}?`);
    out.push(`¿Cuáles son las ventajas y desventajas de ${subject}?`);
    out.push(`¿Qué hay de nuevo sobre ${subject}?`);
  }
  for (const a of aspects.slice(0, 1)) {
    out.push(lang === 'en' ? `Tell me more about ${a}.` : `Cuéntame más sobre ${a}.`);
  }
  // Dedupe + cap.
  return Array.from(new Set(out)).slice(0, 4);
}

/**
 * Synthesize a cited answer.
 *
 * @param {string} query
 * @param {Array<{title,url,snippet,content?,domain?}>} sources  rank-ordered.
 * @param {object} [opts]
 * @param {number} [opts.maxPassages=8]      total passages in the answer.
 * @param {number} [opts.perSource=2]        max passages from one source.
 * @param {number} [opts.maxSources=12]      cap citations considered.
 * @param {string} [opts.lang]               override detected language.
 * @param {string[]} [opts.aspects]          sub-topics for related questions.
 * @returns {{ answer, citations, passages, relatedQuestions, usedSources,
 *             coverage }}
 */
function synthesize(query, sources, opts = {}) {
  const maxPassages = Math.max(1, Math.min(Number(opts.maxPassages) || 8, 20));
  const perSource = Math.max(1, Math.min(Number(opts.perSource) || 2, 5));
  const maxSources = Math.max(1, Math.min(Number(opts.maxSources) || 12, 50));
  const lang = opts.lang || qi.detectLanguage(query);
  const list = (Array.isArray(sources) ? sources : []).filter((s) => s && s.url).slice(0, maxSources);

  // Gather candidate passages per source (prefer fetched content over snippet).
  const candidates = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const text = s.content ? cleanText(s.content) : '';
    const fromContent = text ? extractPassages(text, query, { maxPassages: perSource + 1 }) : [];
    const fromSnippet = s.snippet ? extractPassages(s.snippet, query, { maxPassages: perSource, minWords: 4 }) : [];
    const picked = (fromContent.length ? fromContent : fromSnippet).slice(0, perSource);
    for (const p of picked) {
      candidates.push({ text: p.text.trim(), score: p.score, sourceIndex: i });
    }
    // Fallback: if no sentence cleared the per-sentence bar but the snippet is
    // still genuinely on-topic, use its first clause so a strong source can
    // contribute a citation. Gated on real query relevance so irrelevant
    // sources are never cited.
    if (picked.length === 0 && s.snippet) {
      const clause = cleanText(s.snippet).split(/[.;]\s/)[0];
      const rel = relevanceScore(query, { title: s.title, snippet: clause });
      if (clause && rel >= 0.3) {
        candidates.push({ text: clause.trim(), score: rel * 0.5, sourceIndex: i });
      }
    }
  }

  // Rank passages, then de-duplicate near-identical ones and cap per source.
  candidates.sort((a, b) => b.score - a.score);
  const chosen = [];
  const perSourceCount = new Map();
  const tokenSets = [];
  for (const c of candidates) {
    if (chosen.length >= maxPassages) break;
    const n = perSourceCount.get(c.sourceIndex) || 0;
    if (n >= perSource) continue;
    const ts = passageTokenSet(c.text);
    let dup = false;
    for (const prev of tokenSets) { if (jaccard(ts, prev) > 0.7) { dup = true; break; } }
    if (dup) continue;
    chosen.push(c);
    tokenSets.push(ts);
    perSourceCount.set(c.sourceIndex, n + 1);
  }

  // Build citation numbering for the sources actually used (stable order of
  // first appearance in the chosen passages).
  const citeNumber = new Map();
  const citations = [];
  for (const c of chosen) {
    if (!citeNumber.has(c.sourceIndex)) {
      const n = citations.length + 1;
      citeNumber.set(c.sourceIndex, n);
      const s = list[c.sourceIndex];
      citations.push({ n, title: s.title || domainOf(s.url) || 'Fuente', url: s.url, domain: s.domain || domainOf(s.url) });
    }
  }

  // Compose the answer: each passage ends with its [n] marker. Passages from
  // the same source in sequence share one marker.
  const parts = [];
  const passages = [];
  let lastCite = null;
  for (const c of chosen) {
    const n = citeNumber.get(c.sourceIndex);
    let text = c.text.replace(/\s*\[\d+\]\s*$/, '').trim();
    if (!/[.!?…]$/.test(text)) text += '.';
    const marker = ` [${n}]`;
    parts.push(n === lastCite ? text : text + marker);
    passages.push({ text, sourceIndex: c.sourceIndex, citation: n });
    lastCite = n;
  }
  const answer = parts.join(' ');

  // Coverage: fraction of query content terms present in the answer.
  const qTokens = contentTokens(query);
  const ansForms = new Set();
  for (const t of rawTokens(answer)) { ansForms.add(t); ansForms.add(qi.stem(t)); }
  let covered = 0;
  for (const g of qi.matchGroups(qTokens)) {
    for (const form of g) { if (ansForms.has(form)) { covered += 1; break; } }
  }
  const coverage = qTokens.length ? covered / qTokens.length : 0;

  return {
    answer,
    citations,
    passages,
    relatedQuestions: relatedQuestions(query, lang, opts.aspects || []),
    usedSources: citations.length,
    coverage: Math.round(coverage * 100) / 100,
  };
}

module.exports = { synthesize, relatedQuestions, domainOf };

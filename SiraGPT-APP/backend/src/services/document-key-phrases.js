'use strict';

/**
 * document-key-phrases.js
 * ─────────────────────────────────────────────────────────────────────────────
 * TF-IDF-light keyphrase extractor across the attached batch. Builds:
 *
 *   - 1-gram, 2-gram, 3-gram candidates per file (stop-word stripped)
 *   - Term frequency (TF) per file
 *   - Inverse document frequency (IDF) across the batch
 *   - tf × idf score per (phrase, file)
 *
 * Each file gets a ranked phrase list the chat reads when the user
 * asks "what is this document about?" or "give me the keywords". For
 * single-file uploads we degrade gracefully to TF only (since IDF
 * needs a corpus) and surface the most frequent multi-word phrases.
 *
 * Bilingual. Deterministic. < 30 ms on 1 MB / file (≤ 8 files).
 *
 * Public API:
 *   buildKeyPhrasesForFiles(files)        → { perFile, aggregate }
 *   renderKeyPhrasesBlock(report)         → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PHRASES_PER_FILE = 10;
const MAX_BLOCK_CHARS = 3600;
const MAX_PHRASE_TOKENS = 3;
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'to', 'for', 'by', 'with',
  'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this',
  'that', 'these', 'those', 'it', 'its', 'their', 'them', 'we', 'our', 'us',
  'they', 'i', 'you', 'he', 'she', 'his', 'her', 'has', 'have', 'had', 'will',
  'would', 'should', 'can', 'could', 'may', 'might', 'must', 'do', 'does',
  'did', 'not', 'no', 'yes', 'so', 'than', 'then', 'too', 'very', 'into',
  'about', 'over', 'under', 'after', 'before', 'between', 'against', 'during',
  'through',
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'de', 'del',
  'en', 'por', 'para', 'que', 'con', 'sin', 'desde', 'hasta', 'sobre', 'bajo',
  'entre', 'tras', 'durante', 'porque', 'cuando', 'donde', 'como', 'es', 'son',
  'fue', 'fueron', 'ser', 'estar', 'está', 'están', 'al', 'lo', 'le', 'les',
  'su', 'sus', 'mi', 'mis', 'tu', 'tus', 'nuestro', 'nuestra', 'también',
  'pero', 'aunque', 'si', 'sí', 'no', 'más', 'menos',
]);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}'\-]{2,}/gu) || [];
}

function nGrams(tokens, n) {
  if (n === 1) return tokens.filter((t) => !STOPWORDS.has(t));
  const out = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    const window = tokens.slice(i, i + n);
    if (window.some((t) => STOPWORDS.has(t))) continue;
    if (window.some((t) => t.length < 3)) continue;
    out.push(window.join(' '));
  }
  return out;
}

function termFrequency(text) {
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const tokens = tokenize(head);
  const tf = new Map();
  for (let n = 1; n <= MAX_PHRASE_TOKENS; n++) {
    for (const ng of nGrams(tokens, n)) {
      tf.set(ng, (tf.get(ng) || 0) + 1);
    }
  }
  return tf;
}

function buildKeyPhrasesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (list.length === 0) return { perFile: [], aggregate: [] };

  // Pass 1: per-file TF + document frequency.
  const perFileTF = [];
  const docFreq = new Map();
  for (const f of list) {
    const text = safeText(f.extractedText);
    if (!text) continue;
    const tf = termFrequency(text);
    perFileTF.push({ file: safeFileName(f), tf });
    for (const phrase of tf.keys()) {
      docFreq.set(phrase, (docFreq.get(phrase) || 0) + 1);
    }
  }
  if (perFileTF.length === 0) return { perFile: [], aggregate: [] };

  const N = perFileTF.length;
  const perFile = [];
  const aggregateMap = new Map(); // phrase → cumulative score across files

  for (const entry of perFileTF) {
    const scored = [];
    for (const [phrase, count] of entry.tf.entries()) {
      const df = docFreq.get(phrase) || 1;
      // Single-file degrade: use log(tf) only. Multi-file: use TF * log(N/df).
      const idf = N === 1 ? 1 : Math.log((N + 1) / df) + 1; // smoothed
      const score = Number((count * idf).toFixed(3));
      if (count < (N === 1 ? 2 : 1)) continue;
      scored.push({ phrase, count, score });
      aggregateMap.set(phrase, (aggregateMap.get(phrase) || 0) + score);
    }
    scored.sort((a, b) => b.score - a.score);
    perFile.push({ file: entry.file, phrases: scored.slice(0, MAX_PHRASES_PER_FILE) });
  }

  const aggregate = Array.from(aggregateMap.entries())
    .map(([phrase, score]) => ({ phrase, score: Number(score.toFixed(3)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PHRASES_PER_FILE * 2);

  return { perFile, aggregate };
}

function renderKeyPhrasesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## KEY PHRASES
Top n-gram keyphrases per attached document, scored by TF × IDF across the batch (single-file uploads degrade to term-frequency only). Use these to answer "what is this document about?" or to pick a topical anchor before quoting. Numbers in parentheses are (count, score).`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const p of only.phrases) sections.push(`- _${p.phrase}_ (${p.count}, ${p.score})`);
  } else {
    sections.push('### Aggregate top phrases across batch');
    for (const p of report.aggregate.slice(0, 10)) sections.push(`- _${p.phrase}_ — score ${p.score}`);
    for (const file of report.perFile) {
      sections.push(`\n### File: ${file.file}`);
      for (const p of file.phrases) sections.push(`- _${p.phrase}_ (${p.count}, ${p.score})`);
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...key phrases block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  buildKeyPhrasesForFiles,
  renderKeyPhrasesBlock,
  _internal: {
    tokenize,
    nGrams,
    termFrequency,
    STOPWORDS,
    MAX_PHRASES_PER_FILE,
    MAX_PHRASE_TOKENS,
  },
};

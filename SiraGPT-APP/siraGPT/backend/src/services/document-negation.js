'use strict';

/**
 * document-negation.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Measures negation density and flags double-negation patterns:
 *
 *   - Negation tokens: not, no, never, none, nobody, nothing, neither, nor
 *   - Spanish: no, ni, nunca, jamás, ninguno, ninguna, ningún, nadie, nada
 *   - Contractions: don't, doesn't, isn't, aren't, wasn't, weren't, won't,
 *     shouldn't, couldn't, wouldn't, can't, ain't
 *   - Negation density per 1000 words
 *
 * Routes "how negated?" / "double negatives?" to a citeable summary.
 *
 * Public API:
 *   extractNegation(text)         → NegationReport
 *   buildNegationForFiles(files)  → { perFile }
 *   renderNegationBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_BLOCK_CHARS = 4000;
const MIN_WORDS = 12;

const NEGATION_WORDS = new Set([
  'not', 'no', 'never', 'none', 'nobody', 'nothing', 'neither', 'nor',
  'ni', 'nunca', 'jamás', 'jamas', 'ninguno', 'ninguna', 'ningún', 'ningun', 'nadie', 'nada',
  "don't", "doesn't", "isn't", "aren't", "wasn't", "weren't", "won't",
  "shouldn't", "couldn't", "wouldn't", "can't", "ain't", "hasn't", "haven't",
  'dont', 'doesnt', 'isnt', 'arent', 'wasnt', 'werent', 'wont',
]);

const DOUBLE_NEG_RE = /\b(not|never|no|ni)\b[^.!?]*?\b(no|none|nothing|never|ni|nunca|nada|ninguno|ninguna)\b/gi;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function tokenize(text) {
  return text.toLowerCase().match(/[a-záéíóúñüäöß']{2,30}/giu) || [];
}

function extractNegation(input) {
  const text = safeText(input);
  if (!text) return { negationCount: 0, density: 0, doubleNegatives: 0, words: 0 };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const tokens = tokenize(head);
  if (tokens.length < MIN_WORDS) {
    return { negationCount: 0, density: 0, doubleNegatives: 0, words: tokens.length };
  }
  let negationCount = 0;
  for (const t of tokens) {
    if (NEGATION_WORDS.has(t)) negationCount += 1;
  }
  const density = Math.round((negationCount / tokens.length) * 1000 * 100) / 100;
  const doubleMatches = Array.from(head.matchAll(DOUBLE_NEG_RE));
  return {
    negationCount,
    density,
    doubleNegatives: doubleMatches.length,
    words: tokens.length,
  };
}

function buildNegationForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  for (const f of list) {
    const r = extractNegation(safeText(f.extractedText));
    if (r.negationCount === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, ...r });
  }
  return { perFile };
}

function renderEntry(e) {
  return `### File: ${e.file}\n- negations: **${e.negationCount}** / ${e.words} words (density ${e.density}/1k)\n- double negatives: ${e.doubleNegatives}`;
}

function renderNegationBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## NEGATION DENSITY
Counts of negation tokens per file (English: not/never/no/none/nobody/nothing/neither/nor + contractions; Spanish: no/ni/nunca/jamás/ninguno/ninguna/ningún/nadie/nada) plus double-negation pattern detection. Density reported per 1000 words. Routes "how negated?" / "double negatives?" to a citeable summary.`;
  const sections = report.perFile.map(renderEntry);
  let combined = `${heading}\n\n${sections.join('\n\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...negation block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractNegation,
  buildNegationForFiles,
  renderNegationBlock,
  _internal: {
    NEGATION_WORDS,
    DOUBLE_NEG_RE,
    tokenize,
  },
};

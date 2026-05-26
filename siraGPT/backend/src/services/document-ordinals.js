'use strict';

/**
 * document-ordinals.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects ordinal numbers used to denote ranking or position:
 *
 *   - Suffix form: 1st, 2nd, 3rd, 4th, 21st, 22nd
 *   - Word form: first, second, third, ... twentieth
 *   - Spanish word form: primero, segundo, tercero, ... décimo, primera, etc.
 *   - Spanish suffix: 1º / 1ra / 2do / 3er
 *   - Roman ordinals: I, II, III, IV (in title-like context)
 *
 * Routes "what rank?" / "what position?" / "which one?" to a citeable list.
 *
 * Public API:
 *   extractOrdinals(text)         → OrdinalReport
 *   buildOrdinalsForFiles(files)  → { perFile, aggregate, totals }
 *   renderOrdinalsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4500;

const ORDINAL_WORDS_EN = [
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth',
  'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth',
  'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth',
  'twentieth', 'twenty-first', 'twenty-second',
];

const ORDINAL_WORDS_ES = [
  'primero', 'primera', 'segundo', 'segunda', 'tercero', 'tercera', 'cuarto',
  'cuarta', 'quinto', 'quinta', 'sexto', 'sexta', 's[ée]ptimo', 's[ée]ptima',
  'octavo', 'octava', 'noveno', 'novena', 'd[ée]cimo', 'd[ée]cima',
  'und[ée]cimo', 'duod[ée]cimo',
];

const PATTERNS = [
  { kind: 'suffix-en', re: /\b(\d{1,4})(st|nd|rd|th)\b/g },
  { kind: 'word-en', re: new RegExp(`\\b(${ORDINAL_WORDS_EN.join('|')})\\b`, 'gi') },
  { kind: 'suffix-es', re: /(?<![A-Za-zÀ-ÿ0-9_])(\d{1,4})(º|ª|ro|ra|do|da|er|ta|to|mo)(?![A-Za-zÀ-ÿ0-9_])/g },
  { kind: 'word-es', re: new RegExp(`(?<![A-Za-zÀ-ÿ0-9_])(${ORDINAL_WORDS_ES.join('|')})(?![A-Za-zÀ-ÿ0-9_])`, 'giu') },
];

const KINDS = PATTERNS.map((p) => p.kind);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractOrdinals(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of head.matchAll(re)) {
      if (entries.length >= MAX_PER_FILE) break;
      const phrase = m[0].toLowerCase().trim();
      const key = `${kind}|${phrase}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind, phrase });
      totals[kind] += 1;
    }
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildOrdinalsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractOrdinals(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of KINDS) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [${e.kind}] \`${e.phrase}\`${file}`;
}

function renderOrdinalsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## ORDINALS / RANKING
Ordinal numbers detected in the document(s): English suffix (1st/2nd/3rd/4th), English words (first/second/third...twentieth), Spanish suffix (1º/1ra/2do/3er), Spanish words (primero/segundo/...décimo). Routes "what rank?" / "which position?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate ordinals across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...ordinals block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractOrdinals,
  buildOrdinalsForFiles,
  renderOrdinalsBlock,
  _internal: {
    PATTERNS,
    KINDS,
    ORDINAL_WORDS_EN,
    ORDINAL_WORDS_ES,
  },
};

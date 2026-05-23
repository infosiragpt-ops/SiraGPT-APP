'use strict';

/**
 * document-scientific-notation.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects scientific / engineering notation in physics / math / financial /
 * data-science contexts:
 *
 *   - E-notation: 1.5e10, 2E6, 1.23e-7, 9.81E+2
 *   - × notation: 1.5×10³, 2 × 10⁶, 1.23 x 10^-7
 *   - SI prefixes: 5 nm, 3 μs, 100 mAh, 4 kHz (handled separately—skipped here)
 *   - Engineering: 5.4 × 10^3
 *
 * Routes "what magnitude?" / "scientific value?" to a citeable list.
 *
 * Public API:
 *   extractScientificNotation(text)         → SciNotReport
 *   buildScientificNotationForFiles(files)  → { perFile }
 *   renderScientificNotationBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;
const MAX_VALUE_LEN = 50;

const PATTERNS = [
  // E-notation (canonical)
  { kind: 'e-notation', re: /(?<![\w])(-?\d+(?:\.\d+)?)e([+-]?\d{1,3})\b/gi },
  // ×10^ notation (Unicode times sign or x)
  { kind: 'times-notation', re: /(?<![\w])(-?\d+(?:\.\d+)?)\s*[×x]\s*10\s*(?:\^|⁻?[⁰¹²³⁴⁵⁶⁷⁸⁹]+|\^?-?\d+)/g },
  // Power-of-ten with superscript only: 10⁶, 10⁻³
  { kind: 'superscript', re: /\b10[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+/g },
];

const KINDS = PATTERNS.map((p) => p.kind);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipValue(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_VALUE_LEN) return t;
  return `${t.slice(0, MAX_VALUE_LEN - 1)}…`;
}

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractScientificNotation(input) {
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
      const phrase = clipValue(m[0]);
      const key = `${kind}|${phrase.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind, value: phrase });
      totals[kind] += 1;
    }
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildScientificNotationForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractScientificNotation(safeText(f.extractedText));
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
  return `- [${e.kind}] \`${e.value}\`${file}`;
}

function renderScientificNotationBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## SCIENTIFIC NOTATION
Scientific / engineering notation detected: E-notation (1.5e10, 2E6, 1.23e-7), ×10^ notation (1.5×10³, 2 × 10⁶, 1.23 x 10^-7), and bare superscript power-of-ten (10⁶, 10⁻³). Routes "what magnitude?" / "scientific value?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate scientific notation across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...scientific notation block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractScientificNotation,
  buildScientificNotationForFiles,
  renderScientificNotationBlock,
  _internal: {
    PATTERNS,
    KINDS,
  },
};

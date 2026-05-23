'use strict';

/**
 * document-comparatives.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects comparative claim phrases:
 *
 *   - "more than X" / "less than X" / "greater than X" / "fewer than X"
 *   - "X% higher" / "X% lower" / "X% above" / "X% below"
 *   - "X times more" / "X times less" / "2× faster"
 *   - "compared to X" / "in contrast to X"
 *   - Spanish: "más que" / "menos que" / "comparado con" / "X% mayor"
 *
 * Routes "what's the comparison?" / "by how much?" to a citeable list.
 *
 * Public API:
 *   extractComparatives(text)         → ComparativeReport
 *   buildComparativesForFiles(files)  → { perFile, aggregate, totals }
 *   renderComparativesBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 26;
const MAX_BLOCK_CHARS = 5000;
const MAX_CONTEXT_LEN = 180;

const PATTERNS = [
  { kind: 'magnitude',  re: /\b(?:more|less|greater|fewer|higher|lower|larger|smaller|faster|slower|cheaper|costlier)\s+than\b/gi },
  { kind: 'percent',    re: /\b\d+(?:[.,]\d+)?\s*%\s*(?:higher|lower|above|below|more|less|increase|decrease|mayor|menor|m[áa]s|menos)/gi },
  { kind: 'multiplier', re: /\b\d+(?:[.,]\d+)?\s*(?:x|×|times|veces)\s+(?:more|less|faster|slower|higher|lower|larger|smaller|mayor|menor|m[áa]s|menos)/gi },
  { kind: 'vs',         re: /\b(?:compared\s+to|in\s+contrast\s+to|versus|vs\.?|comparado\s+con|en\s+contraste\s+con|frente\s+a)\b/gi },
  { kind: 'spanish-magnitude', re: /\b(?:m[áa]s|menos)\s+que\b/giu },
];

const KINDS = ['magnitude', 'percent', 'multiplier', 'vs', 'spanish-magnitude'];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipContext(text, idx, len) {
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + len + 80);
  const ctx = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (ctx.length <= MAX_CONTEXT_LEN) return ctx;
  return `${ctx.slice(0, MAX_CONTEXT_LEN - 1)}…`;
}

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractComparatives(input) {
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
      const ctx = clipContext(head, m.index, m[0].length);
      const key = `${kind}|${ctx.slice(0, 60).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind, phrase: m[0].trim(), context: ctx });
      totals[kind] += 1;
    }
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildComparativesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractComparatives(safeText(f.extractedText));
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
  return `- [${e.kind}] _${e.phrase}_${file} — ${e.context}`;
}

function renderComparativesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## COMPARATIVE CLAIMS
Comparative phrases detected in the document(s): magnitude (more/less/greater/fewer than), percent (X% higher/lower/above/below), multiplier (X times more, 2× faster), vs (compared to / versus / comparado con / frente a), and Spanish magnitude (más/menos que). Routes "what's the comparison?" / "by how much?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate comparatives across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...comparatives block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractComparatives,
  buildComparativesForFiles,
  renderComparativesBlock,
  _internal: {
    PATTERNS,
    KINDS,
  },
};

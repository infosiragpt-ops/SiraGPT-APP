'use strict';

/**
 * document-fiscal-year.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects fiscal-year markers in financial reports / earnings releases:
 *
 *   - FY24 / FY2024 / FY'24
 *   - "fiscal year 2024" / "fiscal 2024"
 *   - Quarters: Q1 / Q2 / Q3 / Q4 (with optional year)
 *   - Spanish: "año fiscal 2024", "ejercicio fiscal 2024", "T1 / T2 / T3 / T4"
 *
 * Routes "what fiscal year?" / "which quarter?" to a citeable list.
 *
 * Public API:
 *   extractFiscalYear(text)         → FYReport
 *   buildFiscalYearForFiles(files)  → { perFile, aggregate, totals }
 *   renderFiscalYearBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 26;
const MAX_BLOCK_CHARS = 4500;

const PATTERNS = [
  { kind: 'fy-short',  re: /\bFY['']?(\d{2,4})\b/g },
  { kind: 'fy-full',   re: /\bfiscal\s+(?:year\s+)?(\d{2,4})\b/gi },
  { kind: 'quarter',   re: /\bQ([1-4])(?:[\s,]+(\d{2,4}))?\b/g },
  { kind: 'fy-es',     re: /\b(?:a[ñn]o\s+fiscal|ejercicio\s+fiscal)\s+(\d{2,4})/giu },
  { kind: 'quarter-es', re: /\bT([1-4])(?:[\s,]+(\d{2,4}))?\b/g },
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

function extractFiscalYear(input) {
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
      const phrase = m[0].trim();
      const key = `${kind}|${phrase.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind, phrase });
      totals[kind] += 1;
    }
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildFiscalYearForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractFiscalYear(safeText(f.extractedText));
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

function renderFiscalYearBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## FISCAL YEAR / QUARTERS
Fiscal year and quarter markers detected in the document(s): FY24 / FY2024 / FY'24 (fy-short), "fiscal year 2024" / "fiscal 2024" (fy-full), Q1-Q4 (quarter), Spanish "año fiscal 2024" / "ejercicio fiscal 2024" (fy-es), T1-T4 (quarter-es). Routes "what fiscal year?" / "which quarter?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate fiscal markers across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...fiscal year block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractFiscalYear,
  buildFiscalYearForFiles,
  renderFiscalYearBlock,
  _internal: {
    PATTERNS,
    KINDS,
  },
};

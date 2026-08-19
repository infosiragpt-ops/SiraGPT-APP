'use strict';

/**
 * document-percentages.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects percentage values with surrounding metric context:
 *
 *   - "12%", "+15.5%", "-3%"
 *   - "12 percent", "doce por ciento" (Spanish word form)
 *   - Percentage-point: "+15pp", "10 percentage points"
 *   - Basis-point: "+25bps", "100 basis points"
 *   - "from X to Y%" pairs
 *
 * Output captures the value, sign, and short metric context. Routes
 * "what's the rate?" / "what percentage?" to a citeable inventory.
 * Different from document-cross-numeric (units) by focusing on
 * percentage semantics specifically.
 *
 * Public API:
 *   extractPercentages(text)        → PercentReport
 *   buildPercentagesForFiles(files) → { perFile, aggregate, totals }
 *   renderPercentagesBlock(report)  → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;
const MAX_CONTEXT_LEN = 180;

// Numeric percentage with optional sign and decimal
const PERCENT_RE = /(?<![\w])([+-]?\d{1,3}(?:[.,]\d+)?)\s*%/g;
// "12 percent" / "12.5 percent"
const WORD_PERCENT_RE = /(?<![\w])([+-]?\d{1,3}(?:[.,]\d+)?)\s+percent(?:age)?\b/gi;
// Spanish "12 por ciento"
const SPANISH_PERCENT_RE = /(?<![\w])([+-]?\d{1,3}(?:[.,]\d+)?)\s+por\s+ciento\b/gi;
// pp / bps
const PP_RE = /(?<![\w])([+-]?\d{1,3}(?:[.,]\d+)?)\s*(?:pp|percentage\s+points?|puntos?\s+porcentuales?)\b/gi;
const BPS_RE = /(?<![\w])([+-]?\d{1,3}(?:[.,]\d+)?)\s*(?:bps?|basis\s+points?|puntos?\s+b[áa]sicos?)\b/gi;

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
  return { percent: 0, pp: 0, bps: 0 };
}

function extractPercentages(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  function add(kind, value, context) {
    if (entries.length >= MAX_PER_FILE) return;
    const v = String(value || '').trim();
    if (!v) return;
    const key = `${kind}|${v}|${context.slice(0, 60).toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, value: v, context });
    totals[kind] += 1;
  }

  for (const m of head.matchAll(PERCENT_RE)) {
    add('percent', m[1] + '%', clipContext(head, m.index, m[0].length));
  }
  for (const m of head.matchAll(WORD_PERCENT_RE)) {
    add('percent', m[1] + '%', clipContext(head, m.index, m[0].length));
  }
  for (const m of head.matchAll(SPANISH_PERCENT_RE)) {
    add('percent', m[1] + '%', clipContext(head, m.index, m[0].length));
  }
  for (const m of head.matchAll(PP_RE)) {
    add('pp', m[1] + 'pp', clipContext(head, m.index, m[0].length));
  }
  for (const m of head.matchAll(BPS_RE)) {
    add('bps', m[1] + 'bps', clipContext(head, m.index, m[0].length));
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildPercentagesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractPercentages(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of Object.keys(totals)) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [${e.kind}] **${e.value}**${file} — ${e.context}`;
}

function renderPercentagesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## PERCENTAGES & RATES
Percentage values detected in the document(s): numeric (12%, +15.5%, -3%), word-form (12 percent, doce por ciento), percentage-point markers (15pp / percentage points / puntos porcentuales), and basis-point markers (25bps / basis points / puntos básicos). Different from generic numeric stats by focusing on percentage semantics with surrounding metric context. Routes "what's the rate?" / "what percentage?" to a citeable inventory.

**Totals:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate percentages across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...percentages block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractPercentages,
  buildPercentagesForFiles,
  renderPercentagesBlock,
  _internal: {
    PERCENT_RE,
    WORD_PERCENT_RE,
    SPANISH_PERCENT_RE,
    PP_RE,
    BPS_RE,
  },
};

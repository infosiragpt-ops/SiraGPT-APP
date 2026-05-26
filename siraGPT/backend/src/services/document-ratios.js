'use strict';

/**
 * document-ratios.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects ratio expressions in financial/scientific docs:
 *
 *   - Colon-form: 3:1, 5:2:1
 *   - Word-form: "3 to 1", "5-to-1", "five to one"
 *   - Per-capita: "X per Y" / "X por Y"
 *   - Fractions: 2/3, 1/4 (when not date-like)
 *
 * Different from document-percentages (X%) and document-comparatives
 * (more than X). Routes "what's the ratio?" to a citeable list.
 *
 * Public API:
 *   extractRatios(text)         → RatioReport
 *   buildRatiosForFiles(files)  → { perFile, aggregate, totals }
 *   renderRatiosBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;
const MAX_CONTEXT_LEN = 160;

const PATTERNS = [
  { kind: 'colon',      re: /(?<![\w.:])(\d{1,4})\s*:\s*(\d{1,4})(?:\s*:\s*(\d{1,4}))?(?![\w.:])/g },
  { kind: 'word-en',    re: /\b(\d{1,4}(?:[.,]\d+)?)\s+to\s+(\d{1,4}(?:[.,]\d+)?)\b/gi },
  { kind: 'hyphen-en',  re: /\b(\d{1,4})\s*-\s*to\s*-\s*(\d{1,4})\b/gi },
  { kind: 'per-en',     re: /\b(\d{1,5}(?:[.,]\d+)?)\s+(?:[a-z]+\s+)?per\s+([a-z]+)\b/gi },
  { kind: 'per-es',     re: /\b(\d{1,5}(?:[.,]\d+)?)\s+(?:[a-záéíóúñ]+\s+)?por\s+([a-záéíóúñ]+)\b/giu },
  { kind: 'fraction',   re: /\b(\d{1,3})\/(\d{1,3})\b/g },
];

const KINDS = PATTERNS.map((p) => p.kind);

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

function isLikelyRatio(kind, m) {
  // For fractions, reject month/day fragments (1/12 might be date)
  if (kind === 'fraction') {
    const a = Number(m[1]);
    const b = Number(m[2]);
    // Reject 1/1 to 12/31 patterns when both fit calendar range (potential dates)
    if (a >= 1 && a <= 12 && b >= 1 && b <= 31) return false;
  }
  return true;
}

function extractRatios(input) {
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
      if (!isLikelyRatio(kind, m)) continue;
      const phrase = m[0].trim();
      const ctx = clipContext(head, m.index, m[0].length);
      const key = `${kind}|${phrase.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind, phrase, context: ctx });
      totals[kind] += 1;
    }
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildRatiosForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractRatios(safeText(f.extractedText));
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
  return `- [${e.kind}] \`${e.phrase}\`${file} — ${e.context}`;
}

function renderRatiosBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## RATIOS
Ratio expressions detected: colon-form 3:1 / 5:2:1 (colon), word-form "3 to 1" (word-en), hyphenated "3-to-1" (hyphen-en), per-capita "X per Y" (per-en) / "X por Y" (per-es), and fractions 2/3 with date-rejection. Different from percentages and comparatives. Routes "what's the ratio?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate ratios across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...ratios block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractRatios,
  buildRatiosForFiles,
  renderRatiosBlock,
  _internal: {
    PATTERNS,
    KINDS,
    isLikelyRatio,
  },
};

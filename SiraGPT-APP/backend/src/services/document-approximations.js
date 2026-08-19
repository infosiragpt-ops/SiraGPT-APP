'use strict';

/**
 * document-approximations.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects approximation hedges around numeric or quantitative claims:
 *
 *   - approximately, roughly, about, around, nearly, almost,
 *     close to, on the order of, in the neighborhood of, more or less
 *   - Spanish: aproximadamente, alrededor de, cerca de, casi, más o
 *     menos, en torno a, por ahí de
 *   - Symbolic: ~5000, ≈ 100
 *
 * Routes "how precise?" / "approximate?" to a citeable list.
 *
 * Public API:
 *   extractApproximations(text)         → ApproxReport
 *   buildApproximationsForFiles(files)  → { perFile }
 *   renderApproximationsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 26;
const MAX_BLOCK_CHARS = 5000;
const MAX_CONTEXT_LEN = 180;

const PATTERNS = [
  /\bapproximately\b/gi,
  /\broughly\b/gi,
  /\babout\s+\d/gi,
  /\baround\s+\d/gi,
  /\bnearly\b/gi,
  /\balmost\b/gi,
  /\bclose\s+to\b/gi,
  /\bon\s+the\s+order\s+of\b/gi,
  /\bin\s+the\s+neighborhood\s+of\b/gi,
  /\bmore\s+or\s+less\b/gi,
  /\bgive\s+or\s+take\b/gi,
  /\baproximadamente\b/gi,
  /\balrededor\s+de\b/gi,
  /\bcerca\s+de\b/gi,
  /\bcasi\b/gi,
  /\bm[áa]s\s+o\s+menos\b/giu,
  /\ben\s+torno\s+a\b/gi,
  /\bpor\s+ah[íi]\s+de\b/giu,
  /[~≈]\s*\d/g,
];

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

function extractApproximations(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();

  for (const re of PATTERNS) {
    re.lastIndex = 0;
    for (const m of head.matchAll(re)) {
      if (entries.length >= MAX_PER_FILE) break;
      const ctx = clipContext(head, m.index, m[0].length);
      const phrase = m[0].trim();
      const key = `${phrase.toLowerCase()}|${ctx.slice(0, 60).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ phrase, context: ctx });
    }
  }

  return { entries, total: entries.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildApproximationsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractApproximations(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- _${e.phrase}_${file} — ${e.context}`;
}

function renderApproximationsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## APPROXIMATION HEDGES
Approximation hedges around numeric claims — approximately, roughly, about N, around N, nearly, almost, close to, on the order of, more or less (English) and aproximadamente, alrededor de, cerca de, casi, más o menos, en torno a (Spanish), plus symbolic forms (~N, ≈N). High density indicates imprecise/estimated claims. Routes "how precise?" / "approximate?" to a citeable list.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate approximations across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...approximations block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractApproximations,
  buildApproximationsForFiles,
  renderApproximationsBlock,
  _internal: {
    PATTERNS,
  },
};

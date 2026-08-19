'use strict';

/**
 * document-examples.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects example markers in explanatory text:
 *
 *   - "for example", "e.g.", "such as", "for instance", "including"
 *   - "i.e." (id est — definitional)
 *   - "namely", "in particular", "specifically"
 *   - Spanish: "por ejemplo", "p. ej.", "como por ejemplo",
 *     "es decir", "a saber", "en particular"
 *
 * Routes "what's an example?" / "for instance?" to a citeable list.
 *
 * Public API:
 *   extractExamples(text)         → ExampleReport
 *   buildExamplesForFiles(files)  → { perFile, aggregate, totals }
 *   renderExamplesBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 26;
const MAX_BLOCK_CHARS = 5000;
const MAX_CONTEXT_LEN = 200;

const PATTERNS = [
  { kind: 'eg', re: /\b(?:e\.?g\.?|for\s+example|for\s+instance)\b/gi },
  { kind: 'such-as', re: /\b(?:such\s+as|like|including)\b/gi },
  { kind: 'ie', re: /\b(?:i\.?e\.?|that\s+is|namely|in\s+particular|specifically)\b/gi },
  { kind: 'por-ejemplo', re: /\b(?:por\s+ejemplo|p\.\s*ej\.?|como\s+por\s+ejemplo)\b/gi },
  { kind: 'es-decir', re: /\b(?:es\s+decir|a\s+saber|en\s+particular|en\s+espec[íi]fico)\b/gi },
];

const KINDS = PATTERNS.map((p) => p.kind);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipContext(text, idx, len) {
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + len + 120);
  const ctx = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (ctx.length <= MAX_CONTEXT_LEN) return ctx;
  return `${ctx.slice(0, MAX_CONTEXT_LEN - 1)}…`;
}

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractExamples(input) {
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

function buildExamplesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractExamples(safeText(f.extractedText));
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

function renderExamplesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## EXAMPLE MARKERS
Example / instance / clarification markers detected in the document(s): "for example" / "e.g." / "for instance" (eg), "such as" / "like" / "including" (such-as), "i.e." / "that is" / "namely" / "in particular" / "specifically" (ie definitional), Spanish "por ejemplo" / "p. ej." / "como por ejemplo" (por-ejemplo), "es decir" / "a saber" / "en particular" / "en específico" (es-decir). Routes "what's an example?" / "for instance?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate examples across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...examples block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractExamples,
  buildExamplesForFiles,
  renderExamplesBlock,
  _internal: {
    PATTERNS,
    KINDS,
  },
};

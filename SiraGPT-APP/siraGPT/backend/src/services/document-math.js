'use strict';

/**
 * document-math.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects mathematical expressions in academic / scientific / technical docs:
 *
 *   - LaTeX inline math: $E = mc^2$, \\(...\\)
 *   - LaTeX display math: $$\\sum_{i=1}^n i$$, \\[...\\]
 *   - LaTeX environments: \\begin{equation}..\\end{equation}
 *   - Bare LaTeX commands: \\frac, \\sum, \\int, \\sqrt, etc.
 *
 * Different from document-code-blocks (programming code) by focusing
 * on math notation. Routes "what math?" / "what equation?" to a
 * citeable list.
 *
 * Public API:
 *   extractMath(text)         → MathReport
 *   buildMathForFiles(files)  → { perFile, aggregate, totals }
 *   renderMathBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_KIND = 10;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 5000;
const MAX_VALUE_LEN = 120;

const INLINE_DOLLAR_RE = /\$([^\n$]{1,150}?)\$(?!\$)/g;
const DISPLAY_DOLLAR_RE = /\$\$([^]+?)\$\$/g;
const INLINE_PAREN_RE = /\\\(([^]+?)\\\)/g;
const DISPLAY_BRACKET_RE = /\\\[([^]+?)\\\]/g;
const ENV_RE = /\\begin\{(equation|align|gather|multiline|displaymath)\*?\}([^]*?)\\end\{\1\*?\}/g;

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

function looksLikeMath(s) {
  const t = String(s || '');
  if (t.length < 2) return false;
  // Require at least one math indicator: latex command, operator, sub/sup
  return /\\[a-zA-Z]|[\^_=<>≤≥≠≈±×÷·∑∏∫√∞∇∂]|\d\^\d/.test(t);
}

function emptyTotals() {
  return { inline: 0, display: 0, environment: 0 };
}

function extractMath(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  function add(kind, value) {
    if (entries.length >= MAX_PER_FILE) return;
    if (totals[kind] >= MAX_PER_KIND) return;
    const v = clipValue(value);
    if (!v || !looksLikeMath(v)) return;
    const key = `${kind}|${v.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, value: v });
    totals[kind] += 1;
  }

  // Display first (so we don't double-match $$..$$ as two inline $..$..$)
  for (const m of head.matchAll(DISPLAY_DOLLAR_RE)) add('display', m[1]);
  for (const m of head.matchAll(DISPLAY_BRACKET_RE)) add('display', m[1]);
  for (const m of head.matchAll(ENV_RE)) add('environment', m[2]);
  for (const m of head.matchAll(INLINE_DOLLAR_RE)) {
    // Skip if already covered by display match
    add('inline', m[1]);
  }
  for (const m of head.matchAll(INLINE_PAREN_RE)) add('inline', m[1]);

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildMathForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractMath(safeText(f.extractedText));
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
  return `- [${e.kind}] \`${e.value}\`${file}`;
}

function renderMathBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## MATH EXPRESSIONS
LaTeX math expressions detected in the document(s): inline ($...$, \\(...\\)), display ($$...$$, \\[...\\]), and environment forms (\\begin{equation}...\\end{equation}, also align/gather/multiline). Filtered by math-indicator heuristic (LaTeX commands, operators, sub/super-scripts). Routes "what equation?" / "what math?" to a citeable list.

**Totals:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate math across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...math block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractMath,
  buildMathForFiles,
  renderMathBlock,
  _internal: {
    INLINE_DOLLAR_RE,
    DISPLAY_DOLLAR_RE,
    INLINE_PAREN_RE,
    DISPLAY_BRACKET_RE,
    ENV_RE,
    looksLikeMath,
  },
};

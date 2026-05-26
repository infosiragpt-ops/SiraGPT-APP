'use strict';

/**
 * document-quantifiers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects propositional quantifier words in legal/specification text:
 *
 *   - Universal: all, every, each, any, todo/cada/cualquier
 *   - Existential: some, at least, hay, algún
 *   - Negative: none, no, ningún
 *   - Cardinal: many, several, few, varios, pocos
 *
 * Used to surface scope hints when interpreting requirements / contracts.
 * Routes "what's the scope?" / "is this universal?" to a citeable summary.
 *
 * Public API:
 *   extractQuantifiers(text)         → QuantifierReport
 *   buildQuantifiersForFiles(files)  → { perFile, aggregate, totals }
 *   renderQuantifiersBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 5000;
const MAX_CONTEXT_LEN = 160;

const QUANTIFIERS = {
  universal: ['all', 'every', 'each', 'any', 'whole', 'entire', 'todos?', 'cada', 'cualquier(?:a)?', 'cualesquiera'],
  existential: ['some', 'at\\s+least\\s+one', 'there\\s+exists?', 'there\\s+is', 'there\\s+are', 'hay', 'alg[úu]n', 'algunos?', 'al\\s+menos'],
  negative: ['none', 'no\\s+\\w', 'not\\s+any', 'ning[úu]n', 'ninguno', 'ninguna'],
  cardinal: ['many', 'several', 'few', 'numerous', 'varios?', 'pocos?', 'muchos?'],
};

const KINDS = Object.keys(QUANTIFIERS);

const PATTERNS = KINDS.map((kind) => ({
  kind,
  re: new RegExp(`\\b(${QUANTIFIERS[kind].join('|')})\\b`, 'giu'),
}));

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipContext(text, idx, len) {
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + len + 60);
  const ctx = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (ctx.length <= MAX_CONTEXT_LEN) return ctx;
  return `${ctx.slice(0, MAX_CONTEXT_LEN - 1)}…`;
}

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractQuantifiers(input) {
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
      const word = m[1].toLowerCase().trim();
      const ctx = clipContext(head, m.index, m[0].length);
      const key = `${kind}|${word}|${ctx.slice(0, 50).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind, word, context: ctx });
      totals[kind] += 1;
    }
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildQuantifiersForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractQuantifiers(safeText(f.extractedText));
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
  return `- [${e.kind}] **${e.word}**${file} — ${e.context}`;
}

function renderQuantifiersBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## QUANTIFIERS (LOGICAL SCOPE)
Propositional quantifier words detected in the document(s) — universal (all/every/each/cada/cualquier), existential (some/at least/hay/algún), negative (none/no/ningún), cardinal (many/several/few/varios/pocos). Used to surface scope hints when interpreting requirements/contracts. Routes "what's the scope?" / "is this universal?" to a citeable summary.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate quantifiers across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...quantifiers block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractQuantifiers,
  buildQuantifiersForFiles,
  renderQuantifiersBlock,
  _internal: {
    PATTERNS,
    QUANTIFIERS,
    KINDS,
  },
};

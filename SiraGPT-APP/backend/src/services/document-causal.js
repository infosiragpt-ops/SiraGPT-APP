'use strict';

/**
 * document-causal.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects causal markers in tech docs / RCAs / postmortems / explanations:
 *
 *   - "because [of] X" / "due to X" / "owing to X"
 *   - "as a result of X" / "thanks to X"
 *   - "since X" / "given that X"
 *   - Spanish: "debido a X" / "porque X" / "ya que X" / "puesto que X" /
 *     "por causa de X" / "dado que X"
 *
 * Captures the causal phrase with surrounding context. Different from
 * document-conditional-clauses (if/unless) by focusing on past/established
 * causation. Routes "why?" / "what caused?" to a citeable list.
 *
 * Public API:
 *   extractCausal(text)         → CausalReport
 *   buildCausalForFiles(files)  → { perFile, aggregate, totals }
 *   renderCausalBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 26;
const MAX_BLOCK_CHARS = 5000;
const MAX_CONTEXT_LEN = 200;

const PATTERNS = [
  { kind: 'because',    re: /\bbecause(?:\s+of)?\b/gi },
  { kind: 'dueto',      re: /\bdue\s+to\b/gi },
  { kind: 'owingto',    re: /\bowing\s+to\b/gi },
  { kind: 'asaresult',  re: /\bas\s+a\s+result\s+of\b/gi },
  { kind: 'thanksto',   re: /\bthanks\s+to\b/gi },
  { kind: 'since',      re: /\b(?:since|given\s+that)\b/gi },
  { kind: 'debidoa',    re: /\bdebido\s+a\b/gi },
  { kind: 'porque',     re: /\bporque\b/gi },
  { kind: 'yaque',      re: /\bya\s+que\b/gi },
  { kind: 'puestoque',  re: /\bpuesto\s+que\b/gi },
  { kind: 'porcausade', re: /\bpor\s+causa\s+de\b/gi },
  { kind: 'dadoque',    re: /\bdado\s+que\b/gi },
];

const KINDS = PATTERNS.map((p) => p.kind);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipContext(text, idx, len) {
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + len + 100);
  const ctx = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (ctx.length <= MAX_CONTEXT_LEN) return ctx;
  return `${ctx.slice(0, MAX_CONTEXT_LEN - 1)}…`;
}

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractCausal(input) {
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

function buildCausalForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractCausal(safeText(f.extractedText));
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

function renderCausalBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## CAUSAL MARKERS
Causal connectives detected in the document(s): because (English), due to, owing to, as a result of, thanks to, since/given that, plus Spanish equivalents (debido a, porque, ya que, puesto que, por causa de, dado que). Different from conditional clauses by focusing on past/established causation. Routes "why?" / "what caused?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate causal markers across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...causal block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractCausal,
  buildCausalForFiles,
  renderCausalBlock,
  _internal: {
    PATTERNS,
    KINDS,
  },
};

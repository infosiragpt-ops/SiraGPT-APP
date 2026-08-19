'use strict';

/**
 * document-math-operators.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects mathematical/logical operators used inline in technical text
 * (set theory, logic, inequalities), distinct from full LaTeX math blocks.
 *
 *   - Inequalities: ≠ ≤ ≥ < > ⊂ ⊆ ⊃ ⊇
 *   - Set/logic: ∈ ∉ ∪ ∩ ∅ ¬ ∧ ∨ ⊕ ⊗
 *   - Quantifiers: ∀ ∃ ∄ ∴ ∵ ∝
 *   - Calculus / arrows: ∫ ∑ ∏ √ ∂ ∇ ∞ → ← ↔ ⇒ ⇐ ⇔
 *
 * Routes "what math operators?" / "set theory used?" to a citeable summary.
 *
 * Public API:
 *   extractMathOperators(text)         → MathOpReport
 *   buildMathOperatorsForFiles(files)  → { perFile, aggregate, totals }
 *   renderMathOperatorsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const OPERATORS = {
  '≠': 'not-equal',
  '≤': 'less-equal',
  '≥': 'greater-equal',
  '⊂': 'subset',
  '⊆': 'subset-equal',
  '⊃': 'superset',
  '⊇': 'superset-equal',
  '∈': 'in',
  '∉': 'not-in',
  '∪': 'union',
  '∩': 'intersection',
  '∅': 'empty-set',
  '¬': 'not',
  '∧': 'and',
  '∨': 'or',
  '⊕': 'xor',
  '⊗': 'tensor',
  '∀': 'for-all',
  '∃': 'exists',
  '∄': 'not-exists',
  '∴': 'therefore',
  '∵': 'because',
  '∝': 'proportional',
  '∫': 'integral',
  '∑': 'sum',
  '∏': 'product',
  '√': 'sqrt',
  '∂': 'partial',
  '∇': 'nabla',
  '∞': 'infinity',
  '→': 'right-arrow',
  '←': 'left-arrow',
  '↔': 'both-arrow',
  '⇒': 'implies',
  '⇐': 'reverse-implies',
  '⇔': 'iff',
};

const OPERATOR_RE = new RegExp(`(${Object.keys(OPERATORS).map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function extractMathOperators(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: {}, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const totals = {};
  const seen = new Set();
  const entries = [];

  for (const m of head.matchAll(OPERATOR_RE)) {
    if (entries.length >= MAX_PER_FILE) break;
    const sym = m[1];
    const name = OPERATORS[sym];
    if (!name) continue;
    const key = sym;
    if (seen.has(key)) {
      totals[name] += 1;
      continue;
    }
    seen.add(key);
    entries.push({ symbol: sym, name });
    totals[name] = (totals[name] || 0) + 1;
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildMathOperatorsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = {};
  for (const f of list) {
    const r = extractMathOperators(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of Object.keys(r.totals)) totals[k] = (totals[k] || 0) + r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- **${e.symbol}** (${e.name})${file}`;
}

function renderMathOperatorsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || {};
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .slice(0, 10)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## MATHEMATICAL / LOGICAL OPERATORS
Inline mathematical and logical operators detected: inequalities (≠ ≤ ≥), set theory (⊂ ⊆ ⊃ ⊇ ∈ ∉ ∪ ∩ ∅), logic (¬ ∧ ∨ ⊕ ⊗), quantifiers (∀ ∃ ∄ ∴ ∵), calculus (∫ ∑ ∏ √ ∂ ∇ ∞), arrows (→ ← ↔ ⇒ ⇐ ⇔). Different from LaTeX math blocks (already in document-math). Routes "what operators?" / "set theory used?" to a citeable summary.

**Top totals:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate math operators across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...math operators block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractMathOperators,
  buildMathOperatorsForFiles,
  renderMathOperatorsBlock,
  _internal: {
    OPERATORS,
    OPERATOR_RE,
  },
};

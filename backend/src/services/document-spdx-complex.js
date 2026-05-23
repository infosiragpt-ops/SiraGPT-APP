'use strict';

/**
 * document-spdx-complex.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects SPDX complex license expressions (with AND / OR / WITH and
 * parentheses) — distinct from the basic SPDX-ID census in
 * document-licenses.js.
 *
 * Targets:
 *   - "MIT OR Apache-2.0"
 *   - "(MIT OR Apache-2.0) AND BSD-3-Clause"
 *   - "Apache-2.0 WITH LLVM-exception"
 *   - "GPL-3.0-only WITH Classpath-exception-2.0"
 *
 * Public API:
 *   extractSpdxComplex(text)                → { entries, totals, total }
 *   buildSpdxComplexForFiles(files)         → { perFile, aggregate, totals }
 *   renderSpdxComplexBlock(report)          → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 12;
const MAX_AGGREGATE = 16;
const MAX_BLOCK_CHARS = 4500;
const MAX_EXPR_LEN = 200;

// SPDX ID atom: letters/digits/. - +
const SPDX_ATOM = '[A-Za-z0-9][A-Za-z0-9.+-]{1,40}';
// Expression: must contain AND/OR/WITH operator and be wrapped in parens or have multiple atoms
const COMPLEX_EXPR_RE = new RegExp(
  `(\\(?\\s*${SPDX_ATOM}(?:\\s+(?:AND|OR|WITH)\\s+${SPDX_ATOM})+\\s*\\)?(?:\\s+(?:AND|OR|WITH)\\s+\\(?\\s*${SPDX_ATOM}(?:\\s+(?:AND|OR|WITH)\\s+${SPDX_ATOM})*\\s*\\)?)*)`,
  'g'
);

// SPDX-License-Identifier header: capture the expression that follows
const HEADER_RE = /SPDX-License-Identifier\s*:\s*([^\n\r]{2,200})/gi;

function looksLikeSpdxExpression(expr) {
  if (!expr || typeof expr !== 'string') return false;
  const trimmed = expr.trim();
  if (trimmed.length < 5 || trimmed.length > MAX_EXPR_LEN) return false;
  // Must contain at least one AND/OR/WITH operator
  if (!/\b(AND|OR|WITH)\b/.test(trimmed)) return false;
  // Must have at least 2 atoms total
  const atoms = trimmed.match(/[A-Za-z0-9][A-Za-z0-9.+-]{1,40}/g) || [];
  return atoms.length >= 2;
}

function normaliseExpression(expr) {
  return expr
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
}

function classifyOperator(expr) {
  const ops = new Set();
  if (/\bAND\b/.test(expr)) ops.add('AND');
  if (/\bOR\b/.test(expr)) ops.add('OR');
  if (/\bWITH\b/.test(expr)) ops.add('WITH');
  return Array.from(ops).sort().join('+') || 'unknown';
}

function extractSpdxComplex(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { AND: 0, OR: 0, WITH: 0 };

  // 1) SPDX-License-Identifier headers
  HEADER_RE.lastIndex = 0;
  let m;
  while ((m = HEADER_RE.exec(body))) {
    const raw = m[1].trim();
    if (!looksLikeSpdxExpression(raw)) continue;
    const norm = normaliseExpression(raw);
    if (seen.has(norm)) continue;
    seen.add(norm);
    const op = classifyOperator(norm);
    op.split('+').forEach((o) => {
      if (totals[o] != null) totals[o] += 1;
    });
    entries.push({ expression: norm, operators: op, source: 'header' });
    if (entries.length >= MAX_PER_FILE) break;
  }

  // 2) Inline complex expressions
  if (entries.length < MAX_PER_FILE) {
    COMPLEX_EXPR_RE.lastIndex = 0;
    while ((m = COMPLEX_EXPR_RE.exec(body))) {
      const raw = m[1];
      if (!looksLikeSpdxExpression(raw)) continue;
      const norm = normaliseExpression(raw);
      if (seen.has(norm)) continue;
      seen.add(norm);
      const op = classifyOperator(norm);
      op.split('+').forEach((o) => {
        if (totals[o] != null) totals[o] += 1;
      });
      entries.push({ expression: norm, operators: op, source: 'inline' });
      if (entries.length >= MAX_PER_FILE) break;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildSpdxComplexForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { AND: 0, OR: 0, WITH: 0 };

  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractSpdxComplex(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.expression)) continue;
      aggSeen.add(e.expression);
      aggregate.push(e);
      e.operators.split('+').forEach((o) => {
        if (totals[o] != null) totals[o] += 1;
      });
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }

  return { perFile, aggregate, totals };
}

function renderSpdxComplexBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## SPDX COMPLEX EXPRESSIONS'];
  const t = report.totals || {};
  const parts = [];
  if (t.AND) parts.push(`AND: ${t.AND}`);
  if (t.OR) parts.push(`OR: ${t.OR}`);
  if (t.WITH) parts.push(`WITH: ${t.WITH}`);
  if (parts.length) lines.push(`- Operators: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- \`${e.expression}\` (${e.operators}, ${e.source})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractSpdxComplex,
  buildSpdxComplexForFiles,
  renderSpdxComplexBlock,
  _internal: { looksLikeSpdxExpression, normaliseExpression, classifyOperator },
};

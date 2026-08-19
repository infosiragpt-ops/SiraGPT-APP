'use strict';

/**
 * document-number-bases.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects non-decimal number-literal notations in code / config / docs:
 *
 *   - hex:    0xABCD, 0XFF, #FFFFFF
 *   - binary: 0b1010, 0B11
 *   - octal:  0o755, 0O644, 0644 (legacy)
 *   - exponential: 1.5e10, 2E-3 (decimal but worth noting)
 *
 * Public API:
 *   extractNumberBases(text)             → { entries, totals, total }
 *   buildNumberBasesForFiles(files)      → { perFile, aggregate, totals }
 *   renderNumberBasesBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 26;
const MAX_BLOCK_CHARS = 4500;

const HEX_RE = /\b0[xX][0-9a-fA-F]+\b/g;
const BINARY_RE = /\b0[bB][01]+\b/g;
const OCTAL_RE = /\b0[oO][0-7]+\b/g;
const LEGACY_OCTAL_RE = /\b(?<!\.)0([0-7]{2,9})\b(?!\.)/g;
const EXP_RE = /\b\d+(?:\.\d+)?[eE][+-]?\d{1,4}\b/g;

function valueOf(literal) {
  if (/^0[xX]/.test(literal)) return parseInt(literal.slice(2), 16);
  if (/^0[bB]/.test(literal)) return parseInt(literal.slice(2), 2);
  if (/^0[oO]/.test(literal)) return parseInt(literal.slice(2), 8);
  if (/^0[0-7]/.test(literal)) return parseInt(literal, 8);
  if (/[eE]/.test(literal)) return parseFloat(literal);
  return null;
}

function extractNumberBases(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { hex: 0, binary: 0, octal: 0, 'octal-legacy': 0, exp: 0 };

  function push(base, literal) {
    if (seen.has(literal)) return;
    seen.add(literal);
    entries.push({ base, literal, value: valueOf(literal) });
    if (totals[base] != null) totals[base] += 1;
  }

  HEX_RE.lastIndex = 0;
  let m;
  while ((m = HEX_RE.exec(body)) && entries.length < MAX_PER_FILE) push('hex', m[0]);

  if (entries.length < MAX_PER_FILE) {
    BINARY_RE.lastIndex = 0;
    while ((m = BINARY_RE.exec(body)) && entries.length < MAX_PER_FILE) push('binary', m[0]);
  }
  if (entries.length < MAX_PER_FILE) {
    OCTAL_RE.lastIndex = 0;
    while ((m = OCTAL_RE.exec(body)) && entries.length < MAX_PER_FILE) push('octal', m[0]);
  }
  if (entries.length < MAX_PER_FILE) {
    LEGACY_OCTAL_RE.lastIndex = 0;
    while ((m = LEGACY_OCTAL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      // require at least 3 digits to filter out things like "01", "02"
      if (m[1].length < 3) continue;
      push('octal-legacy', m[0]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    EXP_RE.lastIndex = 0;
    while ((m = EXP_RE.exec(body)) && entries.length < MAX_PER_FILE) push('exp', m[0]);
  }

  return { entries, totals, total: entries.length };
}

function buildNumberBasesForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { hex: 0, binary: 0, octal: 0, 'octal-legacy': 0, exp: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractNumberBases(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.literal)) continue;
      aggSeen.add(e.literal);
      aggregate.push(e);
      if (totals[e.base] != null) totals[e.base] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderNumberBasesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## NUMBER LITERALS (non-decimal)'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 12)) {
      lines.push(`- [${e.base}] \`${e.literal}\`${e.value != null ? ` = ${e.value}` : ''}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractNumberBases,
  buildNumberBasesForFiles,
  renderNumberBasesBlock,
  _internal: { valueOf },
};

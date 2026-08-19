'use strict';

/**
 * document-ssn-pii.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects national-identifier PII and ALWAYS masks the result to last-2/4
 * chars. Different from document-pii-detector (general PII signals) by
 * focusing on specific national-ID formats with masking.
 *
 *   - US SSN: 123-45-6789 or 123 45 6789 (must be labeled when bare)
 *   - Mexico CURP: HEGG560427MQTRSL01 (18 chars)
 *   - Spain DNI: 12345678A (8 digits + letter)
 *   - Spain NIE: X1234567A
 *   - Canada SIN: 123-456-789
 *   - UK NINO: AB123456C
 *   - Brazil CPF: 123.456.789-01
 *
 * Routes "any PII?" / "any national ID?" to a citeable masked list.
 *
 * Public API:
 *   extractSsnPii(text)         → SsnPiiReport
 *   buildSsnPiiForFiles(files)  → { perFile, aggregate, totals }
 *   renderSsnPiiBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 12;
const MAX_AGGREGATE = 16;
const MAX_BLOCK_CHARS = 4500;

const PATTERNS = [
  // US SSN — only when labeled to reduce false positives
  { kind: 'us-ssn', re: /\b(?:SSN|Social\s+Security)\s*[:#=]?\s*(\d{3}[-\s]?\d{2}[-\s]?\d{4})\b/gi },
  // Mexico CURP
  { kind: 'mx-curp', re: /\b([A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d)\b/g },
  // Mexico RFC: AAAA999999AAA or AAA999999AAA
  { kind: 'mx-rfc', re: /\b([A-Z]{3,4}\d{6}[A-Z0-9]{3})\b/g },
  // Spain DNI / NIE
  { kind: 'es-dni', re: /\b(\d{8}[A-Z])\b/g },
  { kind: 'es-nie', re: /\b([XYZ]\d{7}[A-Z])\b/g },
  // Canada SIN
  { kind: 'ca-sin', re: /\b(?:SIN|Social\s+Insurance)\s*[:#=]?\s*(\d{3}[-\s]\d{3}[-\s]\d{3})\b/gi },
  // UK NINO
  { kind: 'uk-nino', re: /\b([A-Z]{2}\d{6}[A-Z])\b/g },
  // Brazil CPF
  { kind: 'br-cpf', re: /\b(\d{3}\.\d{3}\.\d{3}-\d{2})\b/g },
];

const KINDS = PATTERNS.map((p) => p.kind);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function mask(value, lastN = 2) {
  const clean = String(value).replace(/[ \-.]/g, '');
  if (clean.length <= lastN) return '*'.repeat(clean.length);
  return '*'.repeat(clean.length - lastN) + clean.slice(-lastN);
}

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractSsnPii(input) {
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
      const raw = m[1];
      const masked = mask(raw, kind === 'mx-curp' ? 4 : 2);
      const key = `${kind}|${masked}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind, masked });
      totals[kind] += 1;
    }
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildSsnPiiForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractSsnPii(safeText(f.extractedText));
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
  return `- [${e.kind}] \`${e.masked}\`${file}`;
}

function renderSsnPiiBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## NATIONAL ID / PII (MASKED)
National-identifier PII detected and **always masked to last-2 chars** (last-4 for CURP). Kinds: US SSN (labeled), Mexico CURP/RFC, Spain DNI/NIE, Canada SIN (labeled), UK NINO, Brazil CPF. Full numbers are never reproduced in the enrichment block. Routes "any PII?" / "any national ID?" to a citeable masked list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate (masked) PII across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...PII block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractSsnPii,
  buildSsnPiiForFiles,
  renderSsnPiiBlock,
  _internal: {
    PATTERNS,
    KINDS,
    mask,
  },
};

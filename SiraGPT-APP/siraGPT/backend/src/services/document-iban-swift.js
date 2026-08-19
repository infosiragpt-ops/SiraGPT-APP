'use strict';

/**
 * document-iban-swift.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects international banking codes in financial / treasury / compliance
 * documents:
 *
 *   - IBAN: 2-letter country + 2 check digits + 11-30 alphanumerics
 *     (e.g. DE89 3704 0044 0532 0130 00, ES7921000418401234567891)
 *   - SWIFT/BIC: 8 or 11 alphanumerics (e.g. DEUTDEFF, BNPAFRPP)
 *   - Routing/ABA: 9-digit US bank routing
 *   - CLABE (Mexico): 18-digit
 *
 * Routes "what bank account?" / "what SWIFT?" to a citeable list.
 *
 * Public API:
 *   extractIbanSwift(text)         → IbanSwiftReport
 *   buildIbanSwiftForFiles(files)  → { perFile, aggregate, totals }
 *   renderIbanSwiftBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 20;
const MAX_BLOCK_CHARS = 4500;

const PATTERNS = [
  // IBAN: 2-letter country + 2 check digits + up to 30 alphanumerics, optional spaces
  { kind: 'iban', re: /\b([A-Z]{2}\d{2}(?:\s?[A-Z0-9]){11,30})\b/g },
  // SWIFT/BIC: 4 letters + 2 letters + 2 alphanumeric + optional 3 alphanumeric
  { kind: 'swift', re: /\b([A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)\b/g },
  // ABA routing (US): 9 digits, often prefixed
  { kind: 'aba', re: /\b(?:routing\s+(?:number\s+)?|ABA\s*[:=]?\s*)(\d{9})\b/gi },
  // CLABE (Mexico): 18 digits, often prefixed
  { kind: 'clabe', re: /\b(?:CLABE\s*[:=]?\s*)(\d{18})\b/gi },
];

const KINDS = PATTERNS.map((p) => p.kind);

const COUNTRY_PREFIXES = new Set([
  'AD', 'AE', 'AL', 'AT', 'AZ', 'BA', 'BE', 'BG', 'BH', 'BR', 'BY', 'CH',
  'CR', 'CY', 'CZ', 'DE', 'DK', 'DO', 'EE', 'EG', 'ES', 'FI', 'FO', 'FR',
  'GB', 'GE', 'GI', 'GL', 'GR', 'GT', 'HR', 'HU', 'IE', 'IL', 'IQ', 'IS',
  'IT', 'JO', 'KW', 'KZ', 'LB', 'LC', 'LI', 'LT', 'LU', 'LV', 'LY', 'MC',
  'MD', 'ME', 'MK', 'MR', 'MT', 'MU', 'NL', 'NO', 'PK', 'PL', 'PS', 'PT',
  'QA', 'RO', 'RS', 'SA', 'SC', 'SE', 'SI', 'SK', 'SM', 'ST', 'SV', 'TL',
  'TN', 'TR', 'UA', 'VG', 'XK',
]);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function isLikelyIBAN(s) {
  if (!s) return false;
  const cleaned = s.replace(/\s+/g, '');
  if (cleaned.length < 15 || cleaned.length > 34) return false;
  const cc = cleaned.slice(0, 2);
  return COUNTRY_PREFIXES.has(cc);
}

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractIbanSwift(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  for (const m of head.matchAll(PATTERNS[0].re)) {
    if (entries.length >= MAX_PER_FILE) break;
    const code = m[1].replace(/\s+/g, ' ').trim();
    if (!isLikelyIBAN(code)) continue;
    const key = `iban|${code.replace(/\s/g, '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'iban', code });
    totals.iban += 1;
  }

  for (const m of head.matchAll(PATTERNS[1].re)) {
    if (entries.length >= MAX_PER_FILE) break;
    const code = m[1];
    // SWIFT/BIC: 8 or 11 chars; positions 5-6 are country code
    const cc = code.slice(4, 6);
    if (!COUNTRY_PREFIXES.has(cc)) continue;
    const key = `swift|${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'swift', code });
    totals.swift += 1;
  }

  for (const m of head.matchAll(PATTERNS[2].re)) {
    if (entries.length >= MAX_PER_FILE) break;
    const code = m[1];
    const key = `aba|${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'aba', code });
    totals.aba += 1;
  }

  for (const m of head.matchAll(PATTERNS[3].re)) {
    if (entries.length >= MAX_PER_FILE) break;
    const code = m[1];
    const key = `clabe|${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'clabe', code });
    totals.clabe += 1;
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildIbanSwiftForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractIbanSwift(safeText(f.extractedText));
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
  return `- [${e.kind}] \`${e.code}\`${file}`;
}

function renderIbanSwiftBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## BANKING CODES (IBAN / SWIFT / ABA / CLABE)
International banking codes detected: IBAN (2-letter country code from ~80 IBAN-issuing countries + check digits + 11-30 alphanumerics), SWIFT/BIC (8 or 11 alphanumeric, validated country code position), ABA US routing (9 digits with "routing" prefix), CLABE Mexico (18 digits with "CLABE" prefix). Routes "what bank account?" / "what SWIFT?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate banking codes across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...banking codes block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractIbanSwift,
  buildIbanSwiftForFiles,
  renderIbanSwiftBlock,
  _internal: {
    PATTERNS,
    KINDS,
    COUNTRY_PREFIXES,
    isLikelyIBAN,
  },
};

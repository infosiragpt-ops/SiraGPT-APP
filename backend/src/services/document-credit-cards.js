'use strict';

/**
 * document-credit-cards.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects credit card patterns (BIN-validated) and ALWAYS reports them in
 * masked form to avoid leaking PII into the chat context:
 *
 *   - Visa: starts with 4, 13-16 digits
 *   - Mastercard: 51-55, or 2221-2720 (8 digits when normalised), 16 digits
 *   - Amex: 34/37, 15 digits
 *   - Discover: 6011 or 65, 16 digits
 *   - JCB: 35, 16 digits
 *   - Diners: 30/36/38, 14 digits
 *
 * Output: kind + LAST-4 only. Number is never logged in full.
 * Routes "PCI scope?" / "any card numbers?" to a citeable masked list.
 *
 * Public API:
 *   extractCreditCards(text)         → CardReport
 *   buildCreditCardsForFiles(files)  → { perFile, aggregate, totals }
 *   renderCreditCardsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 4500;

const CARD_PATTERNS = [
  { kind: 'visa', re: /(?<![\w])(4\d{3}(?:[ -]?\d{4}){2,3}\d?)(?![\w])/g },
  { kind: 'mastercard', re: /(?<![\w])((?:5[1-5]\d{2}|2[2-7]\d{2})(?:[ -]?\d{4}){3})(?![\w])/g },
  { kind: 'amex', re: /(?<![\w])(3[47]\d{2}[ -]?\d{6}[ -]?\d{5})(?![\w])/g },
  { kind: 'discover', re: /(?<![\w])(6(?:011|5\d{2})(?:[ -]?\d{4}){3})(?![\w])/g },
  { kind: 'jcb', re: /(?<![\w])(35\d{2}(?:[ -]?\d{4}){3})(?![\w])/g },
  { kind: 'diners', re: /(?<![\w])(3(?:0[0-5]|[68]\d)\d(?:[ -]?\d{4}){2}\d{2})(?![\w])/g },
];

const KINDS = CARD_PATTERNS.map((p) => p.kind);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function luhnValid(digits) {
  // Luhn checksum validation
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = parseInt(digits[i], 10);
    if (Number.isNaN(d)) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function mask(cardNumber) {
  const digits = cardNumber.replace(/[ -]/g, '');
  const last4 = digits.slice(-4);
  return `****-****-****-${last4}`;
}

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractCreditCards(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  for (const { kind, re } of CARD_PATTERNS) {
    re.lastIndex = 0;
    for (const m of head.matchAll(re)) {
      if (entries.length >= MAX_PER_FILE) break;
      const digits = m[1].replace(/[ -]/g, '');
      if (digits.length < 13 || digits.length > 19) continue;
      if (!luhnValid(digits)) continue;
      const masked = mask(m[1]);
      const key = `${kind}|${masked}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind, masked, length: digits.length });
      totals[kind] += 1;
    }
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildCreditCardsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractCreditCards(safeText(f.extractedText));
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
  return `- [${e.kind}] \`${e.masked}\` (${e.length} digits)${file}`;
}

function renderCreditCardsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## CREDIT CARDS (MASKED — PCI SCOPE)
Credit card patterns detected and **masked to last-4 only** to keep PCI-DSS scope out of the chat: Visa (starts with 4), Mastercard (51-55 / 2221-2720), Amex (34/37, 15 digits), Discover (6011/65, 16 digits), JCB (35, 16 digits), Diners (30/36/38, 14 digits). All matches Luhn-validated to reduce false positives. Routes "any card numbers?" / "PCI scope?" to a citeable masked list. Full numbers are never reproduced in the enrichment block.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate (masked) cards across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...credit cards block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractCreditCards,
  buildCreditCardsForFiles,
  renderCreditCardsBlock,
  _internal: {
    CARD_PATTERNS,
    KINDS,
    luhnValid,
    mask,
  },
};

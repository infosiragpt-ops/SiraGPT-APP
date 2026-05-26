'use strict';

/**
 * document-fx-rates.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects currency exchange rate references in financial reports / treasury
 * docs / FX trading notes:
 *
 *   - Pair with rate: USD/EUR 1.10, EUR/USD = 0.91
 *   - Labeled: "exchange rate", "FX rate", "tipo de cambio"
 *   - "1 USD = 0.91 EUR" / "1 EUR equals 1.10 USD"
 *
 * Different from document-currency (amounts) by tagging cross-currency
 * conversions specifically. Routes "what FX rate?" / "exchange rate?"
 * to a citeable list.
 *
 * Public API:
 *   extractFxRates(text)         → FxReport
 *   buildFxRatesForFiles(files)  → { perFile, aggregate, totals }
 *   renderFxRatesBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 20;
const MAX_BLOCK_CHARS = 4500;
const MAX_VALUE_LEN = 80;

const ISO_CURRENCIES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'INR', 'CAD', 'AUD', 'NZD', 'CHF',
  'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'BRL', 'MXN', 'ARS', 'COP',
  'CLP', 'PEN', 'RUB', 'TRY', 'ILS', 'SAR', 'AED', 'KRW', 'SGD', 'HKD',
  'TWD', 'THB', 'IDR', 'VND', 'PHP', 'MYR', 'ZAR',
]);

const PATTERNS = [
  // X/Y rate: "USD/EUR 1.10" or "USD/EUR = 1.10"
  { kind: 'pair-rate', re: /\b([A-Z]{3})\s*\/\s*([A-Z]{3})\s*(?:=|:|\bat\b|\bes\b)?\s*(\d+(?:[.,]\d+)?)/g },
  // 1 X = N Y
  { kind: 'equation', re: /\b1\s+([A-Z]{3})\s*(?:=|equals?|is)\s*(\d+(?:[.,]\d+)?)\s+([A-Z]{3})\b/gi },
  // Labeled forms
  { kind: 'labeled', re: /\b(?:exchange\s+rate|FX\s+rate|tipo\s+de\s+cambio)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/gi },
];

const KINDS = PATTERNS.map((p) => p.kind);

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

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractFxRates(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  for (const m of head.matchAll(PATTERNS[0].re)) {
    if (entries.length >= MAX_PER_FILE) break;
    const a = m[1];
    const b = m[2];
    if (!ISO_CURRENCIES.has(a) || !ISO_CURRENCIES.has(b)) continue;
    const phrase = clipValue(m[0]);
    const key = `pair-rate|${a}/${b}|${m[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'pair-rate', value: phrase, pair: `${a}/${b}`, rate: m[3] });
    totals['pair-rate'] += 1;
  }

  for (const m of head.matchAll(PATTERNS[1].re)) {
    if (entries.length >= MAX_PER_FILE) break;
    const a = m[1];
    const b = m[3];
    if (!ISO_CURRENCIES.has(a) || !ISO_CURRENCIES.has(b)) continue;
    const phrase = clipValue(m[0]);
    const key = `equation|${a}/${b}|${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'equation', value: phrase, pair: `${a}/${b}`, rate: m[2] });
    totals.equation += 1;
  }

  for (const m of head.matchAll(PATTERNS[2].re)) {
    if (entries.length >= MAX_PER_FILE) break;
    const phrase = clipValue(m[0]);
    const key = `labeled|${m[1]}|${phrase.slice(0, 30).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'labeled', value: phrase, rate: m[1] });
    totals.labeled += 1;
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildFxRatesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractFxRates(safeText(f.extractedText));
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
  return `- [${e.kind}] **${e.value}**${file}`;
}

function renderFxRatesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## CURRENCY EXCHANGE RATES (FX)
Foreign exchange rate references: pair-rate form (USD/EUR 1.10), equation form (1 USD = 0.91 EUR), and labeled form ("exchange rate: 1.10" / "tipo de cambio"). Validated against an ISO currency whitelist. Different from currency amount extraction by tagging cross-currency conversions specifically. Routes "what FX rate?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate FX rates across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...FX rates block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractFxRates,
  buildFxRatesForFiles,
  renderFxRatesBlock,
  _internal: {
    PATTERNS,
    KINDS,
    ISO_CURRENCIES,
  },
};

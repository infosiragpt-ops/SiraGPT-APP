'use strict';

/**
 * document-currency.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects monetary amounts with currency tags in documents:
 *
 *   - Currency-symbol prefix: $1,234.56, €100, £50, ¥10000, ₿0.01, ₹500
 *   - ISO-suffix form: 1,234.56 USD, 100 EUR, 50000 JPY
 *   - Negative / parenthesised amounts: ($100), -€50
 *   - Decimal notation per locale: 1.234,56 EUR
 *   - "USD 1,234.56", "EUR 100"
 *
 * Different from document-pricing (named tiers / SaaS plans),
 * document-numeric-statistics (per-document number rollups),
 * and document-cross-numeric (units like %/mph etc.). Routes
 * "what amount?" / "how much?" to a citeable inventory.
 *
 * Public API:
 *   extractCurrency(text)         → CurrencyReport
 *   buildCurrencyForFiles(files)  → { perFile, aggregate, byCurrency }
 *   renderCurrencyBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;
const MAX_VALUE_LEN = 60;

// Common ISO currency codes
const ISO_CURRENCIES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'INR', 'CAD', 'AUD', 'NZD', 'CHF',
  'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'HRK',
  'BRL', 'MXN', 'ARS', 'COP', 'CLP', 'PEN', 'VES', 'UYU', 'BOB', 'PYG',
  'RUB', 'TRY', 'ILS', 'SAR', 'AED', 'KWD', 'QAR', 'OMR', 'BHD', 'JOD',
  'KRW', 'SGD', 'HKD', 'TWD', 'MYR', 'THB', 'PHP', 'IDR', 'VND',
  'ZAR', 'NGN', 'KES', 'EGP', 'GHS', 'TZS', 'UGX',
  'BTC', 'ETH', 'USDC', 'USDT',
]);

// Symbol → ISO mapping
const SYMBOL_TO_ISO = {
  '$': 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₹': 'INR',
  '₿': 'BTC',
  '₩': 'KRW',
  'R$': 'BRL',
  'C$': 'CAD',
  'A$': 'AUD',
  'CHF': 'CHF',
  'kr': 'SEK',
};

// Pattern variants
// Symbol-prefix amount: $1,234.56 / €100 / £50 / etc.
const SYMBOL_PREFIX_RE = /(?:^|[\s`'"<>(])(\$|€|£|¥|₹|₿|₩|R\$|C\$|A\$)\s*(-?\d{1,3}(?:[,.]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?)/g;
// ISO-suffix amount: 1,234.56 USD / 100 EUR / 50 JPY
const ISO_SUFFIX_RE = /(?:^|[\s`'"<>(])(-?\d{1,3}(?:[,.]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s+([A-Z]{3})\b/g;
// ISO-prefix amount: USD 1,234.56 / EUR 100
const ISO_PREFIX_RE = /(?:^|[\s`'"<>(])\b([A-Z]{3})\s+(-?\d{1,3}(?:[,.]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?)/g;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipValue(v) {
  const s = String(v || '').trim();
  if (s.length <= MAX_VALUE_LEN) return s;
  return `${s.slice(0, MAX_VALUE_LEN - 1)}…`;
}

function normaliseSymbol(sym) {
  const s = String(sym || '').trim();
  return SYMBOL_TO_ISO[s] || s.toUpperCase();
}

function isIsoCurrency(code) {
  return ISO_CURRENCIES.has(code);
}

function emptyByCurrency() {
  return {};
}

function extractCurrency(input) {
  const text = safeText(input);
  if (!text) return { amounts: [], total: 0, byCurrency: emptyByCurrency(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const amounts = [];
  const seen = new Set();
  const byCurrency = {};

  function add(currency, amount, source) {
    if (amounts.length >= MAX_PER_FILE) return;
    if (!currency || !amount) return;
    const a = clipValue(amount);
    const key = `${currency}|${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    amounts.push({ currency, amount: a, source });
    byCurrency[currency] = (byCurrency[currency] || 0) + 1;
  }

  for (const m of head.matchAll(SYMBOL_PREFIX_RE)) {
    add(normaliseSymbol(m[1]), m[2], 'symbol-prefix');
  }

  for (const m of head.matchAll(ISO_SUFFIX_RE)) {
    if (!isIsoCurrency(m[2])) continue;
    add(m[2], m[1], 'iso-suffix');
  }

  for (const m of head.matchAll(ISO_PREFIX_RE)) {
    if (!isIsoCurrency(m[1])) continue;
    add(m[1], m[2], 'iso-prefix');
  }

  return { amounts, total: amounts.length, byCurrency, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildCurrencyForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const byCurrency = {};
  for (const f of list) {
    const r = extractCurrency(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, amounts: r.amounts, byCurrency: r.byCurrency });
    aggregate = aggregate.concat(r.amounts.map((a) => ({ ...a, file: name })));
    for (const c of Object.keys(r.byCurrency)) byCurrency[c] = (byCurrency[c] || 0) + r.byCurrency[c];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, byCurrency };
}

function renderAmount(a, opts = {}) {
  const file = opts.includeFile && a.file ? ` _(${a.file})_` : '';
  return `- [${a.currency}] **${a.amount}**${file}`;
}

function renderCurrencyBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const byCurrency = report.byCurrency || {};
  const breakdown = Object.keys(byCurrency)
    .filter((c) => byCurrency[c] > 0)
    .map((c) => `${c}=${byCurrency[c]}`)
    .join('  ');
  const heading = `## CURRENCY AMOUNTS
Monetary amounts with currency tags detected in the document(s): symbol-prefix ($1,234.56 / €100 / £50 / ¥10000 / ₹500 / ₿0.01 / ₩50000 / R$ / C$ / A$), ISO-suffix (1,234.56 USD / 100 EUR / 50 JPY), and ISO-prefix (USD 1,234.56 / EUR 100). Different from named pricing tiers or generic numeric stats — focuses on currency-tagged amounts. Routes "what amount?" / "how much?" to a citeable inventory.

**By currency:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const a of only.amounts) sections.push(renderAmount(a));
  } else {
    sections.push('### Aggregate amounts across all files');
    for (const a of report.aggregate) sections.push(renderAmount(a, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const a of p.amounts) sections.push(renderAmount(a));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...currency block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractCurrency,
  buildCurrencyForFiles,
  renderCurrencyBlock,
  _internal: {
    SYMBOL_PREFIX_RE,
    ISO_SUFFIX_RE,
    ISO_PREFIX_RE,
    ISO_CURRENCIES,
    SYMBOL_TO_ISO,
    isIsoCurrency,
    normaliseSymbol,
  },
};

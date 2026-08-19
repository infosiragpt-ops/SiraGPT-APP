'use strict';

/**
 * document-currency-symbols.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects standalone currency symbol usage (not tied to an amount) — useful
 * for branding/UX docs that say "support € users", or i18n notes:
 *
 *   - €, $, £, ¥, ₹, ₿, ₩, R$, C$, A$
 *   - Context: payment, price tag, region tag
 *
 * Different from document-currency (amount-tagged values). Routes
 * "what currencies does the brand support?" / "where's the locale?".
 *
 * Public API:
 *   extractCurrencySymbols(text)         → CurSymReport
 *   buildCurrencySymbolsForFiles(files)  → { perFile }
 *   renderCurrencySymbolsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 20;
const MAX_BLOCK_CHARS = 4000;
const MAX_CONTEXT_LEN = 160;

const SYMBOL_TO_ISO = {
  '€': 'EUR',
  '$': 'USD',
  '£': 'GBP',
  '¥': 'JPY',
  '₹': 'INR',
  '₿': 'BTC',
  '₩': 'KRW',
  '₽': 'RUB',
  '₺': 'TRY',
  '₨': 'PKR',
  '₪': 'ILS',
  '฿': 'THB',
  '₫': 'VND',
};

// Symbols, NOT followed by a digit (since digits = amount captured by document-currency)
const SYMBOL_RE = new RegExp(`([${Object.keys(SYMBOL_TO_ISO).join('')}])(?!\\s*-?\\d)`, 'g');

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipContext(text, idx, len) {
  const start = Math.max(0, idx - 50);
  const end = Math.min(text.length, idx + len + 80);
  const ctx = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (ctx.length <= MAX_CONTEXT_LEN) return ctx;
  return `${ctx.slice(0, MAX_CONTEXT_LEN - 1)}…`;
}

function extractCurrencySymbols(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: {}, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = {};

  for (const m of head.matchAll(SYMBOL_RE)) {
    if (entries.length >= MAX_PER_FILE) break;
    const sym = m[1];
    const iso = SYMBOL_TO_ISO[sym];
    if (!iso) continue;
    const ctx = clipContext(head, m.index, 1);
    const key = `${iso}|${ctx.slice(0, 60).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ symbol: sym, iso, context: ctx });
    totals[iso] = (totals[iso] || 0) + 1;
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildCurrencySymbolsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = {};
  for (const f of list) {
    const r = extractCurrencySymbols(safeText(f.extractedText));
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
  return `- **${e.symbol}** (${e.iso})${file} — ${e.context}`;
}

function renderCurrencySymbolsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || {};
  const breakdown = Object.keys(totals)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## CURRENCY SYMBOLS (STANDALONE)
Standalone currency symbols (€/$/£/¥/₹/₿/₩/₽/₺/₨/₪/฿/₫) that are NOT followed by a numeric amount — useful for branding / i18n / locale documentation. Different from amount-tagged currency. Routes "what currencies does the brand support?" / "where's the locale?".

**By ISO:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate currency symbols across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...currency symbols block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractCurrencySymbols,
  buildCurrencySymbolsForFiles,
  renderCurrencySymbolsBlock,
  _internal: {
    SYMBOL_RE,
    SYMBOL_TO_ISO,
  },
};

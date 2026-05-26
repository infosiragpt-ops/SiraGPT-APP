'use strict';

/**
 * document-stock-tickers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects stock ticker symbols and ISIN codes in text:
 *
 *   - $AAPL  / $TSLA / $GOOG     (cashtag — Twitter / Discord style)
 *   - NYSE:TSLA / NASDAQ:GOOG    (exchange:ticker)
 *   - ISIN: US0378331005          (12 alphanumeric, country prefix)
 *   - ticker words in "shares of X" contexts
 *
 * Public API:
 *   extractStockTickers(text)             → { entries, totals, total }
 *   buildStockTickersForFiles(files)      → { perFile, aggregate, totals }
 *   renderStockTickersBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4500;

const CASHTAG_RE = /\$([A-Z]{1,6}(?:\.[A-Z]{1,3})?)\b/g;
const EXCHANGE_TICKER_RE = /\b(NYSE|NASDAQ|AMEX|TSE|LSE|HKEX|TSX|ASX|FWB|BME|OTC|JSE|MOEX|SSE|SZSE|NSE|BSE|EURONEXT|XETRA):([A-Z]{1,6}(?:\.[A-Z]{1,3})?)\b/g;
const ISIN_RE = /\b([A-Z]{2}[A-Z0-9]{9}\d)\b/g;
const SHARES_RE = /\b(?:shares\s+of|stock\s+of|shorted)\s+([A-Z][A-Za-z0-9.]{1,15})\b/g;

const RESERVED = new Set(['THE', 'AND', 'FOR', 'WITH', 'INTO', 'FROM', 'THAN', 'THIS', 'THAT', 'WHEN', 'WHERE']);

function looksLikeTicker(s) {
  if (!s || s.length < 1 || s.length > 8) return false;
  if (RESERVED.has(s)) return false;
  if (!/^[A-Z]+(?:\.[A-Z]+)?$/.test(s)) return false;
  return true;
}

function extractStockTickers(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { cashtag: 0, exchange: 0, isin: 0, contextual: 0 };

  function push(kind, ticker, ctx, exchange) {
    const key = `${kind}:${ticker}:${exchange || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, ticker, exchange: exchange || null, context: ctx });
    if (totals[kind] != null) totals[kind] += 1;
  }

  CASHTAG_RE.lastIndex = 0;
  let m;
  while ((m = CASHTAG_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    if (!looksLikeTicker(m[1])) continue;
    push('cashtag', m[1], 'cashtag', null);
  }

  if (entries.length < MAX_PER_FILE) {
    EXCHANGE_TICKER_RE.lastIndex = 0;
    while ((m = EXCHANGE_TICKER_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('exchange', m[2], 'exchange-ticker', m[1]);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    ISIN_RE.lastIndex = 0;
    while ((m = ISIN_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('isin', m[1], 'ISIN', m[1].slice(0, 2));
    }
  }

  if (entries.length < MAX_PER_FILE) {
    SHARES_RE.lastIndex = 0;
    while ((m = SHARES_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const t = m[1].toUpperCase();
      if (!looksLikeTicker(t)) continue;
      push('contextual', t, 'shares-of', null);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildStockTickersForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { cashtag: 0, exchange: 0, isin: 0, contextual: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractStockTickers(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.ticker}:${e.exchange || ''}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderStockTickersBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## STOCK TICKERS / ISINs'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      const exch = e.exchange ? ` (${e.exchange})` : '';
      lines.push(`- ${e.kind}: \`${e.ticker}\`${exch}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractStockTickers,
  buildStockTickersForFiles,
  renderStockTickersBlock,
  _internal: { looksLikeTicker },
};

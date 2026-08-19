'use strict';

/**
 * document-tracking-numbers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects shipping / parcel tracking numbers by carrier-specific format.
 * Numbers are MASKED first-4…last-4 because they identify shipments to
 * specific recipients.
 *
 * Targets:
 *   - UPS:    1Z + 16 alphanumeric (e.g. 1Z999AA10123456784)
 *   - FedEx:  12 digits (1234 5678 9012) or 14/15 digits
 *   - USPS:   13 alphanumeric (9405 5036 9930 0000 0000 00) or label IDs
 *   - DHL:    10 digits
 *   - Amazon: TBA + 12 digits / 11 alphanumeric
 *   - Canada Post: 16 digits
 *
 * Public API:
 *   extractTrackingNumbers(text)             → { entries, totals, total }
 *   buildTrackingNumbersForFiles(files)      → { perFile, aggregate, totals }
 *   renderTrackingNumbersBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 12;
const MAX_AGGREGATE = 16;
const MAX_BLOCK_CHARS = 4500;

const UPS_RE = /\b(1Z[A-Z0-9]{16})\b/g;
const FEDEX_LONG_RE = /\b(\d{15})\b/g;
const FEDEX_MED_RE = /\b(\d{12})\b/g;
const USPS_RE = /\b(94\d{2}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{2})\b/g;
const DHL_RE = /\bDHL[:\s]+(\d{10,12})\b/gi;
const AMAZON_RE = /\b(TBA\d{12})\b/g;
const CANADA_POST_RE = /\b(?:Canada Post[:\s]+)?(\d{16})\b(?=\s|$)/g;

function maskTracking(n) {
  if (typeof n !== 'string' || n.length < 8) return '****';
  return `${n.slice(0, 4)}…${n.slice(-4)}`;
}

function extractTrackingNumbers(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { ups: 0, fedex: 0, usps: 0, dhl: 0, amazon: 0, canadaPost: 0 };

  function push(carrier, raw) {
    const masked = maskTracking(raw);
    const key = `${carrier}:${raw}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ carrier, masked });
    if (totals[carrier] != null) totals[carrier] += 1;
  }

  UPS_RE.lastIndex = 0;
  let m;
  while ((m = UPS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('ups', m[1]);
  }
  if (entries.length < MAX_PER_FILE) {
    AMAZON_RE.lastIndex = 0;
    while ((m = AMAZON_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('amazon', m[1]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    USPS_RE.lastIndex = 0;
    while ((m = USPS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('usps', m[1].replace(/\s/g, ''));
    }
  }
  if (entries.length < MAX_PER_FILE) {
    DHL_RE.lastIndex = 0;
    while ((m = DHL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('dhl', m[1]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    CANADA_POST_RE.lastIndex = 0;
    while ((m = CANADA_POST_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const n = m[1];
      // Don't conflict with FedEx 15-digit
      push('canadaPost', n);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    FEDEX_LONG_RE.lastIndex = 0;
    while ((m = FEDEX_LONG_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('fedex', m[1]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    FEDEX_MED_RE.lastIndex = 0;
    while ((m = FEDEX_MED_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('fedex', m[1]);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildTrackingNumbersForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { ups: 0, fedex: 0, usps: 0, dhl: 0, amazon: 0, canadaPost: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractTrackingNumbers(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.carrier}:${e.masked}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.carrier] != null) totals[e.carrier] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderTrackingNumbersBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## SHIPPING TRACKING NUMBERS', '- Tracking IDs masked first-4…last-4'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 6)) {
      lines.push(`- ${e.carrier}: \`${e.masked}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractTrackingNumbers,
  buildTrackingNumbersForFiles,
  renderTrackingNumbersBlock,
  _internal: { maskTracking },
};

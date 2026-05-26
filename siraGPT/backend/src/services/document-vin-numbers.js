'use strict';

/**
 * document-vin-numbers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Vehicle Identification Numbers (17-char alphanumeric without I, O, Q).
 * VINs are partially MASKED — first 3 (WMI / manufacturer) + last 4 (sequence)
 * preserved; middle 10 chars masked because they encode the specific vehicle.
 *
 *   - bare: 17 alnum (no I, O, Q)
 *   - labeled: "VIN: …"
 *
 * Public API:
 *   extractVinNumbers(text)             → { entries, totals, total }
 *   buildVinNumbersForFiles(files)      → { perFile, aggregate, totals }
 *   renderVinNumbersBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 12;
const MAX_AGGREGATE = 16;
const MAX_BLOCK_CHARS = 4500;

const VIN_RE = /\b([A-HJ-NPR-Z0-9]{17})\b/g;
const VIN_LABELED_RE = /\bVIN\s*[:=#]?\s*([A-HJ-NPR-Z0-9]{17})\b/gi;

function maskVin(vin) {
  if (typeof vin !== 'string' || vin.length !== 17) return '****';
  return `${vin.slice(0, 3)}…${vin.slice(-4)}`;
}

function decodeYear(c) {
  const CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';
  const idx = CODES.indexOf(c);
  if (idx < 0) return null;
  return 1980 + idx; // approximate (rolls over every 30 chars)
}

function looksLikeVin(s) {
  if (!s || s.length !== 17) return false;
  // VINs cannot contain I, O, Q
  if (/[IOQ]/.test(s)) return false;
  // Must include both letters and digits typically
  if (!/[A-Z]/.test(s) || !/\d/.test(s)) return false;
  return true;
}

function extractVinNumbers(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { labeled: 0, bare: 0 };

  function push(vin, source) {
    if (!looksLikeVin(vin)) return;
    if (seen.has(vin)) return;
    seen.add(vin);
    const masked = maskVin(vin);
    const year = decodeYear(vin[9]);
    entries.push({ masked, source, year, wmi: vin.slice(0, 3) });
    if (totals[source] != null) totals[source] += 1;
  }

  VIN_LABELED_RE.lastIndex = 0;
  let m;
  while ((m = VIN_LABELED_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push(m[1], 'labeled');
  }
  if (entries.length < MAX_PER_FILE) {
    VIN_RE.lastIndex = 0;
    while ((m = VIN_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(m[1], 'bare');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildVinNumbersForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { labeled: 0, bare: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractVinNumbers(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.masked)) continue;
      aggSeen.add(e.masked);
      aggregate.push(e);
      if (totals[e.source] != null) totals[e.source] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderVinNumbersBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## VEHICLE IDENTIFICATION NUMBERS', '- VINs masked first-3…last-4 — WMI manufacturer code preserved'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 6)) {
      const yr = e.year ? ` (~${e.year})` : '';
      lines.push(`- WMI ${e.wmi}${yr}: \`${e.masked}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractVinNumbers,
  buildVinNumbersForFiles,
  renderVinNumbersBlock,
  _internal: { maskVin, looksLikeVin, decodeYear },
};

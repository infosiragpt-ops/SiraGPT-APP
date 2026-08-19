'use strict';

/**
 * document-coordinates.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects geographic coordinates in documents (location records, geo APIs,
 * geofencing rules, travel itineraries):
 *
 *   - Decimal: "40.7128, -74.0060", "lat: 40.7128, lng: -74.0060"
 *   - DMS: "40°42'46\"N 74°00'21\"W"
 *   - Compass-prefixed: "N 40.7128 W 74.0060"
 *   - Plus codes: "87G7M+QHF" (Open Location Code)
 *
 * Different from document-temporal-timeline / document-locations.
 * Routes "where is this?", "what coordinates?" to a citeable list.
 *
 * Public API:
 *   extractCoordinates(text)         → CoordReport
 *   buildCoordinatesForFiles(files)  → { perFile, aggregate, totals }
 *   renderCoordinatesBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 5000;
const MAX_VALUE_LEN = 80;

// Decimal lat,lng "40.7128, -74.0060"
const DECIMAL_RE = /(?<![\w.])(-?\d{1,2}(?:\.\d{2,8})?)\s*,\s*(-?\d{1,3}(?:\.\d{2,8})?)(?![\w.])/g;
// Labeled: "lat: X, lng/lon/long: Y"
const LABELED_RE = /\b(?:lat(?:itude)?)\s*[:=]\s*(-?\d{1,2}(?:\.\d{1,8})?)\s*[,;]\s*(?:lng?|lon|longitude)\s*[:=]\s*(-?\d{1,3}(?:\.\d{1,8})?)/gi;
// DMS: "40°42'46\"N 74°00'21\"W"
const DMS_RE = /(\d{1,3})°\s*(\d{1,2})['′]\s*(\d{1,2}(?:\.\d+)?)["″]?\s*([NSEW])\s*(\d{1,3})°\s*(\d{1,2})['′]\s*(\d{1,2}(?:\.\d+)?)["″]?\s*([NSEW])/gi;
// Plus codes (Open Location Code, 8+ chars)
const PLUS_CODE_RE = /\b([23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3})\b/g;

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

function isLikelyLatLng(lat, lng) {
  const la = Number(lat);
  const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return false;
  if (la < -90 || la > 90) return false;
  if (lo < -180 || lo > 180) return false;
  // Reject 0,0 (often false positive in docs)
  if (la === 0 && lo === 0) return false;
  return true;
}

function emptyTotals() {
  return { decimal: 0, dms: 0, plus: 0 };
}

function extractCoordinates(input) {
  const text = safeText(input);
  if (!text) return { coords: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const coords = [];
  const seen = new Set();
  const totals = emptyTotals();

  function add(kind, value) {
    if (coords.length >= MAX_PER_FILE) return;
    const v = clipValue(value);
    if (!v) return;
    const key = `${kind}|${v.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    coords.push({ kind, value: v });
    totals[kind] += 1;
  }

  // Labeled lat/lng first (highest confidence)
  for (const m of head.matchAll(LABELED_RE)) {
    if (!isLikelyLatLng(m[1], m[2])) continue;
    add('decimal', `${m[1]}, ${m[2]}`);
  }
  // Bare decimal lat,lng — must have at least 2 decimal places to filter false positives
  for (const m of head.matchAll(DECIMAL_RE)) {
    const [, lat, lng] = m;
    // Require at least one of lat/lng to have decimal precision
    if (!/\.\d+/.test(lat) && !/\.\d+/.test(lng)) continue;
    if (!isLikelyLatLng(lat, lng)) continue;
    add('decimal', `${lat}, ${lng}`);
  }
  // DMS
  for (const m of head.matchAll(DMS_RE)) {
    add('dms', m[0].replace(/\s+/g, ' ').trim());
  }
  // Plus codes
  for (const m of head.matchAll(PLUS_CODE_RE)) {
    add('plus', m[1]);
  }

  return { coords, total: coords.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildCoordinatesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractCoordinates(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, coords: r.coords, totals: r.totals });
    aggregate = aggregate.concat(r.coords.map((c) => ({ ...c, file: name })));
    for (const k of Object.keys(totals)) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderCoord(c, opts = {}) {
  const file = opts.includeFile && c.file ? ` _(${c.file})_` : '';
  return `- [${c.kind}] \`${c.value}\`${file}`;
}

function renderCoordinatesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## GEOGRAPHIC COORDINATES
Latitude/longitude coordinates detected in the document(s): decimal ("40.7128, -74.0060"), DMS ("40°42'46\\"N 74°00'21\\"W"), and Open Location Code (Plus codes). Validated against lat ∈ [-90, 90] and lng ∈ [-180, 180]. Routes "where is this?" / "what coordinates?" to a citeable list.

**Totals:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const c of only.coords) sections.push(renderCoord(c));
  } else {
    sections.push('### Aggregate coordinates across all files');
    for (const c of report.aggregate) sections.push(renderCoord(c, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const c of p.coords) sections.push(renderCoord(c));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...coordinates block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractCoordinates,
  buildCoordinatesForFiles,
  renderCoordinatesBlock,
  _internal: {
    DECIMAL_RE,
    LABELED_RE,
    DMS_RE,
    PLUS_CODE_RE,
    isLikelyLatLng,
  },
};

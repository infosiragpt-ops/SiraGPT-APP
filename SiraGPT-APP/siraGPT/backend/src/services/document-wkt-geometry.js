'use strict';

/**
 * document-wkt-geometry.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects OGC Well-Known Text (WKT) geometry literals in GIS / PostGIS docs:
 *
 *   - POINT(x y)
 *   - LINESTRING(x1 y1, x2 y2, ...)
 *   - POLYGON((x1 y1, x2 y2, ..., x1 y1))
 *   - MULTIPOINT, MULTILINESTRING, MULTIPOLYGON
 *   - GEOMETRYCOLLECTION
 *   - SRID prefix: SRID=4326;POINT(...)
 *   - Bbox: BBOX(minx miny maxx maxy)
 *
 * Public API:
 *   extractWktGeometry(text)             → { entries, totals, total }
 *   buildWktGeometryForFiles(files)      → { perFile, aggregate, totals }
 *   renderWktGeometryBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 4500;

const GEOMETRY_TYPES = [
  'POINT', 'LINESTRING', 'POLYGON',
  'MULTIPOINT', 'MULTILINESTRING', 'MULTIPOLYGON',
  'GEOMETRYCOLLECTION', 'BBOX', 'TRIANGLE', 'CIRCULARSTRING',
];
const GEOM_ALT = GEOMETRY_TYPES.join('|');
const WKT_RE = new RegExp(`(?:SRID\\s*=\\s*(\\d{1,5})\\s*;\\s*)?\\b(${GEOM_ALT})(?:\\s*Z|\\s*M|\\s*ZM)?\\s*\\(([\\s\\S]{2,400}?)\\)\\s*(?=$|[,;\\s])`, 'gi');

function countPoints(body, type) {
  const t = type.toUpperCase();
  if (t === 'POINT' || t === 'TRIANGLE') return 1;
  // count comma-separated tuples (rough)
  return (body.match(/,/g) || []).length + 1;
}

function extractWktGeometry(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = {};

  WKT_RE.lastIndex = 0;
  let m;
  while ((m = WKT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const srid = m[1] || null;
    const type = m[2].toUpperCase();
    const innerBody = m[3].slice(0, 80);
    const sig = `${type}:${srid || ''}:${innerBody}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    const points = countPoints(m[3], type);
    entries.push({ type, srid, snippet: m[0].slice(0, 80), pointCount: points });
    totals[type] = (totals[type] || 0) + 1;
  }

  return { entries, totals, total: entries.length };
}

function buildWktGeometryForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {};
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractWktGeometry(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const sk = `${e.type}:${e.snippet}`;
      if (aggSeen.has(sk)) continue;
      aggSeen.add(sk);
      aggregate.push(e);
      totals[e.type] = (totals[e.type] || 0) + 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderWktGeometryBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## WKT GEOMETRY LITERALS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      const srid = e.srid ? ` SRID=${e.srid}` : '';
      lines.push(`- ${e.type}${srid} (${e.pointCount} pts): \`${e.snippet}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractWktGeometry,
  buildWktGeometryForFiles,
  renderWktGeometryBlock,
  _internal: { countPoints, GEOMETRY_TYPES },
};

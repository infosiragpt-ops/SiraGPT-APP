'use strict';

/**
 * document-geojson.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects GeoJSON structural markers in JSON content:
 *
 *   - "type": "Feature" / "FeatureCollection"
 *   - "type": "Point" / "LineString" / "Polygon" / "MultiPoint" / "MultiLineString" / "MultiPolygon" / "GeometryCollection"
 *   - "coordinates": [...]
 *   - "properties": {...}
 *
 * Public API:
 *   extractGeojson(text)             → { entries, totals, total }
 *   buildGeojsonForFiles(files)      → { perFile, aggregate, totals }
 *   renderGeojsonBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 4500;

const TYPES = [
  'Feature', 'FeatureCollection',
  'Point', 'LineString', 'Polygon',
  'MultiPoint', 'MultiLineString', 'MultiPolygon',
  'GeometryCollection',
];
const TYPE_ALT = TYPES.join('|');
const TYPE_RE = new RegExp(`"type"\\s*:\\s*"(${TYPE_ALT})"`, 'g');
const COORDS_RE = /"coordinates"\s*:\s*\[/g;
const PROPS_RE = /"properties"\s*:\s*\{/g;
const BBOX_RE = /"bbox"\s*:\s*\[/g;
const CRS_RE = /"crs"\s*:\s*\{/g;

function classifyType(type) {
  if (type === 'Feature' || type === 'FeatureCollection') return 'feature';
  if (type === 'GeometryCollection') return 'collection';
  if (type.startsWith('Multi')) return 'multi-geometry';
  return 'geometry';
}

function extractGeojson(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { feature: 0, collection: 0, 'multi-geometry': 0, geometry: 0, coordinates: 0, properties: 0, bbox: 0, crs: 0 };

  TYPE_RE.lastIndex = 0;
  let m;
  let typeCounter = 0;
  while ((m = TYPE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const type = m[1];
    const family = classifyType(type);
    const key = `${type}:${typeCounter++}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'type', value: type, family });
    if (totals[family] != null) totals[family] += 1;
  }

  let coordsCount = 0;
  COORDS_RE.lastIndex = 0;
  while (COORDS_RE.exec(body) && coordsCount < 50) coordsCount += 1;
  totals.coordinates = coordsCount;

  let propsCount = 0;
  PROPS_RE.lastIndex = 0;
  while (PROPS_RE.exec(body) && propsCount < 50) propsCount += 1;
  totals.properties = propsCount;

  let bboxCount = 0;
  BBOX_RE.lastIndex = 0;
  while (BBOX_RE.exec(body) && bboxCount < 20) bboxCount += 1;
  totals.bbox = bboxCount;

  let crsCount = 0;
  CRS_RE.lastIndex = 0;
  while (CRS_RE.exec(body) && crsCount < 20) crsCount += 1;
  totals.crs = crsCount;

  return { entries, totals, total: entries.length };
}

function buildGeojsonForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggregate = [];
  const totals = { feature: 0, collection: 0, 'multi-geometry': 0, geometry: 0, coordinates: 0, properties: 0, bbox: 0, crs: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractGeojson(txt);
    if (report.total === 0 && (report.totals.coordinates || 0) === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      aggregate.push(e);
      if (totals[e.family] != null) totals[e.family] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    totals.coordinates += report.totals.coordinates || 0;
    totals.properties += report.totals.properties || 0;
    totals.bbox += report.totals.bbox || 0;
    totals.crs += report.totals.crs || 0;
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderGeojsonBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## GEOJSON STRUCTURE'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- type: ${e.value} (${e.family})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractGeojson,
  buildGeojsonForFiles,
  renderGeojsonBlock,
  _internal: { classifyType },
};

'use strict';

/**
 * document-dms-coords.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects geographic coordinates in degree-minute-second (DMS) and other
 * non-decimal-degree forms:
 *
 *   - DMS:  40°26'46"N 79°58'56"W
 *   - DDM:  40°26.766'N 79°58.933'W (degrees + decimal minutes)
 *   - UTM-like markers: 18T 585628E 4477700N
 *   - MGRS:  18TWL850777 (military grid)
 *
 * Public API:
 *   extractDmsCoords(text)             → { entries, totals, total }
 *   buildDmsCoordsForFiles(files)      → { perFile, aggregate, totals }
 *   renderDmsCoordsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 4500;

const DMS_RE = /(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*(\d{1,2}(?:\.\d+)?)\s*["″]\s*([NSEW])/g;
const DDM_RE = /(\d{1,3})\s*°\s*(\d{1,2}(?:\.\d+)?)\s*['′]\s*([NSEW])/g;
const UTM_RE = /\b(\d{1,2})\s*([A-HJ-NP-Za-hj-np-z])\s+(\d{6})\s*[Ee]\s+(\d{7})\s*[Nn]/g;
const MGRS_RE = /\b(\d{1,2}[A-HJ-NP-Za-hj-np-z][A-Za-z]{2}\d{4,10})\b/g;

function dmsToDecimal(deg, min, sec, hemi) {
  const sign = hemi === 'S' || hemi === 'W' ? -1 : 1;
  return sign * (parseFloat(deg) + parseFloat(min) / 60 + parseFloat(sec) / 3600);
}

function ddmToDecimal(deg, min, hemi) {
  const sign = hemi === 'S' || hemi === 'W' ? -1 : 1;
  return sign * (parseFloat(deg) + parseFloat(min) / 60);
}

function extractDmsCoords(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { dms: 0, ddm: 0, utm: 0, mgrs: 0 };

  DMS_RE.lastIndex = 0;
  let m;
  while ((m = DMS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const decimal = dmsToDecimal(m[1], m[2], m[3], m[4]);
    const key = `dms:${m[0]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'dms', raw: m[0], decimal: decimal.toFixed(6), hemi: m[4] });
    totals.dms += 1;
  }

  if (entries.length < MAX_PER_FILE) {
    DDM_RE.lastIndex = 0;
    while ((m = DDM_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const decimal = ddmToDecimal(m[1], m[2], m[3]);
      const key = `ddm:${m[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'ddm', raw: m[0], decimal: decimal.toFixed(6), hemi: m[3] });
      totals.ddm += 1;
    }
  }

  if (entries.length < MAX_PER_FILE) {
    UTM_RE.lastIndex = 0;
    while ((m = UTM_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `utm:${m[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'utm', raw: m[0], zone: `${m[1]}${m[2]}` });
      totals.utm += 1;
    }
  }

  if (entries.length < MAX_PER_FILE) {
    MGRS_RE.lastIndex = 0;
    while ((m = MGRS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      // Must start with digit (zone) + letter
      if (!/^\d/.test(m[1])) continue;
      const key = `mgrs:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'mgrs', raw: m[1] });
      totals.mgrs += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildDmsCoordsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { dms: 0, ddm: 0, utm: 0, mgrs: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractDmsCoords(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.raw}`;
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

function renderDmsCoordsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## DMS / GEOGRAPHIC COORDINATES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      const dec = e.decimal ? ` → ${e.decimal}°` : '';
      lines.push(`- [${e.kind}] \`${e.raw}\`${dec}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractDmsCoords,
  buildDmsCoordsForFiles,
  renderDmsCoordsBlock,
  _internal: { dmsToDecimal, ddmToDecimal },
};

'use strict';

/**
 * document-iso-durations.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects ISO 8601 duration literals:
 *
 *   - PT1H30M / PT15M / PT45S         (time-only)
 *   - P1D / P3DT12H                   (date and combined)
 *   - P1Y6M / P10Y                    (years, months)
 *   - P3W                             (weeks)
 *   - PT0.5H / PT0.25M                (decimal fractions)
 *
 * Computes total seconds for each duration where possible.
 *
 * Public API:
 *   extractIsoDurations(text)             → { entries, totals, total }
 *   buildIsoDurationsForFiles(files)      → { perFile, aggregate, totals }
 *   renderIsoDurationsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const DURATION_RE = /\bP(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?\b/g;

function toSeconds(parts) {
  const [yr, mo, wk, d, hr, min, s] = parts.map((x) => x != null ? parseFloat(x) : 0);
  return yr * 31_536_000 + mo * 2_592_000 + wk * 604_800 + d * 86_400 + hr * 3600 + min * 60 + s;
}

function classifyDuration(seconds) {
  if (seconds < 60) return 'sub-minute';
  if (seconds < 3600) return 'minutes';
  if (seconds < 86_400) return 'hours';
  if (seconds < 604_800) return 'days';
  if (seconds < 2_592_000) return 'weeks';
  if (seconds < 31_536_000) return 'months';
  return 'years';
}

function extractIsoDurations(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { 'sub-minute': 0, minutes: 0, hours: 0, days: 0, weeks: 0, months: 0, years: 0 };

  DURATION_RE.lastIndex = 0;
  let m;
  while ((m = DURATION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    // Skip if the matched string is just "P" or "PT" (no fields filled)
    const filled = m.slice(1, 8).some((g) => g != null);
    if (!filled) continue;
    const value = m[0];
    if (seen.has(value)) continue;
    seen.add(value);
    const seconds = toSeconds(m.slice(1, 8));
    const bucket = classifyDuration(seconds);
    entries.push({ duration: value, seconds, bucket });
    if (totals[bucket] != null) totals[bucket] += 1;
  }

  return { entries, totals, total: entries.length };
}

function buildIsoDurationsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { 'sub-minute': 0, minutes: 0, hours: 0, days: 0, weeks: 0, months: 0, years: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractIsoDurations(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.duration)) continue;
      aggSeen.add(e.duration);
      aggregate.push(e);
      if (totals[e.bucket] != null) totals[e.bucket] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderIsoDurationsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## ISO 8601 DURATIONS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- ${e.duration} (${e.seconds}s, ${e.bucket})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractIsoDurations,
  buildIsoDurationsForFiles,
  renderIsoDurationsBlock,
  _internal: { toSeconds, classifyDuration },
};

'use strict';

/**
 * document-weather.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects weather / climate references in incident reports / capacity
 * docs / agricultural / meteorological text:
 *
 *   - Temperature: 25°C, 77°F, 298K, -5°C
 *   - Precipitation: "5 mm of rain", "2 inches of snow"
 *   - Wind: "20 mph winds", "30 km/h gusts"
 *   - Humidity: "65% humidity"
 *   - Climate: "global warming", "climate change", "carbon dioxide", "CO2"
 *
 * Different from generic numeric stats by tagging weather-domain semantics.
 * Routes "what temperature?" / "what climate?" to a citeable list.
 *
 * Public API:
 *   extractWeather(text)         → WeatherReport
 *   buildWeatherForFiles(files)  → { perFile, aggregate, totals }
 *   renderWeatherBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 5000;
const MAX_VALUE_LEN = 60;

const PATTERNS = [
  { kind: 'temp-c', re: /(-?\d{1,3}(?:[.,]\d+)?)\s*°?\s*C\b/g },
  { kind: 'temp-f', re: /(-?\d{1,3}(?:[.,]\d+)?)\s*°?\s*F\b/g },
  { kind: 'temp-k', re: /(\d{1,4}(?:[.,]\d+)?)\s*K(?:elvin)?\b/g },
  { kind: 'precipitation', re: /\b(\d+(?:[.,]\d+)?)\s*(?:mm|cm|in|inches?|inch)\s+of\s+(?:rain|snow|precipitation|lluvia|nieve)/gi },
  { kind: 'wind', re: /\b(\d+(?:[.,]\d+)?)\s*(?:mph|kph|km\/h|knots?)\b[^.\n]{0,40}(?:wind|gusts?|viento)?/gi },
  { kind: 'humidity', re: /\b(\d{1,3})\s*%\s+(?:humidity|humedad)/gi },
  { kind: 'climate-term', re: /\b(global\s+warming|climate\s+change|carbon\s+dioxide|greenhouse\s+gas(?:es)?|el\s+ni[ñn]o|la\s+ni[ñn]a|cambio\s+clim[áa]tico|calentamiento\s+global)\b/giu },
  { kind: 'co2', re: /\bCO2?\s*(?:emissions?|levels?|emisiones?|niveles?)?\b/gi },
];

const KINDS = PATTERNS.map((p) => p.kind);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipValue(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_VALUE_LEN) return t;
  return `${t.slice(0, MAX_VALUE_LEN - 1)}…`;
}

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractWeather(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of head.matchAll(re)) {
      if (entries.length >= MAX_PER_FILE) break;
      const phrase = clipValue(m[0]);
      const key = `${kind}|${phrase.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind, phrase });
      totals[kind] += 1;
    }
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildWeatherForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractWeather(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of KINDS) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [${e.kind}] \`${e.phrase}\`${file}`;
}

function renderWeatherBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## WEATHER / CLIMATE
Weather and climate references detected — temperature (°C / °F / K), precipitation (mm/in of rain/snow), wind (mph/kph/km/h/knots), humidity (% humidity), climate terms (global warming, climate change, El Niño, cambio climático, calentamiento global), CO2 emissions. Different from generic numeric stats by tagging weather-domain semantics. Routes "what temperature?" / "what climate?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate weather refs across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...weather block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractWeather,
  buildWeatherForFiles,
  renderWeatherBlock,
  _internal: {
    PATTERNS,
    KINDS,
  },
};

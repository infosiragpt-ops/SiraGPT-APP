'use strict';

/**
 * document-geo-regions.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects geographic region references — continent names, common country
 * names, ISO 3166 codes:
 *
 *   - Continents: North America, South America, Europe, Asia, Africa,
 *     Oceania, Antarctica
 *   - Regional groupings: EMEA, APAC, LATAM, MENA, NAFTA, BRICS, GCC
 *   - ISO 3166-1 alpha-2 / alpha-3 codes (US, USA, GB, GBR, DE, DEU, BR, BRA...)
 *   - Common country names (English + Spanish)
 *
 * Routes "what region?" / "what countries?" to a citeable list.
 *
 * Public API:
 *   extractGeoRegions(text)         → GeoReport
 *   buildGeoRegionsForFiles(files)  → { perFile, aggregate, totals }
 *   renderGeoRegionsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_KIND = 12;
const MAX_PER_FILE = 28;
const MAX_AGGREGATE = 32;
const MAX_BLOCK_CHARS = 5000;
const MAX_VALUE_LEN = 60;

const CONTINENTS = [
  'North America', 'South America', 'Latin America', 'Central America',
  'Europe', 'Asia', 'Africa', 'Oceania', 'Antarctica',
  'América del Norte', 'América del Sur', 'Latinoamérica', 'Centroamérica',
];

const GROUPINGS = ['EMEA', 'APAC', 'LATAM', 'MENA', 'NAFTA', 'BRICS', 'GCC', 'ASEAN', 'CIS', 'EU', 'UK', 'US', 'USA', 'UAE', 'EEA'];

const COUNTRIES = [
  'United States', 'United Kingdom', 'Canada', 'Mexico', 'Brazil', 'Argentina',
  'Spain', 'France', 'Germany', 'Italy', 'Portugal', 'Netherlands', 'Belgium',
  'Switzerland', 'Sweden', 'Norway', 'Denmark', 'Finland', 'Iceland', 'Poland',
  'Russia', 'China', 'Japan', 'South Korea', 'India', 'Pakistan', 'Indonesia',
  'Australia', 'New Zealand', 'Singapore', 'Hong Kong', 'Taiwan', 'Thailand',
  'Vietnam', 'Malaysia', 'Philippines', 'Israel', 'Turkey', 'Saudi Arabia',
  'Egypt', 'South Africa', 'Nigeria', 'Kenya', 'Chile', 'Colombia', 'Peru',
  'Venezuela', 'Bolivia', 'Ecuador', 'Uruguay', 'Paraguay', 'Costa Rica',
  'Panama', 'Cuba', 'Dominican Republic', 'Puerto Rico',
  'Estados Unidos', 'Reino Unido', 'Canadá', 'México', 'Brasil', 'España',
  'Francia', 'Alemania', 'Italia', 'Países Bajos', 'Suecia', 'Noruega',
  'Suiza', 'Rusia', 'Japón', 'Corea del Sur', 'Tailandia', 'Sudáfrica',
];

const PATTERNS = [
  { kind: 'continent', re: new RegExp(`\\b(${CONTINENTS.join('|')})\\b`, 'gi') },
  { kind: 'grouping', re: new RegExp(`\\b(${GROUPINGS.join('|')})\\b`, 'g') },
  { kind: 'country', re: new RegExp(`\\b(${COUNTRIES.join('|')})\\b`, 'g') },
  { kind: 'iso-alpha3', re: /\b([A-Z]{3})\b/g },
];

const KINDS = PATTERNS.map((p) => p.kind);

// Whitelist of known ISO 3166-1 alpha-3 codes (subset)
const KNOWN_ISO3 = new Set([
  'USA', 'GBR', 'CAN', 'MEX', 'BRA', 'ARG', 'ESP', 'FRA', 'DEU', 'ITA',
  'PRT', 'NLD', 'BEL', 'CHE', 'SWE', 'NOR', 'DNK', 'FIN', 'ISL', 'POL',
  'RUS', 'CHN', 'JPN', 'KOR', 'IND', 'PAK', 'IDN', 'AUS', 'NZL', 'SGP',
  'HKG', 'TWN', 'THA', 'VNM', 'MYS', 'PHL', 'ISR', 'TUR', 'SAU', 'EGY',
  'ZAF', 'NGA', 'KEN', 'CHL', 'COL', 'PER', 'VEN', 'BOL', 'ECU', 'URY',
  'PRY', 'CRI', 'PAN', 'CUB', 'DOM', 'PRI', 'UKR', 'IRQ', 'IRN', 'AFG',
]);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractGeoRegions(input) {
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
      if (totals[kind] >= MAX_PER_KIND) break;
      const phrase = m[1] || m[0];
      // For iso-alpha3, validate against whitelist
      if (kind === 'iso-alpha3' && !KNOWN_ISO3.has(phrase)) continue;
      const normalized = phrase.length > MAX_VALUE_LEN ? `${phrase.slice(0, MAX_VALUE_LEN - 1)}…` : phrase;
      const key = `${kind}|${normalized.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind, value: normalized });
      totals[kind] += 1;
    }
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildGeoRegionsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractGeoRegions(safeText(f.extractedText));
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
  return `- [${e.kind}] \`${e.value}\`${file}`;
}

function renderGeoRegionsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## GEOGRAPHIC REGIONS
Geographic references detected: continents (North/South/Latin America, Europe, Asia, Africa, Oceania, Antarctica), regional groupings (EMEA / APAC / LATAM / MENA / NAFTA / BRICS / GCC / ASEAN / EU), ISO 3166-1 alpha-3 country codes (USA / GBR / DEU / BRA / JPN / ...), and ~60 common country names in English + Spanish. Routes "what region?" / "what countries?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate regions across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...geo regions block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractGeoRegions,
  buildGeoRegionsForFiles,
  renderGeoRegionsBlock,
  _internal: {
    CONTINENTS,
    GROUPINGS,
    COUNTRIES,
    KNOWN_ISO3,
    PATTERNS,
    KINDS,
  },
};

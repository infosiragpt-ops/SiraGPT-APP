'use strict';

/**
 * document-recipe-measurements.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects culinary measurements in recipes, cooking blogs, ingredient lists:
 *
 *   - volume: 1 cup, 2 tbsp, 1/2 tsp, 250 ml, 1 L
 *   - weight: 250 g, 1 kg, 8 oz, 1 lb
 *   - temperature: 350°F, 180°C, gas mark 5
 *   - time: 30 min, 1 hour (oven/bake/simmer context)
 *
 * Public API:
 *   extractRecipeMeasurements(text)             → { entries, totals, total }
 *   buildRecipeMeasurementsForFiles(files)      → { perFile, aggregate, totals }
 *   renderRecipeMeasurementsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const VOLUME_RE = /\b(\d+(?:\/\d+|\.\d+)?|\½|\¼|\¾|\⅓|\⅔)\s*(cups?|cup|tbsp|tablespoons?|tsp|teaspoons?|ml|mL|millilit(?:er|re)s?|L|lit(?:er|re)s?|fl\s*oz|fluid\s+ounces?|pints?|quarts?|gallons?)\b/gi;
const WEIGHT_RE = /\b(\d+(?:\.\d+)?)\s*(g|grams?|kg|kilograms?|mg|milligrams?|oz|ounces?|lbs?|pounds?)\b/gi;
const TEMPERATURE_RE = /\b(\d{2,3})\s*°?\s*(F|C|Fahrenheit|Celsius|fahrenheit|celsius)\b/g;
const GAS_MARK_RE = /\bgas\s+mark\s+(\d{1,2})\b/gi;
const COOK_TIME_RE = /\b(?:bake|cook|simmer|boil|broil|fry|roast|grill|stew|steam|microwave)\b[^.\n]{0,40}?\b(?:for\s+)?(\d+(?:\.\d+)?)\s*(min|minute|h|hr|hour)s?\b/gi;

const VOLUME_UNITS = new Set(['cup', 'cups', 'tbsp', 'tablespoon', 'tablespoons', 'tsp', 'teaspoon', 'teaspoons']);
const FRACTION_MAP = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 0.333, '⅔': 0.667 };

function normaliseAmount(a) {
  if (FRACTION_MAP[a] != null) return String(FRACTION_MAP[a]);
  if (a.includes('/')) {
    const [n, d] = a.split('/').map(Number);
    return d ? String(n / d) : a;
  }
  return a;
}

function classifyTemp(value, unit) {
  const u = unit.toLowerCase();
  const v = parseInt(value, 10);
  if (/c/.test(u) || u.includes('celsius')) {
    if (v >= 200) return 'hot';
    if (v >= 150) return 'medium';
    return 'low';
  }
  if (v >= 400) return 'hot';
  if (v >= 325) return 'medium';
  return 'low';
}

function extractRecipeMeasurements(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { volume: 0, weight: 0, temperature: 0, time: 0 };

  function push(kind, raw, normalised, ctx) {
    const key = `${kind}:${normalised}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, raw, normalised, ...(ctx || {}) });
    if (totals[kind] != null) totals[kind] += 1;
  }

  VOLUME_RE.lastIndex = 0;
  let m;
  while ((m = VOLUME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const amt = normaliseAmount(m[1]);
    const unit = m[2].toLowerCase();
    push('volume', m[0], `${amt}-${unit}`);
  }

  if (entries.length < MAX_PER_FILE) {
    WEIGHT_RE.lastIndex = 0;
    while ((m = WEIGHT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('weight', m[0], `${m[1]}-${m[2].toLowerCase()}`);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    TEMPERATURE_RE.lastIndex = 0;
    while ((m = TEMPERATURE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const range = classifyTemp(m[1], m[2]);
      push('temperature', m[0], `${m[1]}-${m[2].toLowerCase()}`, { range });
    }
    GAS_MARK_RE.lastIndex = 0;
    while ((m = GAS_MARK_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('temperature', m[0], `gas-${m[1]}`);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    COOK_TIME_RE.lastIndex = 0;
    while ((m = COOK_TIME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('time', m[0], `${m[1]}-${m[2].toLowerCase()}`);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildRecipeMeasurementsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { volume: 0, weight: 0, temperature: 0, time: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractRecipeMeasurements(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.normalised}`;
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

function renderRecipeMeasurementsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## RECIPE MEASUREMENTS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- [${e.kind}] ${e.raw}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractRecipeMeasurements,
  buildRecipeMeasurementsForFiles,
  renderRecipeMeasurementsBlock,
  _internal: { normaliseAmount, classifyTemp },
};

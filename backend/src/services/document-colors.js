'use strict';

/**
 * document-colors.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects color codes referenced in design specs, brand guidelines, CSS docs:
 *
 *   - Hex: #RRGGBB, #RGB, #RRGGBBAA, #RGBA
 *   - RGB / RGBA: rgb(255, 0, 0), rgba(255, 0, 0, 0.5)
 *   - HSL / HSLA: hsl(120, 100%, 50%)
 *   - Named CSS colors: red, blue, royalblue, etc. (curated list)
 *   - Tailwind utility tokens: bg-red-500, text-blue-700
 *
 * Output normalises into kind + value pairs. Routes "what colors does
 * this use?", "what's the brand palette?" to a citeable inventory.
 *
 * Public API:
 *   extractColors(text)          → ColorReport
 *   buildColorsForFiles(files)   → { perFile, aggregate, totals }
 *   renderColorsBlock(report)    → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_KIND = 12;
const MAX_PER_FILE = 32;
const MAX_AGGREGATE = 36;
const MAX_BLOCK_CHARS = 5000;

const HEX_RE = /(?:^|[\s`'"<>(,;:])(#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4}))(?=[\s`'"<>):,;.!?]|$)/g;
const RGB_RE = /\brgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)/gi;
const HSL_RE = /\bhsla?\(\s*(\d{1,3})\s*,\s*(\d{1,3}%?)\s*,\s*(\d{1,3}%?)(?:\s*,\s*(0|1|0?\.\d+))?\s*\)/gi;
const TAILWIND_RE = /\b((?:bg|text|border|ring|from|to|via|fill|stroke|placeholder|caret|accent|decoration|outline|divide|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950))\b/g;

const NAMED_COLORS = new Set([
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque',
  'black', 'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue',
  'chartreuse', 'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan',
  'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgrey', 'darkgreen',
  'darkkhaki', 'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred',
  'darksalmon', 'darkseagreen', 'darkslateblue', 'darkslategray', 'darkturquoise',
  'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue',
  'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro', 'ghostwhite',
  'gold', 'goldenrod', 'gray', 'grey', 'green', 'greenyellow', 'honeydew',
  'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender', 'lavenderblush',
  'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan', 'lightgoldenrodyellow',
  'lightgray', 'lightgrey', 'lightgreen', 'lightpink', 'lightsalmon', 'lightseagreen',
  'lightskyblue', 'lightslategray', 'lightsteelblue', 'lightyellow', 'lime', 'limegreen',
  'linen', 'magenta', 'maroon', 'mediumaquamarine', 'mediumblue', 'mediumorchid',
  'mediumpurple', 'mediumseagreen', 'mediumslateblue', 'mediumspringgreen', 'mediumturquoise',
  'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose', 'moccasin', 'navajowhite',
  'navy', 'oldlace', 'olive', 'olivedrab', 'orange', 'orangered', 'orchid', 'palegoldenrod',
  'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff', 'peru', 'pink',
  'plum', 'powderblue', 'purple', 'rebeccapurple', 'red', 'rosybrown', 'royalblue',
  'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell', 'sienna', 'silver',
  'skyblue', 'slateblue', 'slategray', 'snow', 'springgreen', 'steelblue', 'tan', 'teal',
  'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow',
  'yellowgreen', 'transparent',
]);

// Word boundary for named colors, case-insensitive, capturing
const NAMED_COLOR_RE = /\b([a-z]{3,30})\b/gi;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function emptyTotals() {
  return { hex: 0, rgb: 0, hsl: 0, named: 0, tailwind: 0 };
}

function extractColors(input) {
  const text = safeText(input);
  if (!text) return { colors: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const colors = [];
  const seen = new Set();
  const totals = emptyTotals();

  function add(kind, value) {
    if (colors.length >= MAX_PER_FILE) return;
    if (totals[kind] >= MAX_PER_KIND) return;
    const v = String(value || '').trim();
    if (!v) return;
    const key = `${kind}|${v.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    colors.push({ kind, value: v });
    totals[kind] += 1;
  }

  for (const m of head.matchAll(HEX_RE)) add('hex', m[1].toLowerCase());
  for (const m of head.matchAll(RGB_RE)) add('rgb', m[0].toLowerCase());
  for (const m of head.matchAll(HSL_RE)) add('hsl', m[0].toLowerCase());
  for (const m of head.matchAll(TAILWIND_RE)) add('tailwind', m[1]);

  // Named colors — match anywhere but only count if in NAMED_COLORS set
  for (const m of head.matchAll(NAMED_COLOR_RE)) {
    const word = m[1].toLowerCase();
    if (NAMED_COLORS.has(word)) {
      add('named', word);
    }
  }

  return { colors, total: colors.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildColorsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractColors(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, colors: r.colors, totals: r.totals });
    aggregate = aggregate.concat(r.colors.map((c) => ({ ...c, file: name })));
    for (const k of Object.keys(totals)) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderColor(c, opts = {}) {
  const file = opts.includeFile && c.file ? ` _(${c.file})_` : '';
  return `- [${c.kind}] \`${c.value}\`${file}`;
}

function renderColorsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## COLORS / PALETTE
Color codes detected in the document(s): hex (#RRGGBB, #RGB, with alpha), RGB / RGBA, HSL / HSLA, Tailwind utility tokens (bg-red-500, text-blue-700), and CSS named colors (~140 entries). Routes "what colors does this use?" / "what's the brand palette?" to a citeable inventory.

**Totals:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const c of only.colors) sections.push(renderColor(c));
  } else {
    sections.push('### Aggregate colors across all files');
    for (const c of report.aggregate) sections.push(renderColor(c, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const c of p.colors) sections.push(renderColor(c));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...colors block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractColors,
  buildColorsForFiles,
  renderColorsBlock,
  _internal: {
    HEX_RE,
    RGB_RE,
    HSL_RE,
    TAILWIND_RE,
    NAMED_COLOR_RE,
    NAMED_COLORS,
  },
};

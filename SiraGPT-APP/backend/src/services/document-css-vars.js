'use strict';

/**
 * document-css-vars.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects CSS custom properties (CSS variables):
 *
 *   - Declarations:  --color-primary: #ff0000;
 *   - References:    color: var(--color-primary)
 *   - Fallbacks:     var(--color-primary, #000)
 *   - @property:     @property --my-prop { syntax: '<color>'; inherits: true; initial-value: red; }
 *
 * Classifies by naming convention:
 *   - palette:  starts with --color- / --bg- / --fg-
 *   - size:     starts with --size- / --space- / --gap- / --pad- / --margin-
 *   - font:     starts with --font- / --text-
 *   - radius:   starts with --radius- / --border-radius-
 *   - z-index:  starts with --z-
 *   - other:    everything else
 *
 * Public API:
 *   extractCssVars(text)               → { entries, totals, total }
 *   buildCssVarsForFiles(files)        → { perFile, aggregate, totals }
 *   renderCssVarsBlock(report)         → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const DECL_RE = /(--[a-zA-Z][a-zA-Z0-9_-]{0,80})\s*:\s*([^;{}\n]{1,200})\s*[;}]/g;
const REF_RE = /\bvar\(\s*(--[a-zA-Z][a-zA-Z0-9_-]{0,80})(?:\s*,\s*([^)]{0,80}))?\s*\)/g;
const PROPERTY_AT_RE = /@property\s+(--[a-zA-Z][a-zA-Z0-9_-]{0,80})\s*\{/g;

function classifyVar(name) {
  const n = name.toLowerCase();
  if (/^--(?:color|bg|background|fg|foreground|text-color|theme)-/.test(n)) return 'palette';
  if (/^--(?:size|space|spacing|gap|pad|padding|margin|width|height)-/.test(n)) return 'size';
  if (/^--(?:font|text|line-height|letter-spacing)-/.test(n)) return 'font';
  if (/^--(?:radius|border-radius|rounded)-/.test(n)) return 'radius';
  if (/^--z-/.test(n)) return 'zIndex';
  if (/^--(?:shadow|box-shadow|elevation)-/.test(n)) return 'shadow';
  if (/^--(?:transition|animation|duration|easing|timing)-/.test(n)) return 'motion';
  return 'other';
}

function previewValue(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (s.length <= 32) return s;
  return `${s.slice(0, 24)}…`;
}

function extractCssVars(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { palette: 0, size: 0, font: 0, radius: 0, zIndex: 0, shadow: 0, motion: 0, other: 0, references: 0, propertyAt: 0 };

  function pushDecl(name, value) {
    const cat = classifyVar(name);
    const key = `decl:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind: 'decl', category: cat, name, value: previewValue(value) });
    if (totals[cat] != null) totals[cat] += 1;
  }

  DECL_RE.lastIndex = 0;
  let m;
  while ((m = DECL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    pushDecl(m[1], m[2]);
  }

  let refCount = 0;
  const refSeen = new Set();
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(body)) && refCount < 50) {
    if (!refSeen.has(m[1])) {
      refSeen.add(m[1]);
      refCount += 1;
      if (entries.length < MAX_PER_FILE) {
        const cat = classifyVar(m[1]);
        entries.push({ kind: 'ref', category: cat, name: m[1], value: m[2] ? `fallback: ${previewValue(m[2])}` : '' });
      }
    }
  }
  totals.references = refCount;

  let propCount = 0;
  PROPERTY_AT_RE.lastIndex = 0;
  while ((m = PROPERTY_AT_RE.exec(body)) && propCount < 20) {
    propCount += 1;
    if (entries.length < MAX_PER_FILE) {
      entries.push({ kind: 'property', category: classifyVar(m[1]), name: m[1], value: '@property' });
    }
  }
  totals.propertyAt = propCount;

  return { entries, totals, total: entries.length };
}

function buildCssVarsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { palette: 0, size: 0, font: 0, radius: 0, zIndex: 0, shadow: 0, motion: 0, other: 0, references: 0, propertyAt: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractCssVars(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (e.kind === 'decl' && totals[e.category] != null) totals[e.category] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderCssVarsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## CSS CUSTOM PROPERTIES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const val = e.value ? ` = \`${e.value}\`` : '';
      lines.push(`- [${e.kind}/${e.category}] \`${e.name}\`${val}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractCssVars,
  buildCssVarsForFiles,
  renderCssVarsBlock,
  _internal: { classifyVar, previewValue },
};

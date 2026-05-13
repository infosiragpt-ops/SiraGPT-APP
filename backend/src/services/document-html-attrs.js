'use strict';

/**
 * document-html-attrs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects HTML attributes referenced in design/implementation docs:
 *
 *   - Common attributes: rel, target, sandbox, contenteditable, hidden,
 *     href, src, alt, role, aria-*, data-*
 *   - Inline form: rel="noopener", target="_blank"
 *   - Labeled mentions: "the rel attribute", "data-foo attribute"
 *
 * Different from document-api-endpoints (HTTP paths) and document-urls
 * (full links). Routes "what HTML attributes are used?" to a citeable list.
 *
 * Public API:
 *   extractHtmlAttrs(text)         → HtmlAttrReport
 *   buildHtmlAttrsForFiles(files)  → { perFile, aggregate, totals }
 *   renderHtmlAttrsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;
const MAX_VALUE_LEN = 80;

const COMMON_ATTRS = new Set([
  'rel', 'target', 'href', 'src', 'alt', 'title',
  'sandbox', 'contenteditable', 'hidden', 'disabled', 'readonly', 'required',
  'role', 'tabindex', 'lang', 'dir', 'translate', 'spellcheck',
  'type', 'name', 'value', 'placeholder', 'autocomplete', 'autofocus',
  'min', 'max', 'step', 'pattern', 'accept', 'multiple', 'size',
  'method', 'action', 'enctype', 'novalidate',
  'charset', 'viewport', 'content', 'http-equiv',
  'class', 'id', 'style',
  'srcset', 'sizes', 'loading', 'decoding', 'crossorigin', 'integrity',
  'allow', 'allowfullscreen', 'autoplay', 'controls', 'loop', 'muted', 'preload', 'poster',
  'colspan', 'rowspan', 'scope', 'headers',
  'for', 'form', 'list', 'maxlength', 'minlength',
]);

// Inline attribute: attr="value" or attr='value'
const ATTR_VALUE_RE = /\b([a-z][a-zA-Z0-9_-]{1,30})\s*=\s*"([^"\n]{0,200})"/g;
const ATTR_VALUE_SQ_RE = /\b([a-z][a-zA-Z0-9_-]{1,30})\s*=\s*'([^'\n]{0,200})'/g;
// Labeled mention: "the X attribute"
const LABELED_RE = /\b(?:the\s+)?([a-z][a-zA-Z0-9_-]{1,30})\s+attribute\b/g;
// aria-*, data-* references
const ARIA_DATA_RE = /\b((?:aria|data)-[a-z][a-zA-Z0-9_-]{0,30})\b/g;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipValue(s) {
  const t = String(s || '').trim();
  if (t.length <= MAX_VALUE_LEN) return t;
  return `${t.slice(0, MAX_VALUE_LEN - 1)}…`;
}

function isLikelyHtmlAttr(name) {
  if (!name) return false;
  if (COMMON_ATTRS.has(name)) return true;
  if (/^(aria|data)-/.test(name)) return true;
  if (/^on[a-z]+$/.test(name)) return true; // event handlers
  return false;
}

function emptyTotals() {
  return { 'with-value': 0, labeled: 0, 'aria-data': 0 };
}

function extractHtmlAttrs(input) {
  const text = safeText(input);
  if (!text) return { attrs: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const attrs = [];
  const seen = new Set();
  const totals = emptyTotals();

  function add(name, value, kind) {
    if (attrs.length >= MAX_PER_FILE) return;
    if (!isLikelyHtmlAttr(name)) return;
    const v = value ? clipValue(value) : null;
    const key = `${name}|${v || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    attrs.push({ name, value: v, kind });
    totals[kind] += 1;
  }

  for (const m of head.matchAll(ATTR_VALUE_RE)) add(m[1], m[2], 'with-value');
  for (const m of head.matchAll(ATTR_VALUE_SQ_RE)) add(m[1], m[2], 'with-value');
  for (const m of head.matchAll(LABELED_RE)) add(m[1], null, 'labeled');
  for (const m of head.matchAll(ARIA_DATA_RE)) add(m[1], null, 'aria-data');

  return { attrs, total: attrs.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildHtmlAttrsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractHtmlAttrs(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, attrs: r.attrs, totals: r.totals });
    aggregate = aggregate.concat(r.attrs.map((a) => ({ ...a, file: name })));
    for (const k of Object.keys(totals)) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderAttr(a, opts = {}) {
  const file = opts.includeFile && a.file ? ` _(${a.file})_` : '';
  const v = a.value ? `="${a.value}"` : '';
  return `- [${a.kind}] \`${a.name}${v}\`${file}`;
}

function renderHtmlAttrsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## HTML ATTRIBUTES
HTML attributes referenced in the document(s): inline forms (\`rel="noopener"\`, \`target="_blank"\`), labeled mentions ("the rel attribute"), and aria-* / data-* references. Filtered by a curated whitelist of ~60 standard HTML attributes plus aria-* / data-* / on* event handlers. Routes "what HTML attributes are used?" to a citeable list.

**Totals:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const a of only.attrs) sections.push(renderAttr(a));
  } else {
    sections.push('### Aggregate HTML attrs across all files');
    for (const a of report.aggregate) sections.push(renderAttr(a, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const a of p.attrs) sections.push(renderAttr(a));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...HTML attrs block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractHtmlAttrs,
  buildHtmlAttrsForFiles,
  renderHtmlAttrsBlock,
  _internal: {
    ATTR_VALUE_RE,
    ATTR_VALUE_SQ_RE,
    LABELED_RE,
    ARIA_DATA_RE,
    COMMON_ATTRS,
    isLikelyHtmlAttr,
  },
};

'use strict';

/**
 * document-mjml.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects MJML (Mailjet Markup Language) email template constructs:
 *
 *   - Layout:        <mjml> / <mj-body> / <mj-section> / <mj-column> / <mj-group>
 *   - Components:    <mj-text> / <mj-button> / <mj-image> / <mj-divider> /
 *                    <mj-spacer> / <mj-table> / <mj-raw> / <mj-navbar>
 *   - Head:          <mj-head> / <mj-style> / <mj-font> / <mj-attributes> /
 *                    <mj-preview> / <mj-title> / <mj-breakpoint>
 *   - Social:        <mj-social> / <mj-social-element>
 *   - Common attrs:  background-color, color, font-size, padding, align, href
 *
 * Public API:
 *   extractMjml(text)             → { entries, totals, total }
 *   buildMjmlForFiles(files)      → { perFile, aggregate, totals }
 *   renderMjmlBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;

const MJML_TAG_RE = /<(mjml|mj-[a-z][a-z0-9-]{0,40})\b/g;
const HREF_RE = /\bhref\s*=\s*["']([^"'\n]{1,200})["']/g;
const SRC_RE = /<mj-image\b[^>]*\bsrc\s*=\s*["']([^"'\n]{1,200})["']/g;
const STYLE_ATTR_RE = /\b(background-color|color|font-size|font-family|padding|margin|width|height|align|font-weight|text-align|border-radius|line-height)\s*=\s*["']([^"'\n]{1,80})["']/g;
const FONT_RE = /<mj-font\b[^>]*\bname\s*=\s*["']([^"'\n]{1,60})["']/g;
const PREVIEW_RE = /<mj-preview\b[^>]*>([^<\n]{1,200})<\/mj-preview>/g;
const STYLE_BLOCK_RE = /<mj-style\b[^>]*>/g;

const LAYOUT_TAGS = new Set(['mj-section', 'mj-column', 'mj-group', 'mj-wrapper', 'mj-body']);
const COMPONENT_TAGS = new Set(['mj-text', 'mj-button', 'mj-image', 'mj-divider', 'mj-spacer', 'mj-table', 'mj-raw', 'mj-navbar', 'mj-navbar-link', 'mj-carousel', 'mj-accordion', 'mj-hero']);
const HEAD_TAGS = new Set(['mj-head', 'mj-style', 'mj-font', 'mj-attributes', 'mj-preview', 'mj-title', 'mj-breakpoint', 'mj-include', 'mj-html-attributes']);
const SOCIAL_TAGS = new Set(['mj-social', 'mj-social-element']);

function classifyTag(tag) {
  if (LAYOUT_TAGS.has(tag)) return 'layout';
  if (COMPONENT_TAGS.has(tag)) return 'component';
  if (HEAD_TAGS.has(tag)) return 'head';
  if (SOCIAL_TAGS.has(tag)) return 'social';
  if (tag === 'mjml') return 'root';
  return 'other';
}

function isMjmlLike(body) {
  return /<mjml\b|<mj-body\b|<mj-section\b|<mj-column\b/.test(body);
}

function extractMjml(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isMjmlLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    root: 0, layout: 0, component: 0, head: 0, social: 0, other: 0,
    href: 0, image: 0, font: 0, preview: 0, styleBlock: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  MJML_TAG_RE.lastIndex = 0;
  let m;
  while ((m = MJML_TAG_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const tag = m[1];
    const cat = classifyTag(tag);
    push(cat, tag, null);
  }
  if (entries.length < MAX_PER_FILE) {
    HREF_RE.lastIndex = 0;
    while ((m = HREF_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('href', m[1].slice(0, 80), null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    SRC_RE.lastIndex = 0;
    while ((m = SRC_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('image', m[1].slice(0, 80), null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    FONT_RE.lastIndex = 0;
    while ((m = FONT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('font', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    PREVIEW_RE.lastIndex = 0;
    while ((m = PREVIEW_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('preview', m[1].trim().slice(0, 80), null);
    }
  }

  let styleCount = 0;
  STYLE_BLOCK_RE.lastIndex = 0;
  while (STYLE_BLOCK_RE.exec(body) && styleCount < 10) styleCount += 1;
  totals.styleBlock = styleCount;

  return { entries, totals, total: entries.length };
}

function buildMjmlForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    root: 0, layout: 0, component: 0, head: 0, social: 0, other: 0,
    href: 0, image: 0, font: 0, preview: 0, styleBlock: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractMjml(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}`;
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

function renderMjmlBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## MJML EMAIL TEMPLATE'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      lines.push(`- [${e.kind}] \`${e.name}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractMjml,
  buildMjmlForFiles,
  renderMjmlBlock,
  _internal: { classifyTag, isMjmlLike, LAYOUT_TAGS, COMPONENT_TAGS, HEAD_TAGS, SOCIAL_TAGS },
};

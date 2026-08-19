'use strict';

/**
 * document-toc.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects table-of-contents sections in long documents — separate from
 * document-outline (which generates an outline from headings) and from
 * document-section-labels (which captures cross-references):
 *
 *   - "Table of Contents" / "TOC" / "Índice" / "Contents" header followed
 *     by indented or numbered list items
 *   - Detects depth via leading indentation count
 *   - Captures up to N entries per file
 *
 * Routes "what's in this doc?" / "show me the TOC" to a citeable list.
 *
 * Public API:
 *   extractToc(text)          → TocReport
 *   buildTocForFiles(files)   → { perFile, aggregate, totals }
 *   renderTocBlock(report)    → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_ITEMS_PER_TOC = 24;
const MAX_AGGREGATE = 20;
const MAX_BLOCK_CHARS = 5000;
const MAX_ITEM_LEN = 120;

const TOC_HEADER_RE = /(?:^|\n)\s*#{1,6}\s+(?:Table\s+of\s+Contents|Contents|TOC|[ÍI]ndice|Tabla\s+de\s+contenido(?:s)?|Sumario)\s*$/im;
const ITEM_RE = /^([\t ]*)(?:[-*+]|\d+[.)])\s+([^\n]{2,160})$/gm;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipItem(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_ITEM_LEN) return t;
  return `${t.slice(0, MAX_ITEM_LEN - 1)}…`;
}

function extractToc(input) {
  const text = safeText(input);
  if (!text) return { items: [], total: 0, found: false, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const headerMatch = TOC_HEADER_RE.exec(head);
  if (!headerMatch) return { items: [], total: 0, found: false, truncated: text.length > SCAN_HEAD_BYTES };
  const startIdx = headerMatch.index + headerMatch[0].length;
  // Take up to 5000 chars after the header to scan for items
  const tail = head.slice(startIdx, startIdx + 5000);
  const items = [];
  for (const m of tail.matchAll(ITEM_RE)) {
    if (items.length >= MAX_ITEMS_PER_TOC) break;
    const indent = (m[1] || '').length;
    const depth = Math.min(Math.floor(indent / 2), 5);
    const text = clipItem(m[2]);
    if (!text) continue;
    // Stop when we hit a next heading (line starts with #)
    if (text.startsWith('#')) break;
    items.push({ depth, text });
  }
  return { items, total: items.length, found: true, truncated: head.length > SCAN_HEAD_BYTES };
}

function buildTocForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  let foundCount = 0;
  for (const f of list) {
    const r = extractToc(safeText(f.extractedText));
    if (!r.found) continue;
    foundCount += 1;
    const name = safeFileName(f);
    perFile.push({ file: name, items: r.items });
    aggregate = aggregate.concat(r.items.map((i) => ({ ...i, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals: { tocs: foundCount } };
}

function renderItem(i, opts = {}) {
  const file = opts.includeFile && i.file ? ` _(${i.file})_` : '';
  const indent = '  '.repeat(i.depth || 0);
  return `${indent}- ${i.text}${file}`;
}

function renderTocBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## TABLE OF CONTENTS
Explicit Table-of-Contents sections detected in the document(s) — sections under "Table of Contents", "Contents", "TOC", "Índice", "Tabla de contenidos", "Sumario" headers followed by indented or numbered items. Items capture depth via leading indentation. Different from document-outline (which generates outline from headings) and document-section-labels (cross-refs). Routes "what's in this doc?" / "show me the TOC" to a citeable list.

**Total TOCs:** ${report.totals?.tocs || 0}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const i of only.items) sections.push(renderItem(i));
  } else {
    sections.push('### Aggregate TOC items across all files');
    for (const i of report.aggregate) sections.push(renderItem(i, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const i of p.items) sections.push(renderItem(i));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...TOC block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractToc,
  buildTocForFiles,
  renderTocBlock,
  _internal: {
    TOC_HEADER_RE,
    ITEM_RE,
  },
};

'use strict';

/**
 * document-definition-lists.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects definition-list structures in tech docs / configs / RFCs:
 *
 *   - Markdown definition list (PHP Markdown Extra):
 *     Term
 *     :   Definition
 *   - Term: Definition pattern on same line (compact form, distinct from
 *     ownership/status labels by requiring multi-paragraph context)
 *   - HTML <dl><dt><dd> textual mention
 *
 * Different from document-glossary-extractor (curated glossary terms)
 * by surfacing arbitrary term/definition pairs in any section.
 * Routes "what does X mean?" / "definition of X" to a citeable list.
 *
 * Public API:
 *   extractDefinitionLists(text)         → DefListReport
 *   buildDefinitionListsForFiles(files)  → { perFile, aggregate, totals }
 *   renderDefinitionListsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 5000;
const MAX_TERM_LEN = 60;
const MAX_DEF_LEN = 200;

// Markdown definition list: term on line, colon-prefixed definition on next
const MD_DL_RE = /(?:^|\n)([A-Z][A-Za-zÀ-ÿ0-9 .\-]{1,60})\n[\t ]*:[\t ]+([^\n]{4,200})/g;
// HTML-style dt / dd references (semantic mention)
const HTML_DL_RE = /<dt>([^<\n]{1,80})<\/dt>\s*<dd>([^<\n]{1,200})<\/dd>/g;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipTerm(s) {
  const t = String(s || '').trim();
  if (t.length <= MAX_TERM_LEN) return t;
  return `${t.slice(0, MAX_TERM_LEN - 1)}…`;
}

function clipDef(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_DEF_LEN) return t;
  return `${t.slice(0, MAX_DEF_LEN - 1)}…`;
}

function isLikelyTerm(s) {
  if (!s) return false;
  const t = s.trim();
  // Reject if looks like a sentence (ends with period or contains common words)
  if (/[.!?]$/.test(t)) return false;
  if (/\b(the|a|an|is|are|was|were|will|shall|must|should)\b/i.test(t)) return false;
  return /^[A-Z]/.test(t);
}

function extractDefinitionLists(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: { md: 0, html: 0 }, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = { md: 0, html: 0 };

  function add(term, definition, kind) {
    if (entries.length >= MAX_PER_FILE) return;
    const t = clipTerm(term);
    const d = clipDef(definition);
    if (!t || !d) return;
    if (!isLikelyTerm(t)) return;
    const key = `${t.toLowerCase()}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ term: t, definition: d, kind });
    totals[kind] += 1;
  }

  for (const m of head.matchAll(MD_DL_RE)) add(m[1], m[2], 'md');
  for (const m of head.matchAll(HTML_DL_RE)) add(m[1], m[2], 'html');

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildDefinitionListsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = { md: 0, html: 0 };
  for (const f of list) {
    const r = extractDefinitionLists(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    totals.md += r.totals.md;
    totals.html += r.totals.html;
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- **${e.term}**${file}: ${e.definition}`;
}

function renderDefinitionListsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || { md: 0, html: 0 };
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## DEFINITION LISTS
Term/definition pairs detected in the document(s): Markdown definition lists (PHP Markdown Extra syntax — term on one line, colon-prefixed definition on next) and HTML \`<dl><dt><dd>\` mentions. Different from document-glossary-extractor (curated glossary entries) by surfacing arbitrary term/definition pairs in any section. Routes "what does X mean?" / "definition of X" to a citeable list.

**Totals:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate definitions across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...definition lists block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractDefinitionLists,
  buildDefinitionListsForFiles,
  renderDefinitionListsBlock,
  _internal: {
    MD_DL_RE,
    HTML_DL_RE,
    isLikelyTerm,
  },
};

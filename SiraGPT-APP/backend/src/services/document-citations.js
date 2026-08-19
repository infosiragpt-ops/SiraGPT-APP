'use strict';

/**
 * document-citations.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects academic citation patterns:
 *
 *   - Bracketed numeric: [1], [12], [3,4,5]
 *   - Bracketed author-year: [Smith2020], [Smith et al. 2020]
 *   - Parenthetical author-year: (Smith, 2020), (Smith and Doe, 2020),
 *     (Smith et al., 2020)
 *   - "et al." in-text
 *   - References section detection (header)
 *
 * Different from document-quote-extractor (quoted text), document-
 * footnotes (numbered notes under References section), and document-
 * cross-reference (table/figure refs). Routes "what references are
 * cited?", "is this peer-reviewed?" to a citeable inventory.
 *
 * Public API:
 *   extractCitations(text)         → CitationReport
 *   buildCitationsForFiles(files)  → { perFile, aggregate, totals }
 *   renderCitationsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_KIND = 12;
const MAX_PER_FILE = 30;
const MAX_AGGREGATE = 36;
const MAX_BLOCK_CHARS = 5500;
const MAX_VALUE_LEN = 100;

// [1], [12], [3,4,5], [10-12]
const NUMERIC_RE = /\[(\d+(?:\s*[,\-–—]\s*\d+)*)\]/g;
// [Smith2020], [SmithEtAl2020], [Smith et al. 2020]
const BRACKET_AUTHOR_RE = /\[([A-Z][a-zA-Z]{1,30}(?:\s+et\s+al\.?)?\s*\d{4})\]/g;
// (Smith, 2020), (Smith and Doe, 2020), (Smith et al., 2020)
const PAREN_AUTHOR_RE = /\(([A-Z][a-zA-Z]{1,30}(?:\s+et\s+al\.?|\s+(?:and|y)\s+[A-Z][a-zA-Z]{1,30})?,\s*\d{4})\)/g;
// Author et al. (free in-text)
const ETAL_INLINE_RE = /\b([A-Z][a-zA-Z]{1,30}\s+et\s+al\.?)(?:\s+\(?(\d{4})\)?)?/g;
// References section header
const REFERENCES_HEADER_RE = /(?:^|\n)\s*#{1,6}\s+(?:References|Bibliography|Bibliograf[íi]a|Referencias|Works\s+Cited)\s*$/im;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipValue(v) {
  const s = String(v || '').trim();
  if (s.length <= MAX_VALUE_LEN) return s;
  return `${s.slice(0, MAX_VALUE_LEN - 1)}…`;
}

function emptyTotals() {
  return { numeric: 0, bracketAuthor: 0, parenAuthor: 0, etalInline: 0 };
}

function extractCitations(input) {
  const text = safeText(input);
  if (!text) return { citations: [], total: 0, totals: emptyTotals(), hasReferencesSection: false, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const citations = [];
  const seen = new Set();
  const totals = emptyTotals();

  function add(kind, value) {
    if (citations.length >= MAX_PER_FILE) return;
    if (totals[kind] >= MAX_PER_KIND) return;
    const v = clipValue(value);
    if (!v) return;
    const key = `${kind}|${v.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    citations.push({ kind, value: v });
    totals[kind] += 1;
  }

  for (const m of head.matchAll(NUMERIC_RE)) add('numeric', `[${m[1]}]`);
  for (const m of head.matchAll(BRACKET_AUTHOR_RE)) add('bracketAuthor', `[${m[1]}]`);
  for (const m of head.matchAll(PAREN_AUTHOR_RE)) add('parenAuthor', `(${m[1]})`);
  for (const m of head.matchAll(ETAL_INLINE_RE)) {
    const value = m[2] ? `${m[1]} (${m[2]})` : m[1];
    add('etalInline', value);
  }

  const hasReferencesSection = REFERENCES_HEADER_RE.test(head);
  return { citations, total: citations.length, totals, hasReferencesSection, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildCitationsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  let referenceFiles = 0;
  for (const f of list) {
    const r = extractCitations(safeText(f.extractedText));
    if (r.total === 0 && !r.hasReferencesSection) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, citations: r.citations, totals: r.totals, hasReferencesSection: r.hasReferencesSection });
    aggregate = aggregate.concat(r.citations.map((c) => ({ ...c, file: name })));
    for (const k of Object.keys(totals)) totals[k] += r.totals[k];
    if (r.hasReferencesSection) referenceFiles += 1;
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals, referenceFiles };
}

function renderCitation(c, opts = {}) {
  const file = opts.includeFile && c.file ? ` _(${c.file})_` : '';
  return `- [${c.kind}] \`${c.value}\`${file}`;
}

function renderCitationsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const refsNote = report.referenceFiles ? ` Document contains a References/Bibliography section (count=${report.referenceFiles}).` : '';
  const heading = `## ACADEMIC CITATIONS
Citation patterns detected in the document(s): numeric ([1], [3,4,5]), bracketed author-year ([Smith2020]), parenthetical author-year ((Smith, 2020), (Smith et al., 2020)), and in-text "Author et al." mentions. Also flags presence of a References/Bibliography/Bibliografía/Referencias header. Different from quotes, footnotes, and cross-references. Routes "what references are cited?" / "is this peer-reviewed?" to a citeable inventory.

**Totals:** ${breakdown || '(none)'}.${refsNote}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const c of only.citations) sections.push(renderCitation(c));
  } else {
    sections.push('### Aggregate citations across all files');
    for (const c of report.aggregate) sections.push(renderCitation(c, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const c of p.citations) sections.push(renderCitation(c));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...citations block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractCitations,
  buildCitationsForFiles,
  renderCitationsBlock,
  _internal: {
    NUMERIC_RE,
    BRACKET_AUTHOR_RE,
    PAREN_AUTHOR_RE,
    ETAL_INLINE_RE,
    REFERENCES_HEADER_RE,
  },
};

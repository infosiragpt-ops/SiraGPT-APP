'use strict';

/**
 * document-legal-citations.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects legal case citations in legal / court / academic / contract text:
 *
 *   - Case names: "Smith v. Jones", "Brown v. Board of Education", italic too
 *   - Bluebook full: "Smith v. Jones, 123 U.S. 456 (1954)"
 *   - Reporter-only: "123 U.S. 456", "412 F.2d 850"
 *   - Statute refs: "42 U.S.C. § 1983", "Ley 19/2013"
 *
 * Different from academic citations (Author/Year) by tagging legal-domain
 * patterns. Routes "what cases?" / "what statute?" to a citeable list.
 *
 * Public API:
 *   extractLegalCitations(text)         → LegalCitReport
 *   buildLegalCitationsForFiles(files)  → { perFile, aggregate, totals }
 *   renderLegalCitationsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 5000;
const MAX_VALUE_LEN = 160;

const PATTERNS = [
  // Case name: "Name v. Other" or "Name v Other" (English / Spanish)
  { kind: 'case-name', re: /\b([A-Z][A-Za-z'`\-]{1,40}(?:\s+[A-Z][A-Za-z'`\-]{1,40}){0,3})\s+v\.?\s+([A-Z][A-Za-z'`\-]{1,40}(?:\s+[A-Z][A-Za-z'`\-]{1,40}){0,4})/g },
  // Reporter citation: "123 U.S. 456" / "412 F.2d 850" / "100 F. Supp. 200"
  { kind: 'reporter', re: /\b(\d{1,4})\s+(U\.S\.?|F\.(?:\s?\d[a-z]?)?|F\.?\s?Supp\.?|S\.\s?Ct\.?|L\.\s?Ed\.?|N\.E\.\d?d?|N\.W\.\d?d?|S\.W\.\d?d?|A\.\d?d?|P\.\d?d?)\s+(\d{1,5})/g },
  // US Code: "42 U.S.C. § 1983"
  { kind: 'us-code', re: /\b(\d{1,3})\s+U\.?S\.?C\.?\s+§+\s*(\d{1,6})(?:\([a-z0-9]+\))?/g },
  // CFR: "29 C.F.R. § 1604"
  { kind: 'cfr', re: /\b(\d{1,3})\s+C\.?F\.?R\.?\s+§+\s*(\d{1,6})/g },
  // Spanish statute: "Ley 19/2013" / "Real Decreto 123/2020"
  { kind: 'es-statute', re: /\b(?:Ley|Real\s+Decreto|Decreto|Reglamento)\s+\d{1,4}\/\d{4}/gi },
];

const KINDS = PATTERNS.map((p) => p.kind);

const COMMON_NON_CASE_PAIRS = new Set([
  'David v. Goliath', 'Man v. Machine',
]);

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

function extractLegalCitations(input) {
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
      const value = clipValue(m[0]);
      if (kind === 'case-name' && COMMON_NON_CASE_PAIRS.has(value)) continue;
      const key = `${kind}|${value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind, value });
      totals[kind] += 1;
    }
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildLegalCitationsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractLegalCitations(safeText(f.extractedText));
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

function renderLegalCitationsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## LEGAL CITATIONS
Legal case citations and statute references detected: case names (Smith v. Jones), reporter citations (123 U.S. 456 / 412 F.2d 850), US Code (42 U.S.C. § 1983), CFR (29 C.F.R. § 1604), Spanish statutes (Ley 19/2013, Real Decreto 123/2020). Different from academic citations by tagging legal-domain patterns. Routes "what cases?" / "what statute?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate legal citations across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...legal citations block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractLegalCitations,
  buildLegalCitationsForFiles,
  renderLegalCitationsBlock,
  _internal: {
    PATTERNS,
    KINDS,
  },
};

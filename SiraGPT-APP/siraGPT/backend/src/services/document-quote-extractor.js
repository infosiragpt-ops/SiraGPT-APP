'use strict';

/**
 * document-quote-extractor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pulls direct quotes and bibliographic citations out of attached docs.
 *
 * What counts as a "quote":
 *   - Straight double quotes:    "Lorem ipsum"
 *   - Smart double quotes:       “Lorem ipsum”
 *   - Spanish angle quotes:      «Lorem ipsum»
 *   - Single smart quotes:       ‘Lorem ipsum’           (only when ≥ 4 words to
 *                                                         avoid false hits on
 *                                                         contractions)
 *   - Block quote prefix:        > Lorem ipsum…
 *
 * What counts as a "citation":
 *   - Parenthetical author-year:  (Smith 2020), (García y Pérez, 2021)
 *   - Bracketed numeric:          [1], [12], [Smith20]
 *   - "et al." attributions:      Smith et al. (2020)
 *   - Footnote markers:           [^1], ¹ ² ³ ⁴ ⁵ (superscript digits)
 *
 * Why this exists (and why it is not part of document-claim-attribution):
 *   Attribution links *claims* to *entities*. Quote extraction surfaces
 *   *literal language* the user can copy/cite verbatim. They overlap
 *   conceptually but consume different signals (orthography vs. syntax)
 *   and have different downstream uses — quotes power "show me what it
 *   says about X" verbatim answers; attribution powers "who said it."
 *
 * Bilingual (Spanish / English). Deterministic. No LLM. < 10 ms on 1 MB.
 *
 * Public API:
 *   extractQuotes(text, opts)              → QuoteReport
 *   buildQuotesForFiles(files)             → { perFile, aggregate }
 *   renderQuotesBlock(batchReport)         → markdown string ('' when empty)
 */

const MAX_QUOTES_PER_FILE = 8;
const MAX_CITATIONS_PER_FILE = 12;
const MIN_QUOTE_LEN = 6;            // chars
const MAX_QUOTE_LEN = 320;          // chars, before truncation marker
const MAX_BLOCK_CHARS = 4000;

// Regex set. We MUST NOT use the global flag with `match()` to keep the
// capture groups; we run them iteratively with `matchAll`.
const QUOTE_PATTERNS = [
  { kind: 'double-straight', re: /"([^"\n]{6,1200})"/g },
  { kind: 'double-smart',    re: /[“]([^“”\n]{6,1200})[”]/g },
  { kind: 'angle-spanish',   re: /[«]([^«»\n]{6,1200})[»]/g },
  { kind: 'single-smart',    re: /[‘]([^‘’\n]{12,1200})[’]/g },
];

const BLOCK_QUOTE_RE = /(?:^|\n)>\s+([^\n]{6,1200})/g;

const CITATION_PATTERNS = [
  { kind: 'parenthetical-author-year', re: /\(([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ.-]+(?:\s+(?:y|and|&|et al\.?))?(?:\s+[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ.-]+)*?),?\s+(\d{4}[a-z]?)\)/g },
  { kind: 'bracketed-numeric',          re: /\[(\d{1,3})\]/g },
  { kind: 'bracketed-key',              re: /\[([A-Z][A-Za-z]+\d{2,4})\]/g },
  { kind: 'inline-et-al',               re: /([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ.-]+)\s+et al\.?\s*\(?(\d{4})\)?/g },
  { kind: 'footnote-marker',            re: /\[\^(\d+|[a-zA-Z][\w-]*)\]/g },
];

const SUPERSCRIPT_FOOTNOTE_RE = /(?<=\w)([¹²³⁰-⁹]+)/g;

function safeStr(v) {
  return typeof v === 'string' ? v : '';
}

function truncate(s, max) {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function dedupe(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function extractQuotesFromPatterns(text) {
  const out = [];
  for (const { kind, re } of QUOTE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const inner = m[1].trim();
      if (inner.length < MIN_QUOTE_LEN) continue;
      out.push({ kind, text: inner, raw: m[0], index: m.index ?? 0 });
    }
  }
  for (const m of text.matchAll(BLOCK_QUOTE_RE)) {
    const inner = m[1].trim();
    if (inner.length < MIN_QUOTE_LEN) continue;
    out.push({ kind: 'block-quote', text: inner, raw: m[0], index: m.index ?? 0 });
  }
  return out;
}

function extractCitations(text) {
  const out = [];
  for (const { kind, re } of CITATION_PATTERNS) {
    for (const m of text.matchAll(re)) {
      out.push({
        kind,
        raw: m[0],
        author: m[1] || null,
        year: m[2] || null,
        index: m.index ?? 0,
      });
    }
  }
  for (const m of text.matchAll(SUPERSCRIPT_FOOTNOTE_RE)) {
    out.push({
      kind: 'superscript-footnote',
      raw: m[0],
      author: null,
      year: null,
      index: m.index ?? 0,
    });
  }
  return out;
}

/**
 * @param {string} text
 * @param {{ maxQuotes?: number, maxCitations?: number }} [opts]
 */
function extractQuotes(text, opts = {}) {
  const empty = {
    quotes: [], citations: [],
    totals: { quotes: 0, citations: 0 },
  };
  const raw = safeStr(text);
  if (!raw) return empty;

  const allQuotes = extractQuotesFromPatterns(raw);
  const allCitations = extractCitations(raw);

  // Sort by document position so the rendering follows reading order.
  allQuotes.sort((a, b) => a.index - b.index);
  allCitations.sort((a, b) => a.index - b.index);

  const quotes = dedupe(
    allQuotes.map((q) => ({ ...q, text: truncate(q.text, MAX_QUOTE_LEN) })),
    (q) => q.text.toLowerCase().slice(0, 80),
  ).slice(0, Math.max(1, opts.maxQuotes || MAX_QUOTES_PER_FILE));

  const citations = dedupe(
    allCitations,
    (c) => `${c.kind}|${(c.author || '').toLowerCase()}|${c.year || ''}|${c.raw}`,
  ).slice(0, Math.max(1, opts.maxCitations || MAX_CITATIONS_PER_FILE));

  return {
    quotes,
    citations,
    totals: { quotes: allQuotes.length, citations: allCitations.length },
  };
}

/**
 * @param {Array<{ originalName?: string, filename?: string, name?: string, extractedText?: string, text?: string }>} files
 */
function buildQuotesForFiles(files) {
  const list = Array.isArray(files) ? files.filter((f) => f && typeof f === 'object') : [];
  const perFile = [];
  const aggregate = {
    quotes: [], citations: [],
    totals: { quotes: 0, citations: 0 },
  };
  for (const f of list) {
    const text = safeStr(f.extractedText || f.text);
    if (!text) continue;
    const report = extractQuotes(text);
    if (report.quotes.length === 0 && report.citations.length === 0) continue;
    const label = f.originalName || f.filename || f.name || 'archivo';
    perFile.push({ file: label, report });
    aggregate.quotes = aggregate.quotes.concat(report.quotes);
    aggregate.citations = aggregate.citations.concat(report.citations);
    aggregate.totals.quotes += report.totals.quotes;
    aggregate.totals.citations += report.totals.citations;
  }
  // Dedupe + cap aggregate so multi-file uploads with repeated boilerplate
  // (e.g. shared bibliography across PDFs) don't blow up the block.
  aggregate.quotes = dedupe(aggregate.quotes, (q) => q.text.toLowerCase().slice(0, 80))
    .slice(0, MAX_QUOTES_PER_FILE);
  aggregate.citations = dedupe(
    aggregate.citations,
    (c) => `${c.kind}|${(c.author || '').toLowerCase()}|${c.year || ''}|${c.raw}`,
  ).slice(0, MAX_CITATIONS_PER_FILE);
  return { perFile, aggregate };
}

function renderQuotes(report) {
  const lines = [];
  if (report.quotes && report.quotes.length > 0) {
    lines.push('**Direct quotes** _(verbatim — safe to cite when context confirms relevance)_');
    for (const q of report.quotes) {
      lines.push(`- “${q.text}”`);
    }
  }
  if (report.citations && report.citations.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('**Inline citations** _(bibliographic markers — verify against the document\'s reference list)_');
    for (const c of report.citations) {
      const tag = c.author && c.year ? `${c.author} ${c.year}` : c.raw;
      lines.push(`- \`${tag}\` _(${c.kind})_`);
    }
  }
  return lines.join('\n');
}

/**
 * @param {ReturnType<typeof buildQuotesForFiles>} batchReport
 */
function renderQuotesBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) {
    return '';
  }
  const heading = `## QUOTES & CITATIONS
Verbatim language and bibliographic markers pulled from the attached document(s). Use quotes when the user asks "what does it literally say about…"; use citations when the user asks for references or wants to trace a claim back to its source. Both lists preserve reading order within each file.`;

  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    const body = renderQuotes(only.report);
    if (body) {
      sections.push(`### File: ${only.file}`);
      sections.push(body);
    }
  } else {
    const agg = renderQuotes(batchReport.aggregate);
    if (agg) {
      sections.push('### Aggregate across all files');
      sections.push(agg);
    }
    for (const p of batchReport.perFile) {
      const body = renderQuotes(p.report);
      if (!body) continue;
      sections.push(`### File: ${p.file}`);
      sections.push(body);
    }
  }
  if (sections.length === 0) return '';
  let combined = `${heading}\n\n${sections.join('\n\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...quotes & citations block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractQuotes,
  buildQuotesForFiles,
  renderQuotesBlock,
  _internal: {
    QUOTE_PATTERNS,
    CITATION_PATTERNS,
    BLOCK_QUOTE_RE,
    SUPERSCRIPT_FOOTNOTE_RE,
    MAX_QUOTES_PER_FILE,
    MAX_CITATIONS_PER_FILE,
    MAX_BLOCK_CHARS,
    dedupe,
    truncate,
  },
};

'use strict';

/**
 * document-blockquotes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects markdown blockquotes and pull-quote indicators:
 *
 *   - Markdown blockquote: lines starting with "> "
 *   - Multi-line blockquotes grouped together
 *   - "— Author" attribution at end of blockquote (em-dash + name)
 *   - Pull-quote markers in some doc styles
 *
 * Different from document-quote-extractor (in-line "" quotes) by
 * focusing on block-level quoted content with structure. Routes
 * "what's the quote?" / "any pull quotes?" to a citeable list.
 *
 * Public API:
 *   extractBlockquotes(text)          → BlockquoteReport
 *   buildBlockquotesForFiles(files)   → { perFile, aggregate, totals }
 *   renderBlockquotesBlock(report)    → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 12;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 5000;
const MAX_TEXT_LEN = 280;

const BLOCKQUOTE_RE = /(?:^|\n)((?:>\s.*(?:\n>\s.*)*)+)(?=\n[^>]|\n*$)/g;
const ATTRIB_RE = /^[—–\-]{1,2}\s*([A-Z][A-Za-zÀ-ÿ ,.'\-]{1,80})$/m;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipText(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_TEXT_LEN) return t;
  return `${t.slice(0, MAX_TEXT_LEN - 1)}…`;
}

function extractBlockquotes(input) {
  const text = safeText(input);
  if (!text) return { quotes: [], total: 0, totals: { quote: 0, withAttribution: 0 }, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const quotes = [];
  const seen = new Set();
  let withAttribution = 0;

  for (const m of head.matchAll(BLOCKQUOTE_RE)) {
    if (quotes.length >= MAX_PER_FILE) break;
    const body = m[1]
      .split('\n')
      .map((l) => l.replace(/^>\s?/, ''))
      .join('\n')
      .trim();
    if (!body || body.length < 8) continue;
    const attribMatch = ATTRIB_RE.exec(body);
    const attribution = attribMatch ? attribMatch[1].trim() : null;
    const text = attribution ? body.slice(0, attribMatch.index).trim() : body;
    const clip = clipText(text);
    const key = clip.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    quotes.push({ text: clip, attribution });
    if (attribution) withAttribution += 1;
  }

  return { quotes, total: quotes.length, totals: { quote: quotes.length, withAttribution }, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildBlockquotesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = { quote: 0, withAttribution: 0 };
  for (const f of list) {
    const r = extractBlockquotes(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, quotes: r.quotes, totals: r.totals });
    aggregate = aggregate.concat(r.quotes.map((q) => ({ ...q, file: name })));
    totals.quote += r.totals.quote;
    totals.withAttribution += r.totals.withAttribution;
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderQuote(q, opts = {}) {
  const file = opts.includeFile && q.file ? ` _(${q.file})_` : '';
  const attrib = q.attribution ? ` — _${q.attribution}_` : '';
  return `> ${q.text}${attrib}${file}`;
}

function renderBlockquotesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || { quote: 0, withAttribution: 0 };
  const heading = `## BLOCKQUOTES
Markdown blockquotes detected in the document(s) — lines starting with \`> \`. Multi-line blockquotes are grouped. Trailing "— Author" attribution lines are extracted. Different from inline "..." quotes (document-quote-extractor) by focusing on block-level structured quoted content. Routes "what's the quote?" / "any pull quotes?" to a citeable list.

**Totals:** quote=${totals.quote}  withAttribution=${totals.withAttribution}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const q of only.quotes) sections.push(renderQuote(q));
  } else {
    sections.push('### Aggregate blockquotes across all files');
    for (const q of report.aggregate) sections.push(renderQuote(q, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const q of p.quotes) sections.push(renderQuote(q));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...blockquotes block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractBlockquotes,
  buildBlockquotesForFiles,
  renderBlockquotesBlock,
  _internal: {
    BLOCKQUOTE_RE,
    ATTRIB_RE,
  },
};

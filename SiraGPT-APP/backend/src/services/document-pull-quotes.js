'use strict';

/**
 * document-pull-quotes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects pull quotes / quotation attributions in text:
 *
 *   - "—" + name:        "Quote text" — Author Name
 *   - "--" + name:        "Quote text" -- Author Name
 *   - parenthetical:      "Quote." (Author, 2023)
 *   - markdown:           > Quote text
 *                         > — Author Name
 *   - "said X":           "Quote text," said Alice
 *
 * Public API:
 *   extractPullQuotes(text)             → { entries, totals, total }
 *   buildPullQuotesForFiles(files)      → { perFile, aggregate, totals }
 *   renderPullQuotesBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 4500;

// Quote followed by em-dash / -- / – then a name
const DASH_ATTRIB_RE = /["'"`""]([^"'""`\n]{2,300})["'"`""]\s*[—–-]{1,2}\s*([A-Z][A-Za-z][A-Za-zÀ-ÿ.\-' ]{1,60})(?:[,.]|$|\n)/g;
// Parenthetical academic-style: (Smith, 2023) or (Smith et al., 2023)
const PAREN_ATTRIB_RE = /["'"`""]([^"'""`\n]{2,300})["'"`""]\s*\(([A-Z][A-Za-z]{1,30}(?:\s+et\s+al\.?)?[,;]?\s+(?:19|20)\d{2})\)/g;
// said-X / X said
const SAID_RE = /["'"`""]([^"'""`\n]{2,300})["'"`""]\s*,?\s*(?:said|wrote|noted|observed|argued|claimed|stated|explained|added)\s+([A-Z][A-Za-z]{1,30}(?:\s+[A-Z][a-z]{1,30}){0,3})\b/gi;

function trimQuote(s) {
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

function extractPullQuotes(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { dash: 0, paren: 0, said: 0 };

  function push(kind, quote, author) {
    const trimmed = trimQuote(quote);
    const cleanAuthor = author.replace(/[.,;:]+$/, '').trim();
    const key = `${kind}:${trimmed}:${cleanAuthor}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, quote: trimmed, author: cleanAuthor });
    if (totals[kind] != null) totals[kind] += 1;
  }

  DASH_ATTRIB_RE.lastIndex = 0;
  let m;
  while ((m = DASH_ATTRIB_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('dash', m[1].trim(), m[2].trim());
  }

  if (entries.length < MAX_PER_FILE) {
    PAREN_ATTRIB_RE.lastIndex = 0;
    while ((m = PAREN_ATTRIB_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('paren', m[1].trim(), m[2].trim());
    }
  }

  if (entries.length < MAX_PER_FILE) {
    SAID_RE.lastIndex = 0;
    while ((m = SAID_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('said', m[1].trim(), m[2].trim());
    }
  }

  return { entries, totals, total: entries.length };
}

function buildPullQuotesForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { dash: 0, paren: 0, said: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractPullQuotes(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.author}:${e.quote.slice(0, 40)}`;
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

function renderPullQuotesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## PULL QUOTES & ATTRIBUTIONS'];
  const t = report.totals || {};
  const parts = [];
  if (t.dash) parts.push(`dash: ${t.dash}`);
  if (t.paren) parts.push(`parenthetical: ${t.paren}`);
  if (t.said) parts.push(`said-X: ${t.said}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 6)) {
      lines.push(`- "${e.quote}" — ${e.author} (${e.kind})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractPullQuotes,
  buildPullQuotesForFiles,
  renderPullQuotesBlock,
};

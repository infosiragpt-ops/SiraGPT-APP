'use strict';

/**
 * document-bibtex-entries.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects BibTeX / BibLaTeX bibliographic entries:
 *
 *   - @article{cite-key, ...}
 *   - @book{cite-key, ...}
 *   - @inproceedings{...}, @incollection{...}
 *   - @misc{}, @techreport{}, @phdthesis{}, @mastersthesis{}, @manual{}
 *   - @online{} / @software{} (BibLaTeX)
 *
 * Public API:
 *   extractBibtexEntries(text)             → { entries, totals, total }
 *   buildBibtexEntriesForFiles(files)      → { perFile, aggregate, totals }
 *   renderBibtexEntriesBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 100_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const ENTRY_RE = /@(article|book|inproceedings|incollection|inbook|conference|misc|techreport|phdthesis|mastersthesis|manual|proceedings|booklet|unpublished|online|software|webpage|patent|standard|preprint|electronic)\s*\{\s*([A-Za-z][A-Za-z0-9_:.\-]{0,80})\s*,/gi;
const FIELD_RE = /\b(title|author|year|journal|booktitle|publisher|doi|url|isbn)\s*=\s*[{"]([^}"\n]{2,200})[}"]/gi;

const CATEGORIES = {
  article: 'journal', book: 'book', inproceedings: 'conference', incollection: 'book',
  inbook: 'book', conference: 'conference', misc: 'misc', techreport: 'tech-report',
  phdthesis: 'thesis', mastersthesis: 'thesis', manual: 'manual', proceedings: 'conference',
  booklet: 'misc', unpublished: 'unpublished', online: 'online', software: 'software',
  webpage: 'online', patent: 'patent', standard: 'standard', preprint: 'preprint',
  electronic: 'online',
};

function extractBibtexEntries(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = {};

  ENTRY_RE.lastIndex = 0;
  let m;
  while ((m = ENTRY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const type = m[1].toLowerCase();
    const key = m[2];
    const category = CATEGORIES[type] || 'other';
    const seenKey = `${type}:${key}`;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);
    entries.push({ type, key, category });
    totals[category] = (totals[category] || 0) + 1;
  }

  return { entries, totals, total: entries.length };
}

function buildBibtexEntriesForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {};
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractBibtexEntries(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const sk = `${e.type}:${e.key}`;
      if (aggSeen.has(sk)) continue;
      aggSeen.add(sk);
      aggregate.push(e);
      totals[e.category] = (totals[e.category] || 0) + 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderBibtexEntriesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## BIBTEX BIBLIOGRAPHY ENTRIES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- @${e.type}{${e.key}} (${e.category})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractBibtexEntries,
  buildBibtexEntriesForFiles,
  renderBibtexEntriesBlock,
};

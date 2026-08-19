'use strict';

/**
 * document-doi-ids.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Digital Object Identifier (DOI) references:
 *
 *   - bare DOI:      10.xxxx/...
 *   - prefixed:      doi:10.xxxx/...
 *   - URL form:      https://doi.org/10.xxxx/...
 *   - dx.doi.org:    legacy resolver
 *   - handle.net:    10.x.x/123 Handle System IDs
 *
 * Public API:
 *   extractDoiIds(text)             → { entries, totals, total }
 *   buildDoiIdsForFiles(files)      → { perFile, aggregate, totals }
 *   renderDoiIdsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

// DOI: 10.{registrant}/{suffix} where registrant is 4-9 digits and suffix is any printable except whitespace
const DOI_RE = /\b10\.\d{4,9}\/[A-Za-z0-9.()\-_;:/]{3,80}/g;
const DOI_LABELED_RE = /\bdoi\s*[:=]\s*(10\.\d{4,9}\/[A-Za-z0-9.()\-_;:/]{3,80})/gi;
const DOI_URL_RE = /\bhttps?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,9}\/[A-Za-z0-9.()\-_;:/]{3,80})/gi;
const HANDLE_RE = /\bhdl\s*[:=]?\s*(10\.\d{1,4}\.[A-Za-z0-9.\-_/]{3,80})/gi;

function registrantOf(doi) {
  const m = /^10\.(\d{4,9})/.exec(doi);
  return m ? m[1] : null;
}

function extractDoiIds(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { bare: 0, labeled: 0, url: 0, handle: 0 };

  function push(kind, doi) {
    if (seen.has(doi)) return;
    seen.add(doi);
    entries.push({ kind, doi, registrant: registrantOf(doi) });
    if (totals[kind] != null) totals[kind] += 1;
  }

  DOI_URL_RE.lastIndex = 0;
  let m;
  while ((m = DOI_URL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('url', m[1]);
  }
  if (entries.length < MAX_PER_FILE) {
    DOI_LABELED_RE.lastIndex = 0;
    while ((m = DOI_LABELED_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('labeled', m[1]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    DOI_RE.lastIndex = 0;
    while ((m = DOI_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('bare', m[0]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    HANDLE_RE.lastIndex = 0;
    while ((m = HANDLE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('handle', m[1]);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildDoiIdsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { bare: 0, labeled: 0, url: 0, handle: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractDoiIds(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.doi)) continue;
      aggSeen.add(e.doi);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderDoiIdsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## DOI IDENTIFIERS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      const reg = e.registrant ? ` (registrant ${e.registrant})` : '';
      lines.push(`- ${e.kind}: \`${e.doi}\`${reg}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractDoiIds,
  buildDoiIdsForFiles,
  renderDoiIdsBlock,
  _internal: { registrantOf },
};

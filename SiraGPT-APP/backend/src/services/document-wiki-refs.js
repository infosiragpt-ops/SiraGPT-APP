'use strict';

/**
 * document-wiki-refs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Wikipedia / Wikidata / wiki-style references:
 *
 *   - Wikipedia URLs:   https://en.wikipedia.org/wiki/Quantum_mechanics
 *   - Wikidata Q-IDs:   Q42 / Q12345
 *   - MediaWiki refs:   [[Article name]] / [[Article|display]]
 *   - DBPedia URLs:     https://dbpedia.org/resource/X
 *
 * Public API:
 *   extractWikiRefs(text)             → { entries, totals, total }
 *   buildWikiRefsForFiles(files)      → { perFile, aggregate, totals }
 *   renderWikiRefsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const WP_URL_RE = /\bhttps?:\/\/([a-z]{2,3})\.wikipedia\.org\/wiki\/([A-Za-z0-9._%()-]{1,150})/g;
const WIKIDATA_RE = /\b(Q\d{2,9})\b/g;
const MEDIAWIKI_LINK_RE = /\[\[([^|\]]{1,80})(?:\|([^\]]{1,80}))?\]\]/g;
const DBPEDIA_RE = /\bhttps?:\/\/dbpedia\.org\/resource\/([A-Za-z0-9._%()-]{2,150})/g;
const WIKI_API_RE = /\bhttps?:\/\/([a-z]{2,3})\.wikipedia\.org\/w\/api\.php\?[^"\s]{5,200}/g;

const Q_RESERVED = new Set(['Q1', 'Q2']); // Reserve common false positives; keep minimal

function extractWikiRefs(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { wikipedia: 0, wikidata: 0, mediawiki: 0, dbpedia: 0 };

  function push(kind, lang, title, display) {
    const key = `${kind}:${lang || ''}:${title}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, lang, title, display });
    if (totals[kind] != null) totals[kind] += 1;
  }

  WP_URL_RE.lastIndex = 0;
  let m;
  while ((m = WP_URL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('wikipedia', m[1], decodeURIComponent(m[2]).replace(/_/g, ' '), null);
  }

  if (entries.length < MAX_PER_FILE) {
    WIKI_API_RE.lastIndex = 0;
    while ((m = WIKI_API_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('wikipedia', m[1], 'api.php', null);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    WIKIDATA_RE.lastIndex = 0;
    while ((m = WIKIDATA_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const q = m[1];
      if (Q_RESERVED.has(q)) continue;
      // require at least 2 digits (Q10+) to reduce false positives
      if (q.length < 3) continue;
      push('wikidata', null, q, null);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    MEDIAWIKI_LINK_RE.lastIndex = 0;
    while ((m = MEDIAWIKI_LINK_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const title = m[1].trim();
      const display = m[2] ? m[2].trim() : null;
      if (title.length < 1) continue;
      push('mediawiki', null, title, display);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    DBPEDIA_RE.lastIndex = 0;
    while ((m = DBPEDIA_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('dbpedia', null, decodeURIComponent(m[1]).replace(/_/g, ' '), null);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildWikiRefsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { wikipedia: 0, wikidata: 0, mediawiki: 0, dbpedia: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractWikiRefs(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.lang || ''}:${e.title}`;
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

function renderWikiRefsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## WIKIPEDIA / WIKI REFERENCES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      const langPart = e.lang ? `[${e.lang}] ` : '';
      const disp = e.display ? ` (${e.display})` : '';
      lines.push(`- ${e.kind}: ${langPart}\`${e.title}\`${disp}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractWikiRefs,
  buildWikiRefsForFiles,
  renderWikiRefsBlock,
};

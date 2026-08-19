'use strict';

/**
 * document-arxiv-ids.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects arXiv preprint identifiers:
 *
 *   - new format:  arXiv:YYMM.NNNNN (post-April 2007)
 *   - new format URL:  https://arxiv.org/abs/2401.12345
 *   - old format:  cs.AI/0701001 (subject + 7-digit before 2007)
 *   - version suffix: arXiv:2401.12345v2
 *
 * Public API:
 *   extractArxivIds(text)             → { entries, totals, total }
 *   buildArxivIdsForFiles(files)      → { perFile, aggregate, totals }
 *   renderArxivIdsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const NEW_ID_RE = /\barXiv\s*:\s*(\d{4}\.\d{4,5})(?:v(\d+))?/gi;
const NEW_URL_RE = /\bhttps?:\/\/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v(\d+))?/g;
const OLD_ID_RE = /\b((?:cs|math|physics|astro-ph|cond-mat|gr-qc|hep-ph|hep-th|nlin|nucl-ex|nucl-th|q-alg|q-bio|q-fin|quant-ph|stat)(?:\.[A-Z]{2})?)\/(\d{7})(?:v(\d+))?/g;

function classifyYear(id) {
  const yyMm = id.split('.')[0];
  const yy = parseInt(yyMm.slice(0, 2), 10);
  if (yy < 50) return 2000 + yy;
  return 1900 + yy;
}

function extractArxivIds(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { new: 0, old: 0, url: 0, versioned: 0 };

  function push(kind, id, version, source) {
    const key = `${id}:${version || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, id, version: version || null, source, year: kind === 'new' ? classifyYear(id) : null });
    if (totals[kind] != null) totals[kind] += 1;
    if (version) totals.versioned += 1;
  }

  NEW_URL_RE.lastIndex = 0;
  let m;
  while ((m = NEW_URL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('new', m[1], m[2], 'url');
  }
  if (entries.length < MAX_PER_FILE) {
    NEW_ID_RE.lastIndex = 0;
    while ((m = NEW_ID_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('new', m[1], m[2], 'identifier');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    OLD_ID_RE.lastIndex = 0;
    while ((m = OLD_ID_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('old', `${m[1]}/${m[2]}`, m[3], 'old-identifier');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildArxivIdsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { new: 0, old: 0, url: 0, versioned: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractArxivIds(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.id}:${e.version || ''}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (e.version) totals.versioned += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderArxivIdsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## arXiv PREPRINT IDs'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      const v = e.version ? `v${e.version}` : '';
      const yr = e.year ? ` (${e.year})` : '';
      lines.push(`- arXiv:${e.id}${v}${yr}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractArxivIds,
  buildArxivIdsForFiles,
  renderArxivIdsBlock,
  _internal: { classifyYear },
};

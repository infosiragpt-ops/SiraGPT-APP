'use strict';

/**
 * document-md-ref-links.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects markdown reference-style links at document scope:
 *
 *   - [label]: https://example.com "Optional title"
 *   - [label]: <https://example.com>
 *   - footnote refs: [^1]: explanation text
 *   - in-text references: [text][label] / [text][] usage
 *
 * Public API:
 *   extractMdRefLinks(text)             → { entries, totals, total }
 *   buildMdRefLinksForFiles(files)      → { perFile, aggregate, totals }
 *   renderMdRefLinksBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 26;
const MAX_BLOCK_CHARS = 4500;

const DEF_RE = /^\s*\[([^\]\n]{1,80})\]\s*:\s*<?(https?:\/\/[^>\s\n]{4,300}|[^\s\n<>]{4,300})>?(?:\s+["'(]([^"'\n)]{1,120})["')])?$/gm;
const FOOTNOTE_DEF_RE = /^\s*\[\^([A-Za-z0-9_-]{1,40})\]\s*:\s*(.{2,300})$/gm;
const USAGE_RE = /\[([^\]\n]{1,80})\]\[([A-Za-z0-9_-]{1,40})\]/g;
const FOOTNOTE_USAGE_RE = /\[\^([A-Za-z0-9_-]{1,40})\]/g;

function extractMdRefLinks(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { def: 0, footnoteDef: 0, usage: 0, footnoteUsage: 0 };

  DEF_RE.lastIndex = 0;
  let m;
  while ((m = DEF_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const key = `def:${m[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'def', label: m[1], url: m[2].slice(0, 150), title: m[3] || null });
    totals.def += 1;
  }
  if (entries.length < MAX_PER_FILE) {
    FOOTNOTE_DEF_RE.lastIndex = 0;
    while ((m = FOOTNOTE_DEF_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `fndef:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'footnoteDef', label: m[1], body: m[2].slice(0, 100) });
      totals.footnoteDef += 1;
    }
  }
  if (entries.length < MAX_PER_FILE) {
    USAGE_RE.lastIndex = 0;
    while ((m = USAGE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `usage:${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'usage', text: m[1], ref: m[2] });
      totals.usage += 1;
    }
  }
  if (entries.length < MAX_PER_FILE) {
    FOOTNOTE_USAGE_RE.lastIndex = 0;
    while ((m = FOOTNOTE_USAGE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `fnuse:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'footnoteUsage', label: m[1] });
      totals.footnoteUsage += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildMdRefLinksForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { def: 0, footnoteDef: 0, usage: 0, footnoteUsage: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractMdRefLinks(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.label || e.ref || ''}`;
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

function renderMdRefLinksBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## MARKDOWN REFERENCE LINKS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      if (e.kind === 'def') {
        lines.push(`- [${e.label}]: \`${e.url}\`${e.title ? ` "${e.title}"` : ''}`);
      } else if (e.kind === 'footnoteDef') {
        lines.push(`- [^${e.label}]: ${e.body.slice(0, 60)}`);
      } else if (e.kind === 'usage') {
        lines.push(`- usage: [${e.text}][${e.ref}]`);
      } else {
        lines.push(`- footnote-use: [^${e.label}]`);
      }
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractMdRefLinks,
  buildMdRefLinksForFiles,
  renderMdRefLinksBlock,
};

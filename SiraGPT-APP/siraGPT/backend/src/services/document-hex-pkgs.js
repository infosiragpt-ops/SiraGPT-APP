'use strict';

/**
 * document-hex-pkgs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Elixir Hex package references in mix.exs:
 *
 *   - {:package, "~> 1.0"}
 *   - {:package, "~> 1.0", only: :dev}
 *   - {:package, git: "https://..."}
 *   - {:package, path: "../local"}
 *   - {:package, "~> 1.0", override: true}
 *
 * Public API:
 *   extractHexPkgs(text)             → { entries, totals, total }
 *   buildHexPkgsForFiles(files)      → { perFile, aggregate, totals }
 *   renderHexPkgsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const HEX_INLINE_RE = /\{\s*:([a-z][a-z0-9_]{0,60})\s*,\s*"([~>=<! ]*\d[0-9.\s,~><=! ]{0,40})"[^}]{0,200}\}/g;
const HEX_TABLE_RE = /\{\s*:([a-z][a-z0-9_]{0,60})\s*,([^}\n]{2,300})\}/g;

function classifySource(value) {
  if (/\bgit\s*:/.test(value)) return 'git';
  if (/\bpath\s*:/.test(value)) return 'path';
  if (/\bgithub\s*:/.test(value)) return 'github';
  if (/^[\s,]*"[~>=<! 0-9.]/.test(value)) return 'hex';
  return 'other';
}

function extractVersion(value) {
  const m = /"([~>=<! ]*\d[0-9.\s,~><=! ]{0,40})"/.exec(value);
  return m ? m[1].trim() : null;
}

function extractHexPkgs(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { hex: 0, git: 0, path: 0, github: 0, other: 0 };

  HEX_INLINE_RE.lastIndex = 0;
  let m;
  while ((m = HEX_INLINE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    entries.push({ name: m[1], version: m[2], source: 'hex' });
    totals.hex += 1;
  }
  if (entries.length < MAX_PER_FILE) {
    HEX_TABLE_RE.lastIndex = 0;
    while ((m = HEX_TABLE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      const source = classifySource(m[2]);
      const version = extractVersion(m[2]);
      entries.push({ name: m[1], version, source });
      if (totals[source] != null) totals[source] += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildHexPkgsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { hex: 0, git: 0, path: 0, github: 0, other: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractHexPkgs(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.name}:${e.source}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.source] != null) totals[e.source] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderHexPkgsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## ELIXIR / HEX PACKAGES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 12)) {
      const v = e.version ? ` "${e.version}"` : '';
      lines.push(`- \`:${e.name}\`${v} (${e.source})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractHexPkgs,
  buildHexPkgsForFiles,
  renderHexPkgsBlock,
  _internal: { classifySource, extractVersion },
};

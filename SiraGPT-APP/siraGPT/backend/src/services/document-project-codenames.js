'use strict';

/**
 * document-project-codenames.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects project/workstream/operation codename references:
 *
 *   - "Project Apollo" / "Project Phoenix"
 *   - "Operation Nightfall" / "Operation Quickstrike"
 *   - "Initiative X" / "Workstream Y"
 *   - "Codename: Atlas" / "(codename Atlas)"
 *
 * Public API:
 *   extractProjectCodenames(text)             → { entries, totals, total }
 *   buildProjectCodenamesForFiles(files)      → { perFile, aggregate, totals }
 *   renderProjectCodenamesBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4500;

const KIND_RE = /\b(Project|Operation|Initiative|Workstream|Programme|Program)\s+([A-Z][A-Za-z][A-Za-z0-9\-' ]{1,40}?)(?=[\s,.!?:;]|$|\n)/g;
const CODENAME_RE = /\b(?:codename|code\s+name|cover\s+name)\s*[:=]?\s*([A-Z][A-Za-z][A-Za-z0-9\-]{1,30})\b/gi;
const PAREN_CODENAME_RE = /\((?:codename|code-name)\s+([A-Z][A-Za-z][A-Za-z0-9\-]{1,30})\)/gi;

const RESERVED_NAMES = new Set([
  'Manager', 'Lead', 'Director', 'Owner', 'Status', 'Team', 'Page',
  'Status', 'Yes', 'No', 'TBD', 'TBA', 'Update', 'Note', 'Notes',
]);

function looksLikeCodename(s) {
  if (!s || s.length < 3 || s.length > 40) return false;
  if (RESERVED_NAMES.has(s)) return false;
  // First char must be uppercase
  if (!/^[A-Z]/.test(s)) return false;
  // Must contain at least one lowercase or hyphen (avoid all-caps acronyms)
  if (/^[A-Z]+$/.test(s)) return false;
  return true;
}

function extractProjectCodenames(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { project: 0, operation: 0, initiative: 0, workstream: 0, programme: 0, codename: 0 };

  function push(kind, name, source) {
    const key = `${kind}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, name, source });
    if (totals[kind] != null) totals[kind] += 1;
  }

  KIND_RE.lastIndex = 0;
  let m;
  while ((m = KIND_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const kindWord = m[1].toLowerCase();
    const kind = kindWord === 'program' ? 'programme' : kindWord;
    const name = m[2].trim();
    if (!looksLikeCodename(name)) continue;
    push(kind, name, 'kind-name');
  }

  if (entries.length < MAX_PER_FILE) {
    CODENAME_RE.lastIndex = 0;
    while ((m = CODENAME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const name = m[1];
      if (!looksLikeCodename(name)) continue;
      push('codename', name, 'codename-prefix');
    }
  }

  if (entries.length < MAX_PER_FILE) {
    PAREN_CODENAME_RE.lastIndex = 0;
    while ((m = PAREN_CODENAME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const name = m[1];
      if (!looksLikeCodename(name)) continue;
      push('codename', name, 'parenthesised');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildProjectCodenamesForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { project: 0, operation: 0, initiative: 0, workstream: 0, programme: 0, codename: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractProjectCodenames(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}`;
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

function renderProjectCodenamesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## PROJECT / OPERATION CODENAMES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- ${e.kind}: \`${e.name}\` (${e.source})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractProjectCodenames,
  buildProjectCodenamesForFiles,
  renderProjectCodenamesBlock,
  _internal: { looksLikeCodename },
};

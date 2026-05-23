'use strict';

/**
 * document-composer-pkgs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects PHP Composer package references in composer.json / composer.lock /
 * require statements:
 *
 *   - "vendor/package": "^1.0"     (composer.json require/require-dev)
 *   - "name": "vendor/package"     (composer.lock packages)
 *   - composer require vendor/pkg:^1.0
 *
 * Public API:
 *   extractComposerPkgs(text)             → { entries, totals, total }
 *   buildComposerPkgsForFiles(files)      → { perFile, aggregate, totals }
 *   renderComposerPkgsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const JSON_REQ_RE = /"([a-z][a-z0-9_-]{0,40}\/[a-z0-9][a-z0-9_-]{0,80})"\s*:\s*"([\^~><=]?[0-9*][0-9.x*~^.|<>= -]{0,40})"/g;
const NAME_FIELD_RE = /"name"\s*:\s*"([a-z][a-z0-9_-]{0,40}\/[a-z0-9][a-z0-9_-]{0,80})"/g;
const COMPOSER_CMD_RE = /\bcomposer\s+require(?:\s+--dev)?\s+([a-z][a-z0-9_-]{0,40}\/[a-z0-9][a-z0-9_-]{0,80})(?::([\^~><=]?[0-9*][0-9.x*~^.|<>= -]{0,40}))?/g;

function classifyConstraint(c) {
  if (!c) return null;
  if (c.startsWith('^')) return 'caret';
  if (c.startsWith('~')) return 'tilde';
  if (/^[0-9]/.test(c)) return 'exact';
  if (/[<>=]/.test(c)) return 'range';
  if (c.includes('*')) return 'wildcard';
  return 'other';
}

function extractComposerPkgs(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { caret: 0, tilde: 0, exact: 0, range: 0, wildcard: 0, other: 0, lock: 0, command: 0 };

  // Lock file packages (high confidence)
  NAME_FIELD_RE.lastIndex = 0;
  let m;
  while ((m = NAME_FIELD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const key = `lock:${m[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ name: m[1], constraint: null, kind: 'lock' });
    totals.lock += 1;
  }

  // JSON require entries
  if (entries.length < MAX_PER_FILE) {
    JSON_REQ_RE.lastIndex = 0;
    while ((m = JSON_REQ_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `req:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const kind = classifyConstraint(m[2]) || 'other';
      entries.push({ name: m[1], constraint: m[2], kind });
      if (totals[kind] != null) totals[kind] += 1;
    }
  }

  // composer require command
  if (entries.length < MAX_PER_FILE) {
    COMPOSER_CMD_RE.lastIndex = 0;
    while ((m = COMPOSER_CMD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `cmd:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ name: m[1], constraint: m[2] || null, kind: 'command' });
      totals.command += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildComposerPkgsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { caret: 0, tilde: 0, exact: 0, range: 0, wildcard: 0, other: 0, lock: 0, command: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractComposerPkgs(txt);
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

function renderComposerPkgsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## PHP / COMPOSER PACKAGES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 12)) {
      const c = e.constraint ? ` ${e.constraint}` : '';
      lines.push(`- \`${e.name}\`${c} (${e.kind})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractComposerPkgs,
  buildComposerPkgsForFiles,
  renderComposerPkgsBlock,
  _internal: { classifyConstraint },
};

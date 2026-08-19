'use strict';

/**
 * document-gem-pkgs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Ruby Gemfile / Gemfile.lock / gemspec dependencies:
 *
 *   - Gemfile:        gem 'name', '~> 1.0'
 *                     gem "name", "1.2.3"
 *                     gem 'name', git: '...', branch: 'main'
 *   - gemspec:        s.add_dependency 'name', '~> 1'
 *                     s.add_runtime_dependency
 *                     s.add_development_dependency
 *   - Gemfile.lock:   "    name (1.0)" entry
 *
 * Public API:
 *   extractGemPkgs(text)             → { entries, totals, total }
 *   buildGemPkgsForFiles(files)      → { perFile, aggregate, totals }
 *   renderGemPkgsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const GEMFILE_RE = /\bgem\s+['"]([a-z][a-z0-9_-]{0,80})['"](?:\s*,\s*['"]([~>=<! ]*\d[0-9.\s,~><=! a-zA-Z-]{0,60})['"])?/g;
const GEMSPEC_RE = /\bs\.add(?:_runtime|_development)?_dependency\s+['"]([a-z][a-z0-9_-]{0,80})['"](?:\s*,\s*['"]([~>=<! ]*\d[0-9.\s,~><=! a-zA-Z-]{0,60})['"])?/g;
const LOCK_RE = /^\s{4}([a-z][a-z0-9_-]{0,80})\s+\((\d[0-9a-zA-Z.\-]{0,30})\)/gm;
const BUNDLE_CMD_RE = /\bbundle\s+(?:add|install)\s+([a-z][a-z0-9_-]{0,80})/g;

function classifyConstraint(c) {
  if (!c) return null;
  if (c.includes('~>')) return 'pessimistic';
  if (/^[\s>=<]+/.test(c)) return 'comparison';
  if (/^\d/.test(c.trim())) return 'exact';
  return 'other';
}

function extractGemPkgs(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { gem: 0, gemspec: 0, lock: 0, command: 0 };

  GEMFILE_RE.lastIndex = 0;
  let m;
  while ((m = GEMFILE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const key = `gem:${m[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ name: m[1], constraint: m[2] || null, kind: 'gem', constraintKind: classifyConstraint(m[2]) });
    totals.gem += 1;
  }
  if (entries.length < MAX_PER_FILE) {
    GEMSPEC_RE.lastIndex = 0;
    while ((m = GEMSPEC_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `gemspec:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ name: m[1], constraint: m[2] || null, kind: 'gemspec', constraintKind: classifyConstraint(m[2]) });
      totals.gemspec += 1;
    }
  }
  if (entries.length < MAX_PER_FILE) {
    LOCK_RE.lastIndex = 0;
    while ((m = LOCK_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `lock:${m[1]}:${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ name: m[1], constraint: m[2], kind: 'lock', constraintKind: 'exact' });
      totals.lock += 1;
    }
  }
  if (entries.length < MAX_PER_FILE) {
    BUNDLE_CMD_RE.lastIndex = 0;
    while ((m = BUNDLE_CMD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `cmd:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ name: m[1], constraint: null, kind: 'command', constraintKind: null });
      totals.command += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildGemPkgsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { gem: 0, gemspec: 0, lock: 0, command: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractGemPkgs(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}:${e.constraint || ''}`;
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

function renderGemPkgsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## RUBY GEM PACKAGES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 12)) {
      const c = e.constraint ? ` "${e.constraint}"` : '';
      lines.push(`- \`${e.name}\`${c} (${e.kind})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractGemPkgs,
  buildGemPkgsForFiles,
  renderGemPkgsBlock,
  _internal: { classifyConstraint },
};

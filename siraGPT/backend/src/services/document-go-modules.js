'use strict';

/**
 * document-go-modules.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Go module references in go.mod / go.sum / go imports:
 *
 *   - require github.com/foo/bar v1.2.3
 *   - replace github.com/x/y => ../local
 *   - retract v1.2.3
 *   - import "github.com/foo/bar"
 *   - module declaration:  module github.com/example/proj
 *   - pseudo versions: v0.0.0-YYYYMMDDHHMMSS-abc123def456
 *
 * Public API:
 *   extractGoModules(text)             → { entries, totals, total }
 *   buildGoModulesForFiles(files)      → { perFile, aggregate, totals }
 *   renderGoModulesBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const MODULE_RE = /^\s*module\s+([a-z][a-z0-9._/-]{4,150})/gim;
const REQUIRE_RE = /^\s*(?:require\s+)?([a-z][a-z0-9.-]{3,80}(?:\/[a-zA-Z0-9._-]{1,60}){1,8})\s+(v\d+(?:\.\d+){0,2}(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?)/gm;
const REPLACE_RE = /^\s*replace\s+([a-z][a-z0-9._/-]{4,120})\s*=>\s*(\S{3,150})/gim;
const RETRACT_RE = /^\s*retract\s+(v\d+(?:\.\d+){0,2}(?:-[A-Za-z0-9.-]+)?)/gim;
const IMPORT_RE = /^\s*(?:import\s+)?"([a-z][a-z0-9.-]{3,80}(?:\/[a-zA-Z0-9._-]{1,60}){1,8})"/gm;

function isPseudoVersion(v) {
  return /^v0\.0\.0-\d{14}-[a-f0-9]{12}$/.test(v);
}

function extractGoModules(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { module: 0, require: 0, replace: 0, retract: 0, import: 0, pseudo: 0 };

  MODULE_RE.lastIndex = 0;
  let m;
  while ((m = MODULE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const key = `module:${m[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'module', path: m[1], version: null });
    totals.module += 1;
  }

  if (entries.length < MAX_PER_FILE) {
    REQUIRE_RE.lastIndex = 0;
    while ((m = REQUIRE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const path = m[1];
      const version = m[2];
      const key = `require:${path}:${version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'require', path, version, pseudo: isPseudoVersion(version) });
      totals.require += 1;
      if (isPseudoVersion(version)) totals.pseudo += 1;
    }
  }

  if (entries.length < MAX_PER_FILE) {
    REPLACE_RE.lastIndex = 0;
    while ((m = REPLACE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `replace:${m[1]}=>${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'replace', path: m[1], target: m[2], version: null });
      totals.replace += 1;
    }
  }

  if (entries.length < MAX_PER_FILE) {
    RETRACT_RE.lastIndex = 0;
    while ((m = RETRACT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `retract:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'retract', path: null, version: m[1] });
      totals.retract += 1;
    }
  }

  if (entries.length < MAX_PER_FILE) {
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `import:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'import', path: m[1], version: null });
      totals.import += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildGoModulesForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { module: 0, require: 0, replace: 0, retract: 0, import: 0, pseudo: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractGoModules(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.path || ''}:${e.version || ''}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (e.pseudo) totals.pseudo += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderGoModulesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## GO MODULES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 12)) {
      const v = e.version ? ` ${e.version}` : '';
      const ps = e.pseudo ? ' (pseudo)' : '';
      lines.push(`- [${e.kind}] \`${e.path || ''}\`${v}${ps}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractGoModules,
  buildGoModulesForFiles,
  renderGoModulesBlock,
  _internal: { isPseudoVersion },
};

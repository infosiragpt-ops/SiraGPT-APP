'use strict';

/**
 * document-npm-refs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects NPM / Yarn / PNPM package references and version specifiers:
 *
 *   - bare:        lodash, react, @types/node
 *   - versioned:   lodash@4.17.21 | react@^18.0.0 | @types/node@^20.0.0
 *   - protocols:   file:./local/pkg | link:../pkg | github:owner/repo
 *   - workspace:   workspace:* | workspace:^1.0.0 (pnpm/yarn)
 *
 * Public API:
 *   extractNpmRefs(text)             → { entries, totals, total }
 *   buildNpmRefsForFiles(files)      → { perFile, aggregate, totals }
 *   renderNpmRefsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 4800;

const NAME = '(?:@[a-z0-9][a-z0-9._-]{0,80}\\/)?[a-z0-9][a-z0-9._-]{0,80}';
const VERSIONED_RE = new RegExp(`(?<![A-Za-z0-9_])(${NAME})@([0-9~^>=<*x]?[0-9.x*~^>=<,\\s|-]{1,40}|latest|next|alpha|beta|rc|canary)`, 'gi');
const JSON_DEP_RE = /"(@?[a-z0-9][a-z0-9._/-]{0,80})"\s*:\s*"([0-9~^>=<*x]?[0-9.x*~^>=<,\s|-]{1,40}|latest|next|alpha|beta|rc|canary)"/gi;
const PROTOCOL_RE = new RegExp(`(${NAME})['"]?\\s*[:=]\\s*['"](file|link|github|workspace|portal|npm|gh|jsr|patch):([^'"\\s,}]{1,200})`, 'gi');
const REQUIRE_CALL_RE = /\brequire\s*\(\s*['"](@?[a-z0-9][a-z0-9._/-]{1,80})['"]/g;
const IMPORT_FROM_RE = /\bimport\s+(?:[\w*{}\s,]+\s+from\s+)?['"](@?[a-z0-9][a-z0-9._/-]{1,80})['"]/g;

const STDLIB_BUILTIN = new Set([
  'fs', 'path', 'http', 'https', 'os', 'util', 'crypto', 'stream', 'events',
  'net', 'tls', 'url', 'querystring', 'child_process', 'cluster', 'buffer',
  'assert', 'zlib', 'readline', 'process', 'console', 'timers', 'tty',
  'dgram', 'dns', 'string_decoder', 'punycode', 'vm', 'worker_threads',
  'node:fs', 'node:path', 'node:http', 'node:crypto', 'node:test', 'node:assert',
]);

function looksLikePackageName(s) {
  if (!s || s.length < 2 || s.length > 80) return false;
  if (STDLIB_BUILTIN.has(s)) return false;
  if (s.startsWith('.') || s.startsWith('/')) return false;
  return /^@?[a-z0-9]/.test(s);
}

function classifyVersion(v) {
  if (!v) return 'exact';
  if (v.startsWith('^')) return 'caret';
  if (v.startsWith('~')) return 'tilde';
  if (/^[0-9]/.test(v)) return 'exact';
  if (/^(?:latest|next|alpha|beta|rc|canary)$/.test(v)) return 'tag';
  if (/[><=]/.test(v)) return 'range';
  return 'other';
}

function extractNpmRefs(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { exact: 0, caret: 0, tilde: 0, range: 0, tag: 0, protocol: 0, import: 0 };

  // Versioned
  VERSIONED_RE.lastIndex = 0;
  let m;
  while ((m = VERSIONED_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const name = m[1];
    const version = m[2].trim();
    if (!looksLikePackageName(name)) continue;
    const key = `pkg:${name}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = classifyVersion(version);
    entries.push({ name, version, kind });
    if (totals[kind] != null) totals[kind] += 1;
  }

  // JSON-style deps: "react": "^18.0.0"
  if (entries.length < MAX_PER_FILE) {
    JSON_DEP_RE.lastIndex = 0;
    while ((m = JSON_DEP_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const name = m[1];
      const version = m[2].trim();
      if (!looksLikePackageName(name)) continue;
      const key = `pkg:${name}@${version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const kind = classifyVersion(version);
      entries.push({ name, version, kind });
      if (totals[kind] != null) totals[kind] += 1;
    }
  }

  // Protocol prefix
  if (entries.length < MAX_PER_FILE) {
    PROTOCOL_RE.lastIndex = 0;
    while ((m = PROTOCOL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const name = m[1];
      const proto = m[2];
      const target = m[3];
      if (!looksLikePackageName(name)) continue;
      const key = `proto:${name}@${proto}:${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ name, version: `${proto}:${target}`, kind: 'protocol' });
      totals.protocol += 1;
    }
  }

  // require()
  if (entries.length < MAX_PER_FILE) {
    REQUIRE_CALL_RE.lastIndex = 0;
    while ((m = REQUIRE_CALL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      let name = m[1];
      const parts = name.split('/');
      if (name.startsWith('@')) {
        name = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : name;
      } else {
        name = parts[0];
      }
      if (!looksLikePackageName(name)) continue;
      const key = `imp:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ name, version: null, kind: 'import' });
      totals.import += 1;
    }
  }

  // import ... from '...'
  if (entries.length < MAX_PER_FILE) {
    IMPORT_FROM_RE.lastIndex = 0;
    while ((m = IMPORT_FROM_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      let name = m[1];
      const parts = name.split('/');
      if (name.startsWith('@')) {
        name = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : name;
      } else {
        name = parts[0];
      }
      if (!looksLikePackageName(name)) continue;
      const key = `imp:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ name, version: null, kind: 'import' });
      totals.import += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildNpmRefsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { exact: 0, caret: 0, tilde: 0, range: 0, tag: 0, protocol: 0, import: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractNpmRefs(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.name}@${e.version || 'imp'}`;
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

function renderNpmRefsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## NPM PACKAGE REFERENCES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 12)) {
      const tag = e.version ? `@${e.version}` : '';
      lines.push(`- \`${e.name}${tag}\` (${e.kind})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractNpmRefs,
  buildNpmRefsForFiles,
  renderNpmRefsBlock,
  _internal: { looksLikePackageName, classifyVersion },
};

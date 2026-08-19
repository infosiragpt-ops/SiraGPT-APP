'use strict';

/**
 * document-csp-directives.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Content-Security-Policy directives in security configs / web docs:
 *
 *   - default-src 'self' / 'none' / *
 *   - script-src https://cdn.example.com 'unsafe-inline'
 *   - style-src 'self' 'nonce-...'
 *   - frame-ancestors 'self'
 *   - img-src data: https:
 *   - report-uri / report-to
 *
 * Routes "what CSP?" / "what security policy?" to a citeable list.
 *
 * Public API:
 *   extractCspDirectives(text)         → CspReport
 *   buildCspDirectivesForFiles(files)  → { perFile, aggregate, totals }
 *   renderCspDirectivesBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 5000;
const MAX_VALUE_LEN = 200;

const CSP_DIRECTIVES = [
  'default-src', 'script-src', 'script-src-elem', 'script-src-attr',
  'style-src', 'style-src-elem', 'style-src-attr',
  'img-src', 'font-src', 'connect-src', 'media-src', 'object-src',
  'frame-src', 'frame-ancestors', 'child-src', 'worker-src',
  'manifest-src', 'prefetch-src', 'base-uri', 'form-action',
  'report-uri', 'report-to', 'sandbox', 'plugin-types',
  'block-all-mixed-content', 'upgrade-insecure-requests',
  'require-trusted-types-for', 'trusted-types', 'navigate-to',
];

const DIRECTIVE_RE = new RegExp(`\\b(${CSP_DIRECTIVES.join('|')})\\s+([^;\\n]{1,200})`, 'gi');

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipValue(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_VALUE_LEN) return t;
  return `${t.slice(0, MAX_VALUE_LEN - 1)}…`;
}

function extractCspDirectives(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: {}, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = {};

  for (const m of head.matchAll(DIRECTIVE_RE)) {
    if (entries.length >= MAX_PER_FILE) break;
    const directive = m[1].toLowerCase();
    const value = clipValue(m[2]);
    const key = `${directive}|${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ directive, value });
    totals[directive] = (totals[directive] || 0) + 1;
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildCspDirectivesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = {};
  for (const f of list) {
    const r = extractCspDirectives(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of Object.keys(r.totals)) totals[k] = (totals[k] || 0) + r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- **${e.directive}**${file}: ${e.value}`;
}

function renderCspDirectivesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || {};
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## CSP DIRECTIVES (Content-Security-Policy)
Content-Security-Policy directives detected — default-src, script-src, style-src, img-src, connect-src, font-src, frame-ancestors, base-uri, form-action, report-uri/report-to, sandbox, upgrade-insecure-requests, trusted-types, etc. (~30 directives). Routes "what CSP?" / "what security policy?" to a citeable list.

**By directive:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate CSP directives across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...CSP block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractCspDirectives,
  buildCspDirectivesForFiles,
  renderCspDirectivesBlock,
  _internal: {
    DIRECTIVE_RE,
    CSP_DIRECTIVES,
  },
};

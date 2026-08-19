'use strict';

/**
 * document-http-methods.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Counts HTTP method invocations across the document, distinct from
 * document-api-endpoints which captures (method, path) pairs. This module
 * gives an aggregate census useful for traffic shape / API surface area.
 *
 *   - GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, TRACE, CONNECT
 *
 * Routes "how many GETs vs POSTs?" / "method distribution?" to a citeable
 * summary.
 *
 * Public API:
 *   extractHttpMethods(text)         → HttpMethodReport
 *   buildHttpMethodsForFiles(files)  → { perFile, aggregate, totals }
 *   renderHttpMethodsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_BLOCK_CHARS = 3500;

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'];

// METHOD followed by space + URL/path/quoted-URL — captures actual API call shape
const METHOD_RE = new RegExp(`\\b(${METHODS.join('|')})\\s+(?:https?:\\/\\/|\\/|["'])`, 'g');

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function emptyCounts() {
  const r = {};
  for (const m of METHODS) r[m] = 0;
  return r;
}

function extractHttpMethods(input) {
  const text = safeText(input);
  if (!text) return { counts: emptyCounts(), total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const counts = emptyCounts();
  const seenPositions = new Set();

  for (const m of head.matchAll(METHOD_RE)) {
    if (seenPositions.has(m.index)) continue;
    seenPositions.add(m.index);
    counts[m[1]] += 1;
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { counts, total, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildHttpMethodsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  const totals = emptyCounts();
  for (const f of list) {
    const r = extractHttpMethods(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, counts: r.counts, total: r.total });
    for (const m of METHODS) totals[m] += r.counts[m];
  }
  const grandTotal = Object.values(totals).reduce((a, b) => a + b, 0);
  return { perFile, totals, grandTotal };
}

function renderCounts(counts) {
  return METHODS
    .filter((m) => counts[m] > 0)
    .map((m) => `${m}=${counts[m]}`)
    .join('  ');
}

function renderHttpMethodsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## HTTP METHODS CENSUS
Aggregate count of HTTP method invocations across the document(s) — GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS / TRACE / CONNECT. Captures method-followed-by-path patterns (inline or in code blocks). Different from API endpoint extractor (which deduplicates by method+path). Routes "method distribution?" / "how many GETs vs POSTs?" to a citeable summary.

**Grand total:** ${report.grandTotal} invocations
**Aggregate:** ${renderCounts(report.totals)}`;
  const sections = [];
  for (const p of report.perFile) {
    sections.push(`### File: ${p.file} (${p.total} invocations)`);
    sections.push(`- ${renderCounts(p.counts)}`);
  }
  let combined = `${heading}\n\n${sections.join('\n\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...HTTP methods block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractHttpMethods,
  buildHttpMethodsForFiles,
  renderHttpMethodsBlock,
  _internal: {
    METHODS,
    METHOD_RE,
  },
};

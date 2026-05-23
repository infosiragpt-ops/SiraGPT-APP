'use strict';

/**
 * document-stack-traces.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects stack-trace frames across language conventions. Useful for routing
 * "where did the error originate?" and grouping crash reports.
 *
 * Targets:
 *   - JS/V8:    at FunctionName (path/to/file.js:123:45)
 *               at Object.<anonymous> (file.js:10:1)
 *   - Python:   File "/path/to/file.py", line 42, in func_name
 *   - Java:     at com.example.Class.method(File.java:123)
 *   - Go:       /path/to/file.go:123 +0x42
 *   - Ruby:     /path/to/file.rb:42:in `method_name'
 *
 * Public API:
 *   extractStackTraces(text)            → { entries, totals, total }
 *   buildStackTracesForFiles(files)     → { perFile, aggregate, totals }
 *   renderStackTracesBlock(report)      → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4800;

const JS_FRAME_RE = /\bat\s+([A-Za-z_$][A-Za-z0-9_$.<>]{0,100})\s*\(([^)]+\.(?:js|ts|jsx|tsx|mjs|cjs)):(\d+):(\d+)\)/g;
const PY_FRAME_RE = /\bFile\s+"([^"]{1,200}\.py)",\s*line\s+(\d+),\s*in\s+([A-Za-z_][A-Za-z0-9_]{0,80})/g;
const JAVA_FRAME_RE = /\bat\s+([a-zA-Z_$][a-zA-Z0-9_$.]+)\(([A-Za-z_][A-Za-z0-9_]*\.java):(\d+)\)/g;
const GO_FRAME_RE = /\b([^\s]{1,200}\.go):(\d+)(?:\s+\+0x[0-9a-f]+)?/g;
const RUBY_FRAME_RE = /\b([^\s'"]{1,200}\.rb):(\d+)(?::in\s+`([A-Za-z_][A-Za-z0-9_!?=]*)')?/g;

function extractStackTraces(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { js: 0, python: 0, java: 0, go: 0, ruby: 0 };

  // JS
  JS_FRAME_RE.lastIndex = 0;
  let m;
  while ((m = JS_FRAME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const fn = m[1];
    const file = m[2];
    const line = parseInt(m[3], 10);
    const key = `js:${fn}:${file}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ lang: 'js', fn, file, line, col: parseInt(m[4], 10) });
    totals.js += 1;
  }

  // Python
  if (entries.length < MAX_PER_FILE) {
    PY_FRAME_RE.lastIndex = 0;
    while ((m = PY_FRAME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const fn = m[3];
      const file = m[1];
      const line = parseInt(m[2], 10);
      const key = `py:${fn}:${file}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ lang: 'python', fn, file, line });
      totals.python += 1;
    }
  }

  // Java
  if (entries.length < MAX_PER_FILE) {
    JAVA_FRAME_RE.lastIndex = 0;
    while ((m = JAVA_FRAME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const fqn = m[1];
      const file = m[2];
      const line = parseInt(m[3], 10);
      const key = `java:${fqn}:${file}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ lang: 'java', fn: fqn, file, line });
      totals.java += 1;
    }
  }

  // Go
  if (entries.length < MAX_PER_FILE) {
    GO_FRAME_RE.lastIndex = 0;
    while ((m = GO_FRAME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const file = m[1];
      const line = parseInt(m[2], 10);
      const key = `go:${file}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ lang: 'go', file, line });
      totals.go += 1;
    }
  }

  // Ruby
  if (entries.length < MAX_PER_FILE) {
    RUBY_FRAME_RE.lastIndex = 0;
    while ((m = RUBY_FRAME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const file = m[1];
      const line = parseInt(m[2], 10);
      const fn = m[3] || null;
      const key = `rb:${file}:${line}:${fn || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ lang: 'ruby', fn, file, line });
      totals.ruby += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildStackTracesForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { js: 0, python: 0, java: 0, go: 0, ruby: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractStackTraces(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.lang}:${e.file}:${e.line}:${e.fn || ''}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.lang] != null) totals[e.lang] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderStackTracesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## STACK TRACE FRAMES'];
  const t = report.totals || {};
  const parts = [];
  if (t.js) parts.push(`JS: ${t.js}`);
  if (t.python) parts.push(`Python: ${t.python}`);
  if (t.java) parts.push(`Java: ${t.java}`);
  if (t.go) parts.push(`Go: ${t.go}`);
  if (t.ruby) parts.push(`Ruby: ${t.ruby}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      const fn = e.fn ? `${e.fn} ` : '';
      lines.push(`- [${e.lang}] ${fn}\`${e.file}:${e.line}${e.col != null ? `:${e.col}` : ''}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractStackTraces,
  buildStackTracesForFiles,
  renderStackTracesBlock,
};

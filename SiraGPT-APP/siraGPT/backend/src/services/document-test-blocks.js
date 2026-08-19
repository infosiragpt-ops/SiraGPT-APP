'use strict';

/**
 * document-test-blocks.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects test-framework block names: describe(...) / it(...) / test(...) /
 * suite(...) / context(...) / before(All|Each) / after(All|Each), plus Python
 * pytest function-defs (def test_foo) and JUnit @Test annotations.
 *
 * Useful for "what tests does this file contain?" / "show me every describe()
 * in this PR" without depending on a coverage report.
 *
 * Public API:
 *   extractTestBlocks(text)            → { entries, totals, total }
 *   buildTestBlocksForFiles(files)     → { perFile, aggregate, totals }
 *   renderTestBlocksBlock(report)      → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

// JS/TS frameworks: jest, mocha, vitest, node:test
const JS_BLOCK_RE = /\b(describe|it|test|suite|context|beforeAll|beforeEach|afterAll|afterEach|specify)\s*(?:\.\w+)?\s*\(\s*['"`]([^'"`\n]{1,200})['"`]/g;
// Python pytest
const PY_TEST_RE = /\bdef\s+(test_[A-Za-z0-9_]{1,120})\s*\(/g;
// Java JUnit
const JAVA_TEST_RE = /@Test\b[^@]{0,200}?\s+public\s+(?:static\s+)?void\s+([A-Za-z_][A-Za-z0-9_]{0,80})\s*\(/g;
// Go testing
const GO_TEST_RE = /\bfunc\s+(Test[A-Z][A-Za-z0-9_]{1,100})\s*\(\s*\w+\s+\*testing\.[TBM]\b/g;
// Ruby RSpec
const RSPEC_RE = /\b(describe|context|it|specify)\s+['"]([^'"\n]{2,200})['"]/g;

function classifyKw(kw) {
  const lower = kw.toLowerCase();
  if (lower === 'describe' || lower === 'context' || lower === 'suite') return 'group';
  if (lower === 'it' || lower === 'test' || lower === 'specify') return 'case';
  if (/^(before|after)/.test(lower)) return 'hook';
  return 'other';
}

function extractTestBlocks(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { group: 0, case: 0, hook: 0, pytest: 0, junit: 0, gotest: 0, rspec: 0 };

  // JS/TS
  JS_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = JS_BLOCK_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const kw = m[1];
    const name = m[2];
    const kind = classifyKw(kw);
    const key = `js:${kw}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ framework: 'js', kw, kind, name });
    if (totals[kind] != null) totals[kind] += 1;
  }

  // Python
  if (entries.length < MAX_PER_FILE) {
    PY_TEST_RE.lastIndex = 0;
    while ((m = PY_TEST_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `py:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ framework: 'pytest', kw: 'def', kind: 'case', name: m[1] });
      totals.pytest += 1;
    }
  }

  // Java
  if (entries.length < MAX_PER_FILE) {
    JAVA_TEST_RE.lastIndex = 0;
    while ((m = JAVA_TEST_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `java:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ framework: 'junit', kw: '@Test', kind: 'case', name: m[1] });
      totals.junit += 1;
    }
  }

  // Go
  if (entries.length < MAX_PER_FILE) {
    GO_TEST_RE.lastIndex = 0;
    while ((m = GO_TEST_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `go:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ framework: 'go-test', kw: 'func', kind: 'case', name: m[1] });
      totals.gotest += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildTestBlocksForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { group: 0, case: 0, hook: 0, pytest: 0, junit: 0, gotest: 0, rspec: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractTestBlocks(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.framework}:${e.name}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      const bucket = e.framework === 'pytest' ? 'pytest' :
                     e.framework === 'junit' ? 'junit' :
                     e.framework === 'go-test' ? 'gotest' : e.kind;
      if (totals[bucket] != null) totals[bucket] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderTestBlocksBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## TEST BLOCKS'];
  const t = report.totals || {};
  const parts = [];
  if (t.group) parts.push(`describe: ${t.group}`);
  if (t.case) parts.push(`it/test: ${t.case}`);
  if (t.hook) parts.push(`before/after: ${t.hook}`);
  if (t.pytest) parts.push(`pytest: ${t.pytest}`);
  if (t.junit) parts.push(`JUnit: ${t.junit}`);
  if (t.gotest) parts.push(`go-test: ${t.gotest}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- ${e.kw} \`${e.name}\` (${e.framework})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractTestBlocks,
  buildTestBlocksForFiles,
  renderTestBlocksBlock,
  _internal: { classifyKw },
};

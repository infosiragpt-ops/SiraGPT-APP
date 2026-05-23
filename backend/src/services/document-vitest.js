'use strict';

/**
 * document-vitest.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Vitest / Jest unit-test framework constructs:
 *
 *   - Test runners:   describe / test / it / suite + .only/.skip/.each/.todo
 *   - Lifecycle:      beforeEach / afterEach / beforeAll / afterAll
 *   - Matchers:       expect(X).toBe(Y) / toEqual / toMatch / toContain /
 *                     toHaveLength / toHaveProperty / toThrow / toBeCalled /
 *                     toBeInstanceOf / toBeNull / toBeUndefined / toBeTruthy / toBeFalsy /
 *                     resolves.toBe / rejects.toThrow / not.toBe
 *   - Mocks:          vi.fn() / vi.mock() / vi.spyOn() / vi.stubGlobal() / vi.useFakeTimers()
 *                     jest.fn() / jest.mock() / jest.spyOn() / jest.useFakeTimers()
 *   - Snapshots:      .toMatchSnapshot() / .toMatchInlineSnapshot()
 *
 * Public API:
 *   extractVitest(text)             → { entries, totals, total }
 *   buildVitestForFiles(files)      → { perFile, aggregate, totals }
 *   renderVitestBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;

const RUNNER_RE = /\b(describe|test|it|suite)(?:\.(only|skip|each|todo|concurrent|sequential))?\s*\(\s*(?:["'`]([^"'`\n]{1,200})["'`]|\[)/g;
const LIFECYCLE_RE = /\b(beforeEach|afterEach|beforeAll|afterAll|before|after)\s*\(/g;
const EXPECT_RE = /\bexpect(?:\.(soft|poll|element|hasAssertions))?\s*\(/g;
const MATCHER_RE = /\.(toBe|toEqual|toStrictEqual|toMatch|toMatchObject|toContain|toContainEqual|toHaveLength|toHaveProperty|toBeInstanceOf|toBeNull|toBeUndefined|toBeDefined|toBeTruthy|toBeFalsy|toBeCloseTo|toBeGreaterThan|toBeLessThan|toBeNaN|toThrow|toHaveBeenCalled|toHaveBeenCalledWith|toHaveBeenCalledTimes|toHaveReturned|toMatchSnapshot|toMatchInlineSnapshot)\b/g;
const NEGATION_RE = /\.(?:not|resolves|rejects)\.(to[A-Z][a-zA-Z]{2,30})/g;
const VI_MOCK_RE = /\b(?:vi|jest)\.(fn|mock|unmock|doMock|spyOn|stubGlobal|stubEnv|useFakeTimers|useRealTimers|advanceTimersByTime|runAllTimers|clearAllMocks|resetAllMocks|restoreAllMocks|setSystemTime|hoisted|importActual|importMock)\s*\(/g;
const SNAPSHOT_RE = /\.toMatchSnapshot\b|\.toMatchInlineSnapshot\b|toMatchFileSnapshot/g;

function detectFramework(body) {
  if (/\bvi\.(fn|mock|spyOn)\s*\(|from\s+['"]vitest['"]/.test(body)) return 'vitest';
  if (/\bjest\.(fn|mock|spyOn)\s*\(|from\s+['"]@jest\/globals['"]/.test(body)) return 'jest';
  return null;
}

function extractVitest(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const framework = detectFramework(body);
  if (!framework && !/\b(describe|test|it)\s*\(\s*["'`]|\bexpect\s*\(/.test(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    framework: 0, runner: 0, lifecycle: 0, expect: 0, matcher: 0,
    negation: 0, mock: 0, snapshot: 0,
  };
  if (framework) {
    entries.push({ kind: 'framework', name: framework, detail: null });
    totals.framework = 1;
  }

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  RUNNER_RE.lastIndex = 0;
  let m;
  while ((m = RUNNER_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const modifier = m[2] ? `.${m[2]}` : '';
    const title = m[3] ? m[3].slice(0, 50) : '<table>';
    push('runner', `${m[1]}${modifier}`, title);
  }
  if (entries.length < MAX_PER_FILE) {
    LIFECYCLE_RE.lastIndex = 0;
    while ((m = LIFECYCLE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('lifecycle', m[1], null);
    }
  }

  let expectCount = 0;
  EXPECT_RE.lastIndex = 0;
  while (EXPECT_RE.exec(body) && expectCount < 200) expectCount += 1;
  totals.expect = expectCount;

  if (entries.length < MAX_PER_FILE) {
    MATCHER_RE.lastIndex = 0;
    while ((m = MATCHER_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('matcher', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    NEGATION_RE.lastIndex = 0;
    while ((m = NEGATION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('negation', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    VI_MOCK_RE.lastIndex = 0;
    while ((m = VI_MOCK_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('mock', m[1], null);
    }
  }

  let snapCount = 0;
  SNAPSHOT_RE.lastIndex = 0;
  while (SNAPSHOT_RE.exec(body) && snapCount < 50) snapCount += 1;
  totals.snapshot = snapCount;
  if (snapCount && entries.length < MAX_PER_FILE) {
    entries.push({ kind: 'snapshot', name: 'snapshot', detail: `${snapCount} matcher(s)` });
  }

  return { entries, totals, total: entries.length };
}

function buildVitestForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    framework: 0, runner: 0, lifecycle: 0, expect: 0, matcher: 0,
    negation: 0, mock: 0, snapshot: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractVitest(txt);
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

function renderVitestBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## VITEST / JEST FRAMEWORK'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const det = e.detail ? ` — ${e.detail}` : '';
      lines.push(`- [${e.kind}] \`${e.name}\`${det}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractVitest,
  buildVitestForFiles,
  renderVitestBlock,
  _internal: { detectFramework },
};

'use strict';

/**
 * document-analyzer-resilience.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-block isolation, telemetry, and observability for the professional
 * document-analyzer pipeline. A single rogue analyzer (bad regex, malformed
 * Unicode, OOM) must never wipe out the rest of the enrichment — the chat
 * has to keep working with as many blocks as possible.
 *
 * These tests cover three layers:
 *  1. The pure runner helpers (`runAnalyzerSafe`, `createAnalyzerTelemetry`,
 *     `summarizeAnalyzerTelemetry`).
 *  2. End-to-end `buildEnrichedFileContext` against a synthetic document
 *     — verifies the public shape stays stable and telemetry is attached.
 *  3. The empty-file path returns the documented zero-state shape (so
 *     callers can rely on `analyzerTelemetry: null` as a sentinel).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const analyzer = require('../src/services/document-professional-analyzer');

// ──────────────────────────────────────────────────────────────────────────
// runAnalyzerSafe — base contract
// ──────────────────────────────────────────────────────────────────────────

test('runAnalyzerSafe returns the builder string on success', () => {
  const out = analyzer.runAnalyzerSafe('foo', () => 'hello', null);
  assert.equal(out, 'hello');
});

test('runAnalyzerSafe coerces non-string outputs to empty string', () => {
  assert.equal(analyzer.runAnalyzerSafe('a', () => null, null), '');
  assert.equal(analyzer.runAnalyzerSafe('b', () => undefined, null), '');
  assert.equal(analyzer.runAnalyzerSafe('c', () => 123, null), '');
  assert.equal(analyzer.runAnalyzerSafe('d', () => ({ foo: 1 }), null), '');
});

test('runAnalyzerSafe swallows thrown errors and returns empty string', () => {
  // silence console.warn for the test
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const out = analyzer.runAnalyzerSafe('boom', () => { throw new Error('catastrophic regex'); }, null);
    assert.equal(out, '');
  } finally {
    console.warn = originalWarn;
  }
});

test('runAnalyzerSafe handles non-Error throws (string, number, undefined)', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(analyzer.runAnalyzerSafe('s', () => { throw 'plain string'; }, null), '');
    assert.equal(analyzer.runAnalyzerSafe('n', () => { throw 42; }, null), '');
    // eslint-disable-next-line no-throw-literal
    assert.equal(analyzer.runAnalyzerSafe('u', () => { throw undefined; }, null), '');
  } finally {
    console.warn = originalWarn;
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Telemetry collection
// ──────────────────────────────────────────────────────────────────────────

test('createAnalyzerTelemetry returns a fresh empty bucket', () => {
  const t = analyzer.createAnalyzerTelemetry();
  assert.deepEqual(t.entries, []);
  assert.deepEqual(t.failures, []);
  assert.deepEqual(t.slow, []);
  assert.deepEqual(t.large, []);
  assert.equal(typeof t.slowMs, 'number');
  assert.equal(typeof t.largeChars, 'number');
  assert.equal(typeof t.startedAt, 'number');
});

test('runAnalyzerSafe records ok entries with elapsed + chars', () => {
  const t = analyzer.createAnalyzerTelemetry();
  analyzer.runAnalyzerSafe('greeter', () => 'hello world', t);
  assert.equal(t.entries.length, 1);
  assert.equal(t.entries[0].name, 'greeter');
  assert.equal(t.entries[0].ok, true);
  assert.equal(t.entries[0].chars, 'hello world'.length);
  assert.equal(typeof t.entries[0].elapsedMs, 'number');
  assert.equal(t.failures.length, 0);
});

test('runAnalyzerSafe records fail entries with message', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const t = analyzer.createAnalyzerTelemetry();
    analyzer.runAnalyzerSafe('broken', () => { throw new Error('nope'); }, t);
    assert.equal(t.entries.length, 1);
    assert.equal(t.entries[0].ok, false);
    assert.equal(t.entries[0].error, 'nope');
    assert.equal(t.failures.length, 1);
    assert.equal(t.failures[0].name, 'broken');
    assert.equal(t.failures[0].error, 'nope');
  } finally {
    console.warn = originalWarn;
  }
});

test('runAnalyzerSafe records slow blocks above threshold', () => {
  const t = analyzer.createAnalyzerTelemetry({ slowMs: 10 });
  analyzer.runAnalyzerSafe('slow', () => {
    const deadline = Date.now() + 25;
    while (Date.now() < deadline) { /* busy wait */ }
    return 'done';
  }, t);
  assert.equal(t.slow.length, 1);
  assert.equal(t.slow[0].name, 'slow');
  assert.ok(t.slow[0].elapsedMs >= 10);
});

test('runAnalyzerSafe records large blocks above char threshold', () => {
  const t = analyzer.createAnalyzerTelemetry({ largeChars: 100 });
  const big = 'x'.repeat(500);
  analyzer.runAnalyzerSafe('huge', () => big, t);
  assert.equal(t.large.length, 1);
  assert.equal(t.large[0].name, 'huge');
  assert.equal(t.large[0].chars, 500);
});

// ──────────────────────────────────────────────────────────────────────────
// summarizeAnalyzerTelemetry — rollup
// ──────────────────────────────────────────────────────────────────────────

test('summarizeAnalyzerTelemetry returns null for empty telemetry', () => {
  assert.equal(analyzer.summarizeAnalyzerTelemetry(null), null);
  assert.equal(analyzer.summarizeAnalyzerTelemetry(undefined), null);
  assert.equal(analyzer.summarizeAnalyzerTelemetry(analyzer.createAnalyzerTelemetry()), null);
});

test('summarizeAnalyzerTelemetry rolls up counts, chars, and slowest', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const t = analyzer.createAnalyzerTelemetry({ slowMs: 1, largeChars: 5 });
    analyzer.runAnalyzerSafe('a', () => 'aa', t);
    analyzer.runAnalyzerSafe('b', () => 'bbbb', t);
    analyzer.runAnalyzerSafe('c', () => { throw new Error('oops'); }, t);
    analyzer.runAnalyzerSafe('d', () => 'dddddd', t); // 6 chars > 5 → large
    const summary = analyzer.summarizeAnalyzerTelemetry(t);
    assert.equal(summary.blockCount, 4);
    assert.equal(summary.okCount, 3);
    assert.equal(summary.failCount, 1);
    assert.equal(summary.totalChars, 'aa'.length + 'bbbb'.length + 'dddddd'.length);
    assert.ok(Array.isArray(summary.slowest));
    assert.ok(summary.slowest.length <= 5);
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0].name, 'c');
    assert.equal(summary.largeBlocks.length, 1);
    assert.equal(summary.largeBlocks[0].name, 'd');
    assert.equal(typeof summary.durationMs, 'number');
    assert.ok(summary.durationMs >= 0);
  } finally {
    console.warn = originalWarn;
  }
});

test('summarizeAnalyzerTelemetry caps failures + slowBlocks at 10', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const t = analyzer.createAnalyzerTelemetry({ slowMs: 0 });
    for (let i = 0; i < 25; i += 1) {
      analyzer.runAnalyzerSafe(`fail-${i}`, () => { throw new Error(`e${i}`); }, t);
    }
    const summary = analyzer.summarizeAnalyzerTelemetry(t);
    assert.equal(summary.failures.length, 10);
    assert.equal(summary.failCount, 25);
  } finally {
    console.warn = originalWarn;
  }
});

// ──────────────────────────────────────────────────────────────────────────
// buildEnrichedFileContext — public-shape stability + telemetry attach
// ──────────────────────────────────────────────────────────────────────────

test('buildEnrichedFileContext: empty processedFiles returns the zero-state shape', async () => {
  const out = await analyzer.buildEnrichedFileContext({ prisma: null, processedFiles: [] });
  assert.equal(out.profileBlock, '');
  assert.equal(out.directiveBlock, '');
  assert.equal(out.primaryDocType, 'general_document');
  assert.deepEqual(out.perFileProfile, []);
  assert.equal(out.analyzerTelemetry, null);
});

test('buildEnrichedFileContext: produces all blocks for a small text file', async () => {
  const out = await analyzer.buildEnrichedFileContext({
    prisma: null,
    processedFiles: [{
      id: 'doc-1',
      originalName: 'contract.txt',
      mimeType: 'text/plain',
      extractedText: 'This Master Services Agreement is dated 2026-01-01 and signed by Acme Corp.\nTotal: $5,000.\nContact: jane@example.com',
    }],
  });
  assert.equal(typeof out.profileBlock, 'string');
  assert.equal(typeof out.directiveBlock, 'string');
  assert.equal(typeof out.insightsBlock, 'string');
  assert.ok(out.profileBlock.length > 0);
  assert.ok(out.directiveBlock.length > 0);
  assert.ok(typeof out.primaryDocType === 'string' && out.primaryDocType.length > 0);
});

test('buildEnrichedFileContext: attaches analyzerTelemetry with ok+fail counts', async () => {
  const out = await analyzer.buildEnrichedFileContext({
    prisma: null,
    processedFiles: [{
      id: 'doc-2',
      originalName: 'plain.txt',
      mimeType: 'text/plain',
      extractedText: 'Hello world. Date: 2026-05-18. URL: https://example.com',
    }],
  });
  const t = out.analyzerTelemetry;
  assert.ok(t, 'expected analyzerTelemetry to be present');
  assert.ok(t.blockCount > 100, `expected > 100 blocks, got ${t.blockCount}`);
  assert.equal(typeof t.okCount, 'number');
  assert.equal(typeof t.failCount, 'number');
  // Healthy baseline: ≥98% of analyzers must succeed against trivial input,
  // otherwise something has regressed in one of the underlying engines.
  const okRatio = t.okCount / t.blockCount;
  assert.ok(okRatio >= 0.98, `okRatio=${okRatio} below 0.98 (failures: ${JSON.stringify(t.failures)})`);
});

test('buildEnrichedFileContext: telemetry disabled when SIRAGPT_ANALYZER_TELEMETRY=0', async () => {
  const prev = process.env.SIRAGPT_ANALYZER_TELEMETRY;
  process.env.SIRAGPT_ANALYZER_TELEMETRY = '0';
  try {
    const out = await analyzer.buildEnrichedFileContext({
      prisma: null,
      processedFiles: [{
        id: 'doc-3',
        originalName: 'plain.txt',
        mimeType: 'text/plain',
        extractedText: 'Sample document body.',
      }],
    });
    assert.equal(out.analyzerTelemetry, null);
    // Pipeline still runs and returns blocks — telemetry is purely opt-in.
    assert.equal(typeof out.profileBlock, 'string');
  } finally {
    if (prev === undefined) delete process.env.SIRAGPT_ANALYZER_TELEMETRY;
    else process.env.SIRAGPT_ANALYZER_TELEMETRY = prev;
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Isolation under failure — the key property
// ──────────────────────────────────────────────────────────────────────────
// A thrown builder must not block the rest of the pipeline. We can't easily
// monkey-patch ~300 internal functions, but we CAN simulate the contract by
// running a synthetic builder set through `runAnalyzerSafe` and verifying
// the surviving blocks make it through.

test('isolation: one builder throws — the other 299 still run', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const t = analyzer.createAnalyzerTelemetry();
    const blocks = {};
    const N = 300;
    for (let i = 0; i < N; i += 1) {
      const name = `block-${i}`;
      const builder = i === 47
        ? () => { throw new Error('regex catastrophic backtracking'); }
        : () => `content-${i}`;
      blocks[name] = analyzer.runAnalyzerSafe(name, builder, t);
    }
    let okBlocks = 0;
    for (const v of Object.values(blocks)) if (v) okBlocks += 1;
    assert.equal(okBlocks, N - 1, 'all blocks except the throwing one should have content');
    assert.equal(blocks['block-47'], '');
    const summary = analyzer.summarizeAnalyzerTelemetry(t);
    assert.equal(summary.failCount, 1);
    assert.equal(summary.failures[0].name, 'block-47');
  } finally {
    console.warn = originalWarn;
  }
});

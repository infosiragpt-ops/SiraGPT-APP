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
    analyzer._internal.resetAnalyzerBreakers();
    const t = analyzer.createAnalyzerTelemetry();
    const blocks = {};
    const N = 300;
    for (let i = 0; i < N; i += 1) {
      const name = `iso-block-${i}`;
      const builder = i === 47
        ? () => { throw new Error('regex catastrophic backtracking'); }
        : () => `content-${i}`;
      blocks[name] = analyzer.runAnalyzerSafe(name, builder, t);
    }
    let okBlocks = 0;
    for (const v of Object.values(blocks)) if (v) okBlocks += 1;
    assert.equal(okBlocks, N - 1, 'all blocks except the throwing one should have content');
    assert.equal(blocks['iso-block-47'], '');
    const summary = analyzer.summarizeAnalyzerTelemetry(t);
    assert.equal(summary.failCount, 1);
    assert.equal(summary.failures[0].name, 'iso-block-47');
  } finally {
    console.warn = originalWarn;
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Circuit breaker — trips after N consecutive failures, cools down, recovers
// ──────────────────────────────────────────────────────────────────────────

test('breaker: trips after threshold consecutive failures', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    analyzer._internal.resetAnalyzerBreakers();
    const threshold = analyzer._internal.ANALYZER_BREAKER_THRESHOLD;
    const t = analyzer.createAnalyzerTelemetry();
    // Failures 1..threshold all invoke the builder.
    for (let i = 0; i < threshold; i += 1) {
      analyzer.runAnalyzerSafe('breaker-test', () => { throw new Error('regex'); }, t);
    }
    let invocations = 0;
    const out = analyzer.runAnalyzerSafe('breaker-test', () => { invocations += 1; return 'should-not-run'; }, t);
    assert.equal(out, '');
    assert.equal(invocations, 0, 'breaker must short-circuit before invoking builder');
    const summary = analyzer.summarizeAnalyzerTelemetry(t);
    assert.ok(summary.breakerOpen.length >= 1);
    assert.equal(summary.breakerOpen[0].name, 'breaker-test');
  } finally {
    console.warn = originalWarn;
  }
});

test('breaker: reset clears state and analyzer can run again', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    analyzer._internal.resetAnalyzerBreakers();
    const threshold = analyzer._internal.ANALYZER_BREAKER_THRESHOLD;
    const t = analyzer.createAnalyzerTelemetry();
    for (let i = 0; i < threshold; i += 1) {
      analyzer.runAnalyzerSafe('reset-test', () => { throw new Error('e'); }, t);
    }
    // Breaker should now be open
    const blocked = analyzer.runAnalyzerSafe('reset-test', () => 'noop', t);
    assert.equal(blocked, '');
    // After reset, the analyzer runs again
    analyzer._internal.resetAnalyzerBreakers();
    const out = analyzer.runAnalyzerSafe('reset-test', () => 'recovered', t);
    assert.equal(out, 'recovered');
  } finally {
    console.warn = originalWarn;
  }
});

test('breaker: success resets the consecutive-failure counter', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    analyzer._internal.resetAnalyzerBreakers();
    const threshold = analyzer._internal.ANALYZER_BREAKER_THRESHOLD;
    const t = analyzer.createAnalyzerTelemetry();
    // (threshold - 1) failures, then a success — should not trip.
    for (let i = 0; i < threshold - 1; i += 1) {
      analyzer.runAnalyzerSafe('flapper', () => { throw new Error('e'); }, t);
    }
    analyzer.runAnalyzerSafe('flapper', () => 'ok', t);
    // Now (threshold - 1) more failures must NOT yet trip (counter was reset)
    for (let i = 0; i < threshold - 1; i += 1) {
      analyzer.runAnalyzerSafe('flapper', () => { throw new Error('e'); }, t);
    }
    let invocations = 0;
    analyzer.runAnalyzerSafe('flapper', () => { invocations += 1; return 'check'; }, t);
    assert.equal(invocations, 1, 'breaker must NOT be open after success-reset');
  } finally {
    console.warn = originalWarn;
  }
});

test('breaker: per-name isolation — one tripped breaker does not block others', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    analyzer._internal.resetAnalyzerBreakers();
    const threshold = analyzer._internal.ANALYZER_BREAKER_THRESHOLD;
    const t = analyzer.createAnalyzerTelemetry();
    for (let i = 0; i < threshold; i += 1) {
      analyzer.runAnalyzerSafe('iso-breaker', () => { throw new Error('e'); }, t);
    }
    // 'iso-breaker' open, 'iso-clean' must still run.
    const a1 = analyzer.runAnalyzerSafe('iso-breaker', () => 'should-not-run', t);
    const a2 = analyzer.runAnalyzerSafe('iso-clean', () => 'still-fine', t);
    assert.equal(a1, '');
    assert.equal(a2, 'still-fine');
  } finally {
    console.warn = originalWarn;
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Deadline guard — wall-clock pipeline budget
// ──────────────────────────────────────────────────────────────────────────

test('deadline: skips analyzers after wall-clock budget exceeded', () => {
  analyzer._internal.resetAnalyzerBreakers();
  // 30 ms total budget; first analyzer burns 50 ms.
  const t = analyzer.createAnalyzerTelemetry({ deadlineMs: 30 });
  analyzer.runAnalyzerSafe('first', () => {
    const end = Date.now() + 50;
    while (Date.now() < end) { /* burn */ }
    return 'done';
  }, t);
  let invocations = 0;
  analyzer.runAnalyzerSafe('second', () => { invocations += 1; return 'skipped?'; }, t);
  analyzer.runAnalyzerSafe('third', () => { invocations += 1; return 'skipped?'; }, t);
  assert.equal(invocations, 0, 'second + third must be skipped after deadline');
  const summary = analyzer.summarizeAnalyzerTelemetry(t);
  assert.equal(summary.skippedCount, 2);
  assert.equal(summary.deadlineExceeded, true);
  assert.equal(summary.skipped[0].reason, 'deadline');
});

test('deadline: disabled when deadlineMs=0 — all analyzers run', () => {
  analyzer._internal.resetAnalyzerBreakers();
  const t = analyzer.createAnalyzerTelemetry({ deadlineMs: 0 });
  analyzer.runAnalyzerSafe('first', () => {
    const end = Date.now() + 20;
    while (Date.now() < end) {}
    return 'done';
  }, t);
  let invocations = 0;
  analyzer.runAnalyzerSafe('second', () => { invocations += 1; return 'ran'; }, t);
  assert.equal(invocations, 1, 'no deadline means second analyzer runs even after first was slow');
  const summary = analyzer.summarizeAnalyzerTelemetry(t);
  assert.equal(summary.skippedCount, 0);
  assert.equal(summary.deadlineExceeded, false);
});

test('deadline: skipped entries are summarised separately from failures', () => {
  analyzer._internal.resetAnalyzerBreakers();
  const t = analyzer.createAnalyzerTelemetry({ deadlineMs: 1 });
  analyzer.runAnalyzerSafe('first', () => {
    const end = Date.now() + 5;
    while (Date.now() < end) {}
    return 'a';
  }, t);
  analyzer.runAnalyzerSafe('second', () => 'b', t);
  analyzer.runAnalyzerSafe('third', () => 'c', t);
  const summary = analyzer.summarizeAnalyzerTelemetry(t);
  assert.equal(summary.failCount, 0, 'deadline skip is not a failure');
  assert.equal(summary.skippedCount, 2);
  assert.ok(summary.deadlineMs > 0);
});

// ──────────────────────────────────────────────────────────────────────────
// Per-file isolation — bad file alongside good file must not corrupt the
// good file's enrichment. The classification + per-file-profile phase
// historically threw out of the whole pipeline if a single file had a
// malformed shape.
// ──────────────────────────────────────────────────────────────────────────

test('per-file isolation: malformed file alongside good file — good file still enriched', async () => {
  analyzer._internal.resetAnalyzerBreakers();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const malformed = { id: 'bad-1', originalName: null, mimeType: undefined };
    const good = {
      id: 'good-1',
      originalName: 'contract.txt',
      mimeType: 'text/plain',
      extractedText: 'Master Services Agreement dated 2026-05-18. Total: $5,000.',
    };
    const out = await analyzer.buildEnrichedFileContext({
      prisma: null,
      processedFiles: [malformed, good],
    });
    assert.ok(out.profileBlock.length > 0, 'good file must still produce a profile block');
    assert.ok(typeof out.primaryDocType === 'string' && out.primaryDocType.length > 0);
    assert.equal(out.perFileProfile.length, 2);
    assert.equal(out.analyzerTelemetry.blockCount, 312, 'all analyzer blocks must still run');
  } finally {
    console.warn = originalWarn;
  }
});

test('per-file isolation: file with extractedText getter that throws', async () => {
  analyzer._internal.resetAnalyzerBreakers();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const exploding = {
      id: 'explode',
      originalName: 'explode.txt',
      mimeType: 'text/plain',
      get extractedText() { throw new Error('storage layer crashed'); },
    };
    const good = {
      id: 'good-2',
      originalName: 'plain.txt',
      mimeType: 'text/plain',
      extractedText: 'A short document for parsing.',
    };
    // Must not throw out of `buildEnrichedFileContext`.
    const out = await analyzer.buildEnrichedFileContext({
      prisma: null,
      processedFiles: [exploding, good],
    });
    // The good file's classification + profile MUST land. The exploding
    // file falls back to general_document with empty profile.
    assert.equal(out.perFileProfile.length, 2);
    assert.ok(out.profileBlock.length > 0);
    // We don't pin the exact primaryDocType here — what matters is the
    // pipeline didn't throw and the structured output is well-formed.
    assert.equal(typeof out.primaryDocType, 'string');
  } finally {
    console.warn = originalWarn;
  }
});

test('per-file isolation: empty processedFiles still produces zero-state shape', async () => {
  analyzer._internal.resetAnalyzerBreakers();
  const out = await analyzer.buildEnrichedFileContext({ prisma: null, processedFiles: [] });
  assert.equal(out.profileBlock, '');
  assert.equal(out.directiveBlock, '');
  assert.deepEqual(out.perFileProfile, []);
  assert.equal(out.analyzerTelemetry, null);
});

// ──────────────────────────────────────────────────────────────────────────
// getAnalyzerHealthSnapshot — operational visibility for ops/admin
// ──────────────────────────────────────────────────────────────────────────

test('health snapshot: clean state has empty open + degraded lists', () => {
  analyzer._internal.resetAnalyzerBreakers();
  const snap = analyzer.getAnalyzerHealthSnapshot();
  assert.deepEqual(snap.openBreakers, []);
  assert.deepEqual(snap.degradedAnalyzers, []);
  assert.equal(typeof snap.config.breakerThreshold, 'number');
  assert.equal(typeof snap.config.breakerCooldownMs, 'number');
  assert.equal(typeof snap.capturedAt, 'number');
});

test('health snapshot: degraded analyzer (failures below threshold)', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    analyzer._internal.resetAnalyzerBreakers();
    const threshold = analyzer._internal.ANALYZER_BREAKER_THRESHOLD;
    const t = analyzer.createAnalyzerTelemetry();
    // (threshold - 2) failures — not enough to trip, should appear as degraded.
    for (let i = 0; i < threshold - 2; i += 1) {
      analyzer.runAnalyzerSafe('flaky', () => { throw new Error('e'); }, t);
    }
    const snap = analyzer.getAnalyzerHealthSnapshot();
    assert.equal(snap.openBreakers.length, 0);
    assert.equal(snap.degradedAnalyzers.length, 1);
    assert.equal(snap.degradedAnalyzers[0].name, 'flaky');
    assert.equal(snap.degradedAnalyzers[0].consecutiveFailures, threshold - 2);
  } finally {
    console.warn = originalWarn;
  }
});

test('health snapshot: open breaker with cooldown details', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    analyzer._internal.resetAnalyzerBreakers();
    const threshold = analyzer._internal.ANALYZER_BREAKER_THRESHOLD;
    const cooldown = analyzer._internal.ANALYZER_BREAKER_COOLDOWN_MS;
    const t = analyzer.createAnalyzerTelemetry();
    for (let i = 0; i < threshold; i += 1) {
      analyzer.runAnalyzerSafe('trip-me', () => { throw new Error('e'); }, t);
    }
    const snap = analyzer.getAnalyzerHealthSnapshot();
    assert.equal(snap.openBreakers.length, 1);
    const entry = snap.openBreakers[0];
    assert.equal(entry.name, 'trip-me');
    assert.equal(entry.consecutiveFailures, threshold);
    assert.ok(entry.cooldownMsRemaining > 0);
    assert.ok(entry.cooldownMsRemaining <= cooldown);
    assert.equal(entry.closesAt - entry.opensAt, cooldown);
  } finally {
    console.warn = originalWarn;
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Content-hash cache integration — cacheKey wires runAnalyzerSafe into
// `document-analyzer-cache` so re-attached files short-circuit.
// ──────────────────────────────────────────────────────────────────────────

test('cache: same cacheKey twice returns cached value, builder runs once', () => {
  const cache = require('../src/services/document-analyzer-cache');
  cache.reset();
  analyzer._internal.resetAnalyzerBreakers();
  const t = analyzer.createAnalyzerTelemetry();
  let builds = 0;
  const out1 = analyzer.runAnalyzerSafe('cached-block', () => { builds += 1; return 'hello'; }, t, 'key-A');
  const out2 = analyzer.runAnalyzerSafe('cached-block', () => { builds += 1; return 'hello'; }, t, 'key-A');
  assert.equal(out1, 'hello');
  assert.equal(out2, 'hello');
  assert.equal(builds, 1, 'builder must only run on the first call');
  // Second telemetry entry has `cached: true` flag.
  const entries = t.entries.filter((e) => e.name === 'cached-block');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].cached, undefined);
  assert.equal(entries[1].cached, true);
});

test('cache: different cacheKey forces a re-build', () => {
  const cache = require('../src/services/document-analyzer-cache');
  cache.reset();
  analyzer._internal.resetAnalyzerBreakers();
  let builds = 0;
  analyzer.runAnalyzerSafe('keyed', () => { builds += 1; return 'A'; }, null, 'k-A');
  analyzer.runAnalyzerSafe('keyed', () => { builds += 1; return 'B'; }, null, 'k-B');
  assert.equal(builds, 2);
});

test('cache: no cacheKey arg means no caching', () => {
  const cache = require('../src/services/document-analyzer-cache');
  cache.reset();
  analyzer._internal.resetAnalyzerBreakers();
  let builds = 0;
  analyzer.runAnalyzerSafe('noncached', () => { builds += 1; return 'X'; }, null);
  analyzer.runAnalyzerSafe('noncached', () => { builds += 1; return 'X'; }, null);
  assert.equal(builds, 2);
  const stats = cache.stats();
  assert.equal(stats.size, 0, 'cache must remain empty when no key is provided');
});

test('cache: errors are never cached (transient failures retried next turn)', () => {
  const cache = require('../src/services/document-analyzer-cache');
  cache.reset();
  analyzer._internal.resetAnalyzerBreakers();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    let builds = 0;
    const fn = () => { builds += 1; if (builds === 1) throw new Error('transient'); return 'recovered'; };
    const out1 = analyzer.runAnalyzerSafe('flaky-cached', fn, null, 'k-flaky');
    const out2 = analyzer.runAnalyzerSafe('flaky-cached', fn, null, 'k-flaky');
    assert.equal(out1, '', 'first call failed → empty output, NOT cached');
    assert.equal(out2, 'recovered', 'second call succeeded — builder ran again');
    assert.equal(builds, 2);
  } finally {
    console.warn = originalWarn;
  }
});

test('cache: buildEnrichedFileContext second turn with same file hits cache', async () => {
  const cache = require('../src/services/document-analyzer-cache');
  cache.reset();
  analyzer._internal.resetAnalyzerBreakers();
  const file = {
    id: 'doc-A',
    originalName: 'paper.txt',
    mimeType: 'text/plain',
    extractedText: 'Research paper on cache-coherence protocols. Date: 2026-05-18.',
  };
  const a1 = await analyzer.buildEnrichedFileContext({ prisma: null, processedFiles: [file] });
  // Snapshot cache stats after the first turn — this is the baseline
  // we'll compare against. The second turn must produce additional
  // hits (cache was consulted and answered) and must NOT increase
  // misses by the same amount (i.e. analyzers re-running from scratch).
  const statsAfterFirst = {
    size: cache.stats().size,
    hits: cache.stats().hits,
    misses: cache.stats().misses,
  };
  const a2 = await analyzer.buildEnrichedFileContext({ prisma: null, processedFiles: [file] });
  const statsAfterSecond = cache.stats();
  // Sanity — both runs produce all 312 blocks.
  assert.equal(a1.analyzerTelemetry.blockCount, 312);
  assert.equal(a2.analyzerTelemetry.blockCount, 312);
  // First turn populated the cache.
  assert.ok(statsAfterFirst.size > 100, `cache size ${statsAfterFirst.size} should exceed 100 entries after first turn`);
  // Behavioral assertion (deterministic, no timing):
  // The second turn MUST register cache hits — this is the only way
  // to know caching worked. Each cached analyzer call on the 2nd turn
  // produces a hit instead of a miss.
  const hitsDelta = statsAfterSecond.hits - statsAfterFirst.hits;
  const missesDelta = statsAfterSecond.misses - statsAfterFirst.misses;
  assert.ok(
    hitsDelta > 100,
    `expected second turn to register >100 cache hits, got ${hitsDelta} (hits before=${statsAfterFirst.hits}, after=${statsAfterSecond.hits})`,
  );
  // And the cache should not have grown materially — the same keys
  // should be answering. A small delta (≤5%) tolerates non-memoized
  // helpers that legitimately allocate per-turn.
  const sizeGrowth = statsAfterSecond.size - statsAfterFirst.size;
  assert.ok(
    sizeGrowth <= Math.max(5, Math.floor(statsAfterFirst.size * 0.05)),
    `cache should not balloon on 2nd turn: grew by ${sizeGrowth} (from ${statsAfterFirst.size} → ${statsAfterSecond.size})`,
  );
  // Hits should dominate misses on the second turn (cache is doing work).
  assert.ok(
    hitsDelta > missesDelta,
    `expected hits (${hitsDelta}) > misses (${missesDelta}) on 2nd turn`,
  );
  // Output is byte-equal for cached blocks — proves cache returns
  // the same value rather than re-computing a structurally-identical one.
  assert.equal(a1.insightsBlock, a2.insightsBlock);
  assert.equal(a1.piiSafetyBlock, a2.piiSafetyBlock);
  assert.equal(a1.glossaryBlock, a2.glossaryBlock);
});

test('cache: SIRAGPT_ANALYZER_CACHE=0 disables caching entirely', async () => {
  const cache = require('../src/services/document-analyzer-cache');
  cache.reset();
  analyzer._internal.resetAnalyzerBreakers();
  const prev = process.env.SIRAGPT_ANALYZER_CACHE;
  process.env.SIRAGPT_ANALYZER_CACHE = '0';
  try {
    const file = {
      id: 'doc-B',
      originalName: 'short.txt',
      mimeType: 'text/plain',
      extractedText: 'A short sample.',
    };
    await analyzer.buildEnrichedFileContext({ prisma: null, processedFiles: [file] });
    await analyzer.buildEnrichedFileContext({ prisma: null, processedFiles: [file] });
    const stats = cache.stats();
    assert.equal(stats.size, 0, 'cache must remain empty when SIRAGPT_ANALYZER_CACHE=0');
    assert.equal(stats.hits, 0);
  } finally {
    if (prev === undefined) delete process.env.SIRAGPT_ANALYZER_CACHE;
    else process.env.SIRAGPT_ANALYZER_CACHE = prev;
  }
});

// ──────────────────────────────────────────────────────────────────────────
// getAnalyzerHealthSnapshot.cache + clearAnalyzerCache — ops surface
// ──────────────────────────────────────────────────────────────────────────

test('health snapshot: includes cache stats sub-object', async () => {
  const cache = require('../src/services/document-analyzer-cache');
  cache.reset();
  analyzer._internal.resetAnalyzerBreakers();
  const file = {
    id: 'doc-cache-1',
    originalName: 'sample.txt',
    mimeType: 'text/plain',
    extractedText: 'A sample for cache testing.',
  };
  // First call → misses; second → hits.
  await analyzer.buildEnrichedFileContext({ prisma: null, processedFiles: [file] });
  await analyzer.buildEnrichedFileContext({ prisma: null, processedFiles: [file] });
  const snap = analyzer.getAnalyzerHealthSnapshot();
  assert.ok(snap.cache, 'snapshot.cache must be present');
  assert.ok(snap.cache.size > 0, `snapshot.cache.size ${snap.cache.size} should be > 0`);
  assert.ok(snap.cache.hits > 0, `snapshot.cache.hits ${snap.cache.hits} should be > 0`);
  assert.ok(snap.cache.ratio > 0);
  assert.ok(snap.cache.ratio <= 1);
});

test('clearAnalyzerCache: wipes cache and returns pre-clear stats', async () => {
  const cache = require('../src/services/document-analyzer-cache');
  cache.reset();
  analyzer._internal.resetAnalyzerBreakers();
  // Prime the cache.
  const file = {
    id: 'doc-cache-2',
    originalName: 'primer.txt',
    mimeType: 'text/plain',
    extractedText: 'Some content to populate the analyzer cache.',
  };
  await analyzer.buildEnrichedFileContext({ prisma: null, processedFiles: [file] });
  const sizeBefore = cache.stats().size;
  assert.ok(sizeBefore > 0, 'cache must have entries before clearing');
  const result = analyzer.clearAnalyzerCache();
  assert.equal(result.cleared, true);
  assert.ok(result.before, 'before snapshot must be returned');
  assert.equal(result.before.size, sizeBefore);
  // After clear, cache must be empty.
  assert.equal(cache.stats().size, 0);
});

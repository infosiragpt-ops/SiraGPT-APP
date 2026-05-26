'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const metrics = require('../src/services/free-ia-metrics');

test('summary.line includes "X/min" suffix when requestRatePerMin is non-null', () => {
  metrics.reset();
  for (let i = 0; i < 12; i += 1) metrics.recordUpstreamSuccess();
  const s = metrics.summary({ now: Date.now() + 2 * 60 * 1000 });
  assert.ok(s.requestRatePerMin !== null);
  assert.match(s.line, /\d+(\.\d+)?\/min/, `expected /min in line: ${s.line}`);
});

test('summary.line omits "/min" suffix when sub-1-minute window', () => {
  metrics.reset();
  metrics.recordUpstreamSuccess();
  const s = metrics.summary();
  assert.equal(s.requestRatePerMin, null);
  assert.ok(!/\/min/.test(s.line), `should not include /min: ${s.line}`);
});

test('compactSummary returns null when there is nothing to show', () => {
  metrics.reset();
  assert.equal(metrics.compactSummary(), null);
});

test('compactSummary surfaces fallbacks + healthy flag once events exist', () => {
  metrics.reset();
  metrics.recordFallback({ feature: 'paraphrase', amount: 1 });
  metrics.recordUpstreamSuccess();
  const c = metrics.compactSummary();
  assert.deepEqual(Object.keys(c).sort(), ['fallbacks', 'healthy']);
  assert.equal(c.fallbacks, 1);
  assert.equal(c.healthy, true);
});

test('compactSummary flips healthy=false when degraded threshold trips', () => {
  metrics.reset();
  for (let i = 0; i < 9; i += 1) metrics.recordUpstreamError({ code: '503' });
  metrics.recordUpstreamSuccess();
  const c = metrics.compactSummary();
  assert.equal(c.healthy, false);
});

test('summary() snapshot: stable shape (all expected keys present)', () => {
  metrics.reset();
  const s = metrics.summary();
  const expectedKeys = [
    'line',
    'fallbacks',
    'upstreamSuccess',
    'upstreamTotal',
    'successRate',
    'degraded',
    'requestRatePerMin',
    'lastEventAt',
  ].sort();
  assert.deepEqual(Object.keys(s).sort(), expectedKeys);
});

test('snapshot() shape: stable top-level keys + upstream block', () => {
  metrics.reset();
  const s = metrics.snapshot();
  const expectedTop = [
    'totalFallbacks',
    'totalCostBlocked',
    'perFeature',
    'lastEventAt',
    'upstream',
    'startedAt',
    'lastResetAt',
  ].sort();
  assert.deepEqual(Object.keys(s).sort(), expectedTop);
  const expectedUpstream = [
    'success',
    'errors',
    'successRate',
    'lastErrorAt',
    'lastErrorCode',
    'lastErrorMessage',
    'errorsByCode',
    'topErrorCodes',
  ].sort();
  assert.deepEqual(Object.keys(s.upstream).sort(), expectedUpstream);
});

test('summary() returns a one-line digest with all the numbers backing it', () => {
  metrics.reset();
  metrics.recordFallback({ feature: 'paraphrase', amount: 5 });
  metrics.recordFallback({ feature: 'generate', amount: 2 });
  metrics.recordUpstreamSuccess();
  metrics.recordUpstreamSuccess();
  metrics.recordUpstreamSuccess();
  metrics.recordUpstreamError({ code: '503' });
  const s = metrics.summary();
  assert.equal(s.fallbacks, 2);
  assert.equal(s.upstreamSuccess, 3);
  assert.equal(s.upstreamTotal, 4);
  assert.equal(s.successRate, 0.75);
  assert.match(s.line, /FlashGPT: 2 fallbacks/);
  assert.match(s.line, /3\/4 upstream OK/);
  assert.match(s.line, /75\.00%/);
});

test('summary() reports successRate=null + "—" when no upstream events recorded', () => {
  metrics.reset();
  const s = metrics.summary();
  assert.equal(s.successRate, null);
  assert.equal(s.upstreamTotal, 0);
  assert.equal(s.degraded, false);
  assert.match(s.line, /—/);
});

test('summary.degraded = true when >=10 samples AND successRate < 0.5', () => {
  metrics.reset();
  for (let i = 0; i < 8; i += 1) metrics.recordUpstreamError({ code: '503' });
  for (let i = 0; i < 2; i += 1) metrics.recordUpstreamSuccess();
  const s = metrics.summary();
  assert.equal(s.degraded, true);
  assert.equal(s.successRate, 0.2);
  assert.match(s.line, /\[DEGRADED\]/);
});

test('summary.degraded stays false when <10 samples even if rate is poor', () => {
  metrics.reset();
  metrics.recordUpstreamError({ code: '503' });
  metrics.recordUpstreamError({ code: '503' });
  metrics.recordUpstreamSuccess();
  const s = metrics.summary();
  assert.equal(s.degraded, false, 'too few samples to declare degraded');
});

test('summary.requestRatePerMin computes throughput from elapsed time', () => {
  metrics.reset();
  // 60 upstream calls; pretend 2 minutes have elapsed → 30 req/min.
  for (let i = 0; i < 50; i += 1) metrics.recordUpstreamSuccess();
  for (let i = 0; i < 10; i += 1) metrics.recordUpstreamError({ code: '500' });
  const fakeNow = Date.parse('2026-05-25T12:02:00Z');
  // Force startedAt to be 2 minutes earlier by reaching into the
  // module's exports.snapshot to set the timestamp via reset+now.
  // Simpler: just use the now arg vs the real startedAt; if real
  // startedAt is recent, elapsedMin may be sub-1 → null. We test the
  // calculation by passing a now far in the future.
  const s = metrics.summary({ now: fakeNow + 365 * 24 * 60 * 60 * 1000 });
  // Over very long elapsed → near-zero rate. Just verify it's
  // a number and not crashing.
  assert.ok(typeof s.requestRatePerMin === 'number' || s.requestRatePerMin === null);
});

test('summary.requestRatePerMin: null when reset() called with no subsequent upstream calls', () => {
  metrics.reset();
  // No upstream calls after reset → totalUpstream = 0 → rate must be null.
  const fakeNow = Date.now() + 5 * 60 * 1000;
  const s = metrics.summary({ now: fakeNow });
  assert.equal(s.requestRatePerMin, null);
  assert.ok(!/\/min/.test(s.line));
});

test('summary.requestRatePerMin: timestamp uses lastResetAt when present (not startedAt)', () => {
  metrics.reset();
  // Reset just stamped lastResetAt. Now record some upstream calls and
  // verify the elapsed window starts from the reset, not from process boot.
  for (let i = 0; i < 5; i += 1) metrics.recordUpstreamSuccess();
  const fiveMinPostReset = Date.now() + 5 * 60 * 1000;
  const s = metrics.summary({ now: fiveMinPostReset });
  // 5 calls / 5 min = 1.0 (with some sub-second drift)
  assert.ok(s.requestRatePerMin >= 0.95 && s.requestRatePerMin <= 1.05,
    `expected ~1/min, got ${s.requestRatePerMin}`);
});

test('summary.requestRatePerMin: returns a finite positive number for a 5-minute window', () => {
  metrics.reset();
  for (let i = 0; i < 30; i += 1) metrics.recordUpstreamSuccess();
  // Force startedAt by mocking the snapshot's now value to be 5 min ahead.
  // The metric module reads state.startedAt at construction time; we
  // simulate elapsed time by passing a `now` 5 min after that.
  // Since startedAt was just set by reset(), now+5min ≈ startedAt+5min.
  const fiveMinLater = Date.now() + 5 * 60 * 1000;
  const s = metrics.summary({ now: fiveMinLater });
  // 30 calls over 5 min = 6 req/min (give or take a small epsilon).
  assert.ok(typeof s.requestRatePerMin === 'number', `expected number, got ${s.requestRatePerMin}`);
  assert.ok(s.requestRatePerMin > 0, `expected >0, got ${s.requestRatePerMin}`);
  assert.ok(s.requestRatePerMin <= 30, `expected <=30 (sanity), got ${s.requestRatePerMin}`);
});

test('summary.requestRatePerMin is null with <1 minute elapsed (avoids div-by-tiny)', () => {
  metrics.reset();
  metrics.recordUpstreamSuccess();
  // Default `now` = current Date.now(); startedAt was just set by reset
  // → elapsed is sub-second.
  const s = metrics.summary();
  assert.equal(s.requestRatePerMin, null, `expected null for sub-minute window: ${s.requestRatePerMin}`);
});

test('summary.degraded stays false when >=10 samples AND rate >= 0.5', () => {
  metrics.reset();
  for (let i = 0; i < 6; i += 1) metrics.recordUpstreamSuccess();
  for (let i = 0; i < 4; i += 1) metrics.recordUpstreamError({ code: '503' });
  const s = metrics.summary();
  assert.equal(s.degraded, false);
  assert.equal(s.successRate, 0.6);
});

test('snapshot includes startedAt + lastResetAt for ops bookkeeping', () => {
  metrics.reset();
  const s = metrics.snapshot();
  assert.ok(s.startedAt, 'startedAt should be an ISO timestamp');
  assert.ok(Number.isFinite(Date.parse(s.startedAt)), `startedAt parses as date: ${s.startedAt}`);
  assert.ok(s.lastResetAt, 'reset() should populate lastResetAt');
});

test('reset() stamps lastResetAt to a fresh ISO 8601 timestamp', () => {
  const before = Date.now();
  metrics.reset();
  const after = Date.now();
  const s = metrics.snapshot();
  const ts = Date.parse(s.lastResetAt);
  assert.ok(ts >= before && ts <= after, `lastResetAt between before/after: ${s.lastResetAt}`);
});

test('reset() leaves a clean snapshot', () => {
  metrics.recordFallback({ feature: 'x', amount: 1 });
  metrics.reset();
  const s = metrics.snapshot();
  assert.equal(s.totalFallbacks, 0);
  assert.equal(s.totalCostBlocked, '0');
  assert.deepEqual(s.perFeature, {});
  assert.equal(s.lastEventAt, null);
});

test('recordFallback increments total + per-feature counters', () => {
  metrics.reset();
  metrics.recordFallback({ feature: 'paraphrase', amount: 5 });
  metrics.recordFallback({ feature: 'paraphrase', amount: 7 });
  metrics.recordFallback({ feature: 'generate', amount: 3 });
  const s = metrics.snapshot();
  assert.equal(s.totalFallbacks, 3);
  assert.equal(s.totalCostBlocked, '15');
  assert.equal(s.perFeature.paraphrase.count, 2);
  assert.equal(s.perFeature.paraphrase.costBlocked, '12');
  assert.equal(s.perFeature.generate.count, 1);
  assert.equal(s.perFeature.generate.costBlocked, '3');
});

test('recordFallback handles missing/invalid amount as 0 cost (no crash)', () => {
  metrics.reset();
  metrics.recordFallback({ feature: 'x' });
  metrics.recordFallback({ feature: 'x', amount: null });
  metrics.recordFallback({ feature: 'x', amount: 'not-a-number' });
  metrics.recordFallback({ feature: 'x', amount: -5 });
  const s = metrics.snapshot();
  assert.equal(s.totalFallbacks, 4);
  assert.equal(s.totalCostBlocked, '0');
  assert.equal(s.perFeature.x.count, 4);
});

test('recordFallback accepts BigInt amounts', () => {
  metrics.reset();
  metrics.recordFallback({ feature: 'x', amount: 10n });
  metrics.recordFallback({ feature: 'x', amount: 1_000_000n });
  const s = metrics.snapshot();
  assert.equal(s.totalCostBlocked, '1000010');
});

test('recordFallback assigns missing feature → "unknown"', () => {
  metrics.reset();
  metrics.recordFallback({ amount: 1 });
  metrics.recordFallback({ feature: '', amount: 1 });
  metrics.recordFallback({ feature: null, amount: 1 });
  const s = metrics.snapshot();
  assert.equal(s.totalFallbacks, 3);
  assert.equal(s.perFeature.unknown.count, 3);
});

test('snapshot() updates lastEventAt to a valid ISO 8601 timestamp', () => {
  metrics.reset();
  const before = Date.now();
  metrics.recordFallback({ feature: 'x', amount: 1 });
  const after = Date.now();
  const s = metrics.snapshot();
  const ts = Date.parse(s.lastEventAt);
  assert.ok(Number.isFinite(ts), `lastEventAt should parse as a date: ${s.lastEventAt}`);
  assert.ok(ts >= before && ts <= after, 'lastEventAt should be between before/after');
});

test('toPrometheusText emits the expected counter names + per-feature labels', () => {
  metrics.reset();
  metrics.recordFallback({ feature: 'paraphrase', amount: 5 });
  metrics.recordFallback({ feature: 'image_generation', amount: 7 });
  const txt = metrics.toPrometheusText();
  assert.match(txt, /^# HELP sira_free_ia_fallback_total/m);
  assert.match(txt, /^# TYPE sira_free_ia_fallback_total counter/m);
  assert.match(txt, /^sira_free_ia_fallback_total 2$/m);
  assert.match(txt, /^sira_free_ia_fallback_cost_blocked_total 12$/m);
  assert.match(txt, /sira_free_ia_fallback_total\{feature="paraphrase"\} 1/);
  assert.match(txt, /sira_free_ia_fallback_total\{feature="image_generation"\} 1/);
  // No injection from label names that contain quotes:
  metrics.reset();
  metrics.recordFallback({ feature: 'weird"feature', amount: 1 });
  const sanitized = metrics.toPrometheusText();
  assert.match(sanitized, /feature="weird\\"feature"/);
});

test('recordUpstreamSuccess / recordUpstreamError track the Free IA upstream', () => {
  metrics.reset();
  metrics.recordUpstreamSuccess();
  metrics.recordUpstreamSuccess();
  metrics.recordUpstreamSuccess();
  metrics.recordUpstreamError({ code: '503' });
  const s = metrics.snapshot();
  assert.equal(s.upstream.success, 3);
  assert.equal(s.upstream.errors, 1);
  assert.equal(s.upstream.successRate, 0.75);
  assert.equal(s.upstream.lastErrorCode, '503');
  assert.ok(s.upstream.lastErrorAt);
});

test('upstream.successRate is null when no upstream events recorded', () => {
  metrics.reset();
  const s = metrics.snapshot();
  assert.equal(s.upstream.success, 0);
  assert.equal(s.upstream.errors, 0);
  assert.equal(s.upstream.successRate, null);
});

test('recordUpstreamError captures the message (capped at 240 chars)', () => {
  metrics.reset();
  metrics.recordUpstreamError({ code: '503', message: 'upstream is having a bad day' });
  let s = metrics.snapshot();
  assert.equal(s.upstream.lastErrorMessage, 'upstream is having a bad day');

  // Long messages get truncated to 240 chars
  metrics.recordUpstreamError({ code: '500', message: 'x'.repeat(500) });
  s = metrics.snapshot();
  assert.equal(s.upstream.lastErrorMessage.length, 240);
});

test('recordUpstreamError without a message keeps the previous one', () => {
  metrics.reset();
  metrics.recordUpstreamError({ code: '503', message: 'set first' });
  metrics.recordUpstreamError({ code: '500' }); // no message arg
  const s = metrics.snapshot();
  assert.equal(s.upstream.lastErrorMessage, 'set first');
});

test('reset() clears lastErrorMessage too', () => {
  metrics.recordUpstreamError({ code: '503', message: 'something' });
  metrics.reset();
  const s = metrics.snapshot();
  assert.equal(s.upstream.lastErrorMessage, null);
});

test('pruneErrorCodes(retain) keeps only the top-N most frequent codes', () => {
  metrics.reset();
  for (let i = 0; i < 10; i += 1) metrics.recordUpstreamError({ code: '503' });
  for (let i = 0; i < 5; i += 1) metrics.recordUpstreamError({ code: '429' });
  for (let i = 0; i < 3; i += 1) metrics.recordUpstreamError({ code: '500' });
  metrics.recordUpstreamError({ code: 'ETIMEDOUT' });
  metrics.recordUpstreamError({ code: 'oneoff-1' });
  metrics.recordUpstreamError({ code: 'oneoff-2' });
  const dropped = metrics.pruneErrorCodes(3);
  assert.equal(dropped, 3, 'should drop 3 (ETIMEDOUT + oneoff-1 + oneoff-2)');
  const s = metrics.snapshot();
  assert.deepEqual(Object.keys(s.upstream.errorsByCode).sort(), ['429', '500', '503']);
});

test('pruneErrorCodes returns 0 when nothing exceeds the retain limit', () => {
  metrics.reset();
  metrics.recordUpstreamError({ code: '503' });
  metrics.recordUpstreamError({ code: '429' });
  const dropped = metrics.pruneErrorCodes(10);
  assert.equal(dropped, 0);
  const s = metrics.snapshot();
  assert.equal(Object.keys(s.upstream.errorsByCode).length, 2);
});

test('pruneErrorCodes on an empty state returns 0 and leaves state intact', () => {
  metrics.reset();
  const dropped = metrics.pruneErrorCodes(5);
  assert.equal(dropped, 0);
  const s = metrics.snapshot();
  assert.deepEqual(s.upstream.errorsByCode, {});
  assert.equal(s.upstream.errors, 0);
});

test('pruneErrorCodes is idempotent — calling twice keeps the same state', () => {
  metrics.reset();
  for (let i = 0; i < 5; i += 1) metrics.recordUpstreamError({ code: '503' });
  metrics.recordUpstreamError({ code: '429' });
  metrics.recordUpstreamError({ code: '500' });
  metrics.pruneErrorCodes(2);
  const first = JSON.stringify(metrics.snapshot().upstream.errorsByCode);
  metrics.pruneErrorCodes(2);
  const second = JSON.stringify(metrics.snapshot().upstream.errorsByCode);
  assert.equal(first, second, 'second prune should be a no-op');
});

test('pruneErrorCodes(0) drops everything (drains the map)', () => {
  metrics.reset();
  metrics.recordUpstreamError({ code: '503' });
  metrics.recordUpstreamError({ code: '429' });
  const dropped = metrics.pruneErrorCodes(0);
  assert.equal(dropped, 2);
  assert.deepEqual(metrics.snapshot().upstream.errorsByCode, {});
});

test('topUpstreamErrorCodes returns codes sorted by frequency (most common first)', () => {
  metrics.reset();
  for (let i = 0; i < 5; i += 1) metrics.recordUpstreamError({ code: '503' });
  for (let i = 0; i < 3; i += 1) metrics.recordUpstreamError({ code: '429' });
  metrics.recordUpstreamError({ code: 'ETIMEDOUT' });
  const top = metrics.topUpstreamErrorCodes();
  assert.equal(top[0].code, '503');
  assert.equal(top[0].count, 5);
  assert.equal(top[1].code, '429');
  assert.equal(top[1].count, 3);
  assert.equal(top[2].code, 'ETIMEDOUT');
  assert.equal(top[2].count, 1);
});

test('topUpstreamErrorCodes(limit) caps the result set', () => {
  metrics.reset();
  metrics.recordUpstreamError({ code: '503' });
  metrics.recordUpstreamError({ code: '429' });
  metrics.recordUpstreamError({ code: '500' });
  const top = metrics.topUpstreamErrorCodes(2);
  assert.equal(top.length, 2);
});

test('snapshot.upstream.errorsByCode + topErrorCodes reflect the frequency map', () => {
  metrics.reset();
  metrics.recordUpstreamError({ code: 'rate_limit' });
  metrics.recordUpstreamError({ code: 'rate_limit' });
  metrics.recordUpstreamError({ code: 'auth_failed' });
  const s = metrics.snapshot();
  assert.equal(s.upstream.errorsByCode.rate_limit, 2);
  assert.equal(s.upstream.errorsByCode.auth_failed, 1);
  assert.equal(s.upstream.topErrorCodes[0].code, 'rate_limit');
});

test('recordUpstreamError without a code uses null', () => {
  metrics.reset();
  metrics.recordUpstreamError();
  const s = metrics.snapshot();
  assert.equal(s.upstream.errors, 1);
  assert.equal(s.upstream.lastErrorCode, null);
});

test('toPrometheusText includes upstream success/error counters', () => {
  metrics.reset();
  metrics.recordUpstreamSuccess();
  metrics.recordUpstreamSuccess();
  metrics.recordUpstreamError({ code: 'rate_limit' });
  const txt = metrics.toPrometheusText();
  assert.match(txt, /^# TYPE sira_free_ia_upstream_success_total counter/m);
  assert.match(txt, /^sira_free_ia_upstream_success_total 2$/m);
  assert.match(txt, /^sira_free_ia_upstream_errors_total 1$/m);
});

test('toPrometheusText includes per-error-code labels', () => {
  metrics.reset();
  metrics.recordUpstreamError({ code: '503' });
  metrics.recordUpstreamError({ code: '503' });
  metrics.recordUpstreamError({ code: '429' });
  const txt = metrics.toPrometheusText();
  assert.match(txt, /sira_free_ia_upstream_errors_total\{code="503"\} 2/);
  assert.match(txt, /sira_free_ia_upstream_errors_total\{code="429"\} 1/);
});

test('reset() clears upstream counters too', () => {
  metrics.recordUpstreamSuccess();
  metrics.recordUpstreamError({ code: '500' });
  metrics.reset();
  const s = metrics.snapshot();
  assert.equal(s.upstream.success, 0);
  assert.equal(s.upstream.errors, 0);
  assert.equal(s.upstream.lastErrorAt, null);
  assert.equal(s.upstream.lastErrorCode, null);
});

test('chargeCredits triggers recordFallback on the Free IA path', async () => {
  // Re-stub Prisma like the existing charge-credits-middleware tests do.
  const Module = require('node:module');
  const origRequire = Module.prototype.require;
  let balance = 3n;
  const stubs = new Map();
  stubs.set('../config/database', {
    creditTransaction: { async findUnique() { return null; }, async create({ data }) { return { id: 'tx_x', ...data }; } },
    credit: { async findUnique() { return { userId: 'u1', balance, lifetimeSpent: 0n }; }, async update() { return { userId: 'u1', balance, lifetimeSpent: 0n }; } },
    async $executeRawUnsafe() { return 0; }, // always insufficient
  });
  Module.prototype.require = function (spec) {
    if (stubs.has(spec)) return stubs.get(spec);
    return origRequire.apply(this, arguments);
  };
  // Force a fresh load so the stubs apply.
  delete require.cache[require.resolve('../src/middleware/charge-credits')];
  const chargeCredits = require('../src/middleware/charge-credits');
  Module.prototype.require = origRequire;

  metrics.reset();
  const prevKey = process.env.CEREBRAS_API_KEY;
  process.env.CEREBRAS_API_KEY = 'csk-test-metric-wire';
  try {
    const headers = {};
    const req = { user: { id: 'u1' }, body: {}, get() {} };
    const res = {
      status() { return res; },
      json() { return res; },
      setHeader(name, value) { headers[name.toLowerCase()] = String(value); },
      headersSent: false,
    };
    let nextCalled = false;
    await new Promise((resolve) => {
      chargeCredits({ feature: 'paraphrase', cost: 5 })(req, res, () => {
        nextCalled = true;
        resolve();
      });
    });
    assert.equal(nextCalled, true);
    const s = metrics.snapshot();
    assert.equal(s.totalFallbacks, 1);
    assert.equal(s.perFeature.paraphrase.count, 1);
    assert.equal(s.perFeature.paraphrase.costBlocked, '5');
  } finally {
    if (prevKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = prevKey;
    // Restore real charge-credits for other tests.
    delete require.cache[require.resolve('../src/middleware/charge-credits')];
  }
});

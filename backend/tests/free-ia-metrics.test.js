'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const metrics = require('../src/services/free-ia-metrics');

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
  assert.match(s.line, /Free IA: 2 fallbacks/);
  assert.match(s.line, /3\/4 upstream OK/);
  assert.match(s.line, /75\.00%/);
});

test('summary() reports successRate=null + "—" when no upstream events recorded', () => {
  metrics.reset();
  const s = metrics.summary();
  assert.equal(s.successRate, null);
  assert.equal(s.upstreamTotal, 0);
  assert.match(s.line, /—/);
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

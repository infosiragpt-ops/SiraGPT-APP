/**
 * Unit tests for services/ai/cost-tracker.js.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const ct = require('../src/services/ai/cost-tracker');

beforeEach(() => ct._reset());

test('computeCostUSD uses pricing.json for known models', () => {
  const c = ct.computeCostUSD({ model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0 });
  // gpt-4o-mini input is $0.15 per 1M tokens.
  assert.equal(c, 0.15);
});

test('computeCostUSD falls back for unknown models', () => {
  const c = ct.computeCostUSD({ model: 'wat', inputTokens: 1_000_000, outputTokens: 1_000_000 });
  // Fallback is $1 in + $1 out per 1M tokens → $2.
  assert.equal(c, 2);
});

test('track returns a record envelope with iso timestamp', () => {
  const rec = ct.track({ userId: 'u1', model: 'gpt-4o-mini', inputTokens: 100, outputTokens: 50 });
  assert.ok(rec);
  assert.equal(rec.userId, 'u1');
  assert.equal(rec.model, 'gpt-4o-mini');
  assert.equal(rec.inputTokens, 100);
  assert.equal(rec.outputTokens, 50);
  assert.ok(typeof rec.costUSD === 'number');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(rec.ts));
});

test('track never throws on bad input', () => {
  assert.doesNotThrow(() => ct.track(null));
  assert.doesNotThrow(() => ct.track({ inputTokens: 'abc' }));
});

test('report aggregates totals across records', () => {
  ct.track({ userId: 'u1', model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0 });
  ct.track({ userId: 'u2', model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0 });
  const r = ct.report({});
  assert.equal(r.totals.records, 2);
  assert.equal(r.totals.costUSD.toFixed(2), '0.30');
  assert.equal(r.perUser.length, 2);
});

test('report filters by userId', () => {
  ct.track({ userId: 'u1', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 0 });
  ct.track({ userId: 'u2', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 0 });
  const r = ct.report({ userId: 'u1' });
  assert.equal(r.totals.records, 1);
  assert.equal(r.perUser[0].userId, 'u1');
});

test('report filters by date range', () => {
  ct.track({ userId: 'u1', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 0, ts: new Date('2024-01-01') });
  ct.track({ userId: 'u1', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 0, ts: new Date('2025-06-15') });
  const r = ct.report({ from: '2025-01-01', to: '2026-01-01' });
  assert.equal(r.totals.records, 1);
});

test('monthlyCostForUser returns the current month aggregate', () => {
  ct.track({ userId: 'u1', model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0 });
  const m = ct.monthlyCostForUser('u1');
  assert.equal(m.requests, 1);
  assert.ok(m.totalCostUSD > 0);
});

test('setPersistHook forwards each record once', () => {
  const seen = [];
  ct.setPersistHook((r) => seen.push(r));
  ct.track({ userId: 'u1', model: 'gpt-4o-mini', inputTokens: 100, outputTokens: 50 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].userId, 'u1');
});

test('perModel breakdown groups records by model', () => {
  ct.track({ userId: 'u1', model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0 });
  ct.track({ userId: 'u1', model: 'gpt-5', inputTokens: 1_000_000, outputTokens: 0 });
  const r = ct.report({});
  const models = r.perModel.map((m) => m.model).sort();
  assert.deepEqual(models, ['gpt-4o-mini', 'gpt-5']);
});

// ─── Ratchet 45: edge-case coverage ─────────────────────────────────

test('track: empty model string falls back to fallback pricing', () => {
  const rec = ct.track({ userId: 'u1', model: '', inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.ok(rec);
  // Fallback is $1 in + $1 out per 1M tokens.
  assert.equal(rec.costUSD, 2);
  // perModel groups the empty model under the 'unknown' bucket.
  const r = ct.report({});
  const bucket = r.perModel.find((m) => m.model === 'unknown');
  assert.ok(bucket);
  assert.equal(bucket.requests, 1);
});

test('track: negative tokens are clamped to zero', () => {
  const rec = ct.track({ userId: 'u1', model: 'gpt-4o-mini', inputTokens: -500, outputTokens: -200 });
  assert.ok(rec);
  assert.equal(rec.inputTokens, 0);
  assert.equal(rec.outputTokens, 0);
  assert.equal(rec.costUSD, 0);
  const r = ct.report({});
  assert.equal(r.totals.inputTokens, 0);
  assert.equal(r.totals.outputTokens, 0);
});

test('track + report: very large costs aggregate without floating-point drift > $1', () => {
  // 50 records of $0.30 each = $15. Use the rounding helper to confirm
  // we don't accumulate float dust beyond 6 decimal places.
  for (let i = 0; i < 50; i += 1) {
    ct.track({ userId: 'whale', model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 1_000_000 });
  }
  // gpt-4o-mini: $0.15 in + $0.60 out per 1M = $0.75 per record → $37.50
  const r = ct.report({ userId: 'whale' });
  assert.equal(r.totals.records, 50);
  assert.ok(Math.abs(r.totals.costUSD - 37.5) < 0.001);
  const monthly = ct.monthlyCostForUser('whale');
  assert.ok(Math.abs(monthly.totalCostUSD - 37.5) < 0.001);
});

test('report: multi-month aggregation respects window boundaries', () => {
  ct.track({ userId: 'u1', model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0, ts: new Date('2026-01-15T12:00:00Z') });
  ct.track({ userId: 'u1', model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0, ts: new Date('2026-02-15T12:00:00Z') });
  ct.track({ userId: 'u1', model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0, ts: new Date('2026-03-15T12:00:00Z') });
  // Window of Feb 1 → Mar 1 only matches the Feb record.
  const feb = ct.report({ from: '2026-02-01', to: '2026-03-01' });
  assert.equal(feb.totals.records, 1);
  // Window covering Jan + Feb matches two records.
  const janFeb = ct.report({ from: '2026-01-01', to: '2026-03-01' });
  assert.equal(janFeb.totals.records, 2);
  // monthlyCostForUser for Feb returns the Feb bucket only.
  const monthlyFeb = ct.monthlyCostForUser('u1', new Date('2026-02-20T00:00:00Z'));
  assert.equal(monthlyFeb.requests, 1);
});

test('setPersistHook: errors in the hook never break track()', () => {
  ct.setPersistHook(() => { throw new Error('boom'); });
  // The throw must be swallowed and the record still appended.
  const rec = ct.track({ userId: 'u1', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 0 });
  assert.ok(rec);
  assert.equal(rec.userId, 'u1');
  const r = ct.report({});
  assert.equal(r.totals.records, 1);
});

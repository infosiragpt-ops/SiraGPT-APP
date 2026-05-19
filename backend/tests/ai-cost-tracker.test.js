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

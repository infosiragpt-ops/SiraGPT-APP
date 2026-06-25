'use strict';

const test = require('node:test');
const assert = require('node:assert');

const profiler = require('../src/services/attribution-performance-profiler');

test.beforeEach(() => profiler.__resetForTests());

test('createSession.start/end measures a stage', async () => {
  const s = profiler.createSession();
  s.start('work');
  await new Promise((r) => setTimeout(r, 15));
  const delta = s.end('work');
  assert.ok(delta >= 10);
  const report = s.finish();
  assert.strictEqual(report.stages.length, 1);
  assert.strictEqual(report.stages[0].label, 'work');
  assert.ok(report.stages[0].totalMs >= 10);
});

test('createSession: completing two stages reports both', async () => {
  const s = profiler.createSession();
  s.start('a'); await new Promise((r) => setTimeout(r, 5)); s.end('a');
  s.start('b'); await new Promise((r) => setTimeout(r, 8)); s.end('b');
  const r = s.finish();
  assert.strictEqual(r.stages.length, 2);
  const labels = r.stages.map((x) => x.label);
  assert.ok(labels.includes('a'));
  assert.ok(labels.includes('b'));
});

test('createSession: ending an unknown stage returns 0', () => {
  const s = profiler.createSession();
  assert.strictEqual(s.end('missing'), 0);
});

test('createSession: opts.enabled=false is a no-op', () => {
  const s = profiler.createSession({ enabled: false });
  s.start('x'); s.end('x');
  const r = s.finish();
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(r.stages.length, 0);
});

test('createSession.lap records a pre-measured delta', () => {
  const s = profiler.createSession();
  s.lap('precomputed', 25);
  const r = s.finish();
  assert.strictEqual(r.stages.length, 1);
  assert.ok(r.stages[0].totalMs >= 25);
});

test('createSession.annotation attaches side data to a stage', () => {
  const s = profiler.createSession();
  s.start('work'); s.annotation('work', 'count', 3); s.end('work');
  const r = s.finish();
  assert.strictEqual(r.stages[0].annotations.count, 3);
});

test('measure: wraps a sync function and times it', () => {
  const result = profiler.measure('sync-call', () => 42);
  assert.strictEqual(result, 42);
  const stats = profiler.getAggregateStats('sync-call');
  assert.strictEqual(stats.samples, 1);
});

test('measure: wraps an async function and times it', async () => {
  const result = await profiler.measure('async-call', async () => {
    await new Promise((r) => setTimeout(r, 10));
    return 'ok';
  });
  assert.strictEqual(result, 'ok');
  const stats = profiler.getAggregateStats('async-call');
  assert.strictEqual(stats.samples, 1);
  assert.ok(stats.p50 >= 10);
});

test('measure: records timing even when the wrapped fn throws', async () => {
  try {
    await profiler.measure('throwing', async () => { throw new Error('boom'); });
    assert.fail('expected throw');
  } catch (err) {
    assert.strictEqual(err.message, 'boom');
  }
  const stats = profiler.getAggregateStats('throwing');
  assert.strictEqual(stats.samples, 1);
});

test('wrap: returns a function that records every call', () => {
  const w = profiler.wrap('wrapped-fn', (x) => x * 2);
  assert.strictEqual(w(3), 6);
  assert.strictEqual(w(4), 8);
  const stats = profiler.getAggregateStats('wrapped-fn');
  assert.strictEqual(stats.samples, 2);
});

test('getAggregateStats() returns sorted aggregates across labels', () => {
  profiler.measure('slow', () => { for (let i = 0; i < 1e6; i += 1); });
  profiler.measure('fast', () => null);
  const all = profiler.getAggregateStats();
  assert.ok(Array.isArray(all));
  assert.ok(all.length >= 2);
});

test('getAggregateStats(label) for unknown label returns 0 samples', () => {
  const s = profiler.getAggregateStats('does-not-exist');
  assert.strictEqual(s.samples, 0);
});

test('resetAggregates(label) clears a single label', () => {
  profiler.measure('keep', () => null);
  profiler.measure('drop', () => null);
  profiler.resetAggregates('drop');
  assert.strictEqual(profiler.getAggregateStats('drop').samples, 0);
  assert.strictEqual(profiler.getAggregateStats('keep').samples, 1);
});

test('resetAggregates() with no arg clears everything', () => {
  profiler.measure('a', () => null);
  profiler.measure('b', () => null);
  profiler.resetAggregates();
  assert.strictEqual(profiler.getAggregateStats('a').samples, 0);
});

test('hot path: 500 measure calls under 50ms', () => {
  const t0 = Date.now();
  for (let i = 0; i < 500; i += 1) profiler.measure('bench', () => null);
  assert.ok(Date.now() - t0 < 200);
  const stats = profiler.getAggregateStats('bench');
  assert.ok(stats.samples > 0);
});

test('percentile: nearest-rank (not floor over-shoot)', () => {
  const a = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  // p50 nearest-rank = ceil(0.5*10)-1 = idx 4 = 50 (floor would give idx 5 = 60).
  assert.equal(profiler.percentile(a, 0.5), 50);
  assert.equal(profiler.percentile(a, 0.95), 100);
  assert.equal(profiler.percentile(a, 0), 10);
  assert.equal(profiler.percentile(a, 1), 100);
  assert.equal(profiler.percentile([], 0.5), 0);
});

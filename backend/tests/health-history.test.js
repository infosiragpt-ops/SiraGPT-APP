/**
 * Tests for the probe history endpoint and supporting utilities
 * (`/internal/health/history`).
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  Probe,
  HealthRegistry,
  percentile,
  summarizeHistory,
  STATUS,
  CATEGORY,
} = require('../src/health');

const delay = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

// ── percentile ────────────────────────────────────────────────────────────

describe('percentile()', () => {
  it('returns null for empty input', () => {
    assert.equal(percentile([], 0.5), null);
    assert.equal(percentile([], 0.95), null);
  });

  it('returns the only value for single-element arrays', () => {
    assert.equal(percentile([42], 0.5), 42);
    assert.equal(percentile([42], 0.95), 42);
  });

  it('matches expected order statistics on sorted input', () => {
    const xs = [10, 20, 30, 40, 50];
    assert.equal(percentile(xs, 0), 10);
    assert.equal(percentile(xs, 0.5), 30);
    assert.equal(percentile(xs, 1), 50);
  });

  it('interpolates between order statistics', () => {
    const xs = [0, 100];
    assert.equal(percentile(xs, 0.5), 50);
    assert.equal(percentile(xs, 0.95), 95);
  });

  it('ignores non-finite values', () => {
    assert.equal(percentile([NaN, Infinity, 5, 15], 0.5), 10);
  });

  it('rejects p outside [0,1]', () => {
    assert.throws(() => percentile([1, 2, 3], 1.5), /percentile/);
    assert.throws(() => percentile([1, 2, 3], -0.1), /percentile/);
  });
});

// ── summarizeHistory ──────────────────────────────────────────────────────

describe('summarizeHistory()', () => {
  it('returns empty stats for no entries', () => {
    const s = summarizeHistory([]);
    assert.equal(s.total, 0);
    assert.equal(s.sampled, 0);
    assert.equal(s.p50, null);
    assert.equal(s.p95, null);
    assert.equal(s.minMs, null);
    assert.equal(s.maxMs, null);
    assert.equal(s.lastTimestamp, null);
    assert.deepEqual(s.byStatus, {});
  });

  it('counts statuses and computes percentiles', () => {
    const entries = [
      { status: 'pass', elapsedMs: 10, cached: false, timestamp: 't1' },
      { status: 'pass', elapsedMs: 20, cached: false, timestamp: 't2' },
      { status: 'fail', elapsedMs: 30, cached: false, timestamp: 't3' },
      { status: 'pass', elapsedMs: 40, cached: false, timestamp: 't4' },
      { status: 'pass', elapsedMs: 50, cached: false, timestamp: 't5' },
    ];
    const s = summarizeHistory(entries);
    assert.equal(s.total, 5);
    assert.equal(s.sampled, 5);
    assert.deepEqual(s.byStatus, { pass: 4, fail: 1 });
    assert.equal(s.p50, 30);
    assert.equal(s.p95, 48); // (40 + 50)/2 weighted toward 50: 40*0.2 + 50*0.8 = 48
    assert.equal(s.minMs, 10);
    assert.equal(s.maxMs, 50);
    assert.equal(s.lastTimestamp, 't5');
  });

  it('excludes cached entries from latency stats but counts them', () => {
    const entries = [
      { status: 'pass', elapsedMs: 100, cached: false, timestamp: 't1' },
      { status: 'pass', elapsedMs: 0,   cached: true,  timestamp: 't2' },
      { status: 'pass', elapsedMs: 200, cached: false, timestamp: 't3' },
    ];
    const s = summarizeHistory(entries);
    assert.equal(s.total, 3);
    assert.equal(s.sampled, 2);
    assert.equal(s.p50, 150);
    assert.equal(s.minMs, 100);
    assert.equal(s.maxMs, 200);
    assert.deepEqual(s.byStatus, { pass: 3 });
  });
});

// ── Probe history ─────────────────────────────────────────────────────────

describe('Probe history tracking', () => {
  it('records each fresh run', async () => {
    const p = new Probe({ name: 'h', ttlMs: 0, check: async () => 'ok' });
    await p.run();
    await p.run();
    await p.run();
    const hist = p.getHistory();
    assert.equal(hist.length, 3);
    for (const e of hist) {
      assert.equal(e.status, STATUS.PASS);
      assert.equal(e.cached, false);
      assert.ok(typeof e.timestamp === 'string');
      assert.ok(e.elapsedMs >= 0);
    }
  });

  it('caps history at historySize (oldest dropped first)', async () => {
    const p = new Probe({
      name: 'cap',
      ttlMs: 0,
      historySize: 3,
      check: async () => 'ok',
    });
    for (let i = 0; i < 7; i += 1) await p.run();
    const hist = p.getHistory();
    assert.equal(hist.length, 3);
  });

  it('honors historySize=0 (no recording)', async () => {
    const p = new Probe({
      name: 'noh',
      ttlMs: 0,
      historySize: 0,
      check: async () => 'ok',
    });
    await p.run();
    await p.run();
    assert.deepEqual(p.getHistory(), []);
  });

  it('records timeout and failure entries with their status', async () => {
    const fail = new Probe({
      name: 'f',
      ttlMs: 0,
      check: async () => { throw new Error('boom'); },
    });
    await fail.run();
    const fh = fail.getHistory();
    assert.equal(fh.length, 1);
    assert.equal(fh[0].status, STATUS.FAIL);
    assert.equal(fh[0].error, 'boom');

    const slow = new Probe({
      name: 's',
      ttlMs: 0,
      timeoutMs: 20,
      check: () => delay(200, 'late'),
    });
    await slow.run();
    const sh = slow.getHistory();
    assert.equal(sh[0].status, STATUS.TIMEOUT);
  });

  it('clearHistory() resets the buffer', async () => {
    const p = new Probe({ name: 'c', ttlMs: 0, check: async () => 1 });
    await p.run();
    assert.equal(p.getHistory().length, 1);
    p.clearHistory();
    assert.deepEqual(p.getHistory(), []);
  });

  it('getHistory(limit) returns only the most recent N entries', async () => {
    const p = new Probe({
      name: 'lim',
      ttlMs: 0,
      historySize: 10,
      check: async () => 1,
    });
    for (let i = 0; i < 6; i += 1) await p.run();
    assert.equal(p.getHistory(3).length, 3);
    assert.equal(p.getHistory(20).length, 6);
  });
});

// ── HealthRegistry.getHistory ─────────────────────────────────────────────

describe('HealthRegistry.getHistory()', () => {
  it('returns per-probe stats and records', async () => {
    const reg = new HealthRegistry();
    reg.add({ name: 'a', ttlMs: 0, check: async () => 1 });
    reg.add({ name: 'b', ttlMs: 0, category: CATEGORY.DEGRADED, check: async () => { throw new Error('x'); } });
    await reg.runAll();
    await reg.runAll();
    const out = reg.getHistory();
    assert.equal(out.probes.length, 2);
    const a = out.probes.find((p) => p.name === 'a');
    const b = out.probes.find((p) => p.name === 'b');
    assert.equal(a.stats.total, 2);
    assert.equal(a.stats.byStatus[STATUS.PASS], 2);
    assert.equal(b.stats.byStatus[STATUS.FAIL], 2);
    assert.equal(b.category, CATEGORY.DEGRADED);
    assert.ok(typeof out.timestamp === 'string');
  });

  it('filters by name when provided', async () => {
    const reg = new HealthRegistry();
    reg.add({ name: 'one', ttlMs: 0, check: async () => 1 });
    reg.add({ name: 'two', ttlMs: 0, check: async () => 2 });
    await reg.runAll();
    const out = reg.getHistory({ name: 'two' });
    assert.equal(out.probes.length, 1);
    assert.equal(out.probes[0].name, 'two');
  });

  it('returns empty probes when name is unknown', () => {
    const reg = new HealthRegistry();
    reg.add({ name: 'one', ttlMs: 0, check: async () => 1 });
    const out = reg.getHistory({ name: 'missing' });
    assert.deepEqual(out.probes, []);
  });

  it('caps records per probe by limit', async () => {
    const reg = new HealthRegistry();
    reg.add({ name: 'p', ttlMs: 0, historySize: 20, check: async () => 1 });
    for (let i = 0; i < 8; i += 1) await reg.runAll();
    const out = reg.getHistory({ limit: 3 });
    assert.equal(out.probes[0].records.length, 3);
    assert.equal(out.probes[0].stats.total, 3);
  });
});

// ── historyHandler ────────────────────────────────────────────────────────

describe('HealthRegistry.historyHandler()', () => {
  it('returns 200 with stats and records', async () => {
    const reg = new HealthRegistry();
    reg.add({ name: 'svc', ttlMs: 0, check: async () => 'ok' });
    await reg.runAll();
    await reg.runAll();
    const handler = reg.historyHandler();
    const res = mockRes();
    await handler({ query: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.probes.length, 1);
    assert.equal(res.body.probes[0].name, 'svc');
    assert.equal(res.body.probes[0].stats.total, 2);
    assert.equal(typeof res.body.probes[0].stats.p50, 'number');
  });

  it('honors ?n= as limit, capped at maxLimit', async () => {
    const reg = new HealthRegistry();
    reg.add({ name: 'svc', ttlMs: 0, historySize: 20, check: async () => 'ok' });
    for (let i = 0; i < 10; i += 1) await reg.runAll();
    const handler = reg.historyHandler({ defaultLimit: 50, maxLimit: 5 });
    const res = mockRes();
    await handler({ query: { n: '999' } }, res);
    assert.equal(res.body.probes[0].records.length, 5);
  });

  it('uses defaultLimit when n is missing or invalid', async () => {
    const reg = new HealthRegistry();
    reg.add({ name: 'svc', ttlMs: 0, historySize: 20, check: async () => 'ok' });
    for (let i = 0; i < 6; i += 1) await reg.runAll();
    const handler = reg.historyHandler({ defaultLimit: 4 });
    const res = mockRes();
    await handler({ query: { n: 'not-a-number' } }, res);
    assert.equal(res.body.probes[0].records.length, 4);
  });

  it('filters by ?name=', async () => {
    const reg = new HealthRegistry();
    reg.add({ name: 'a', ttlMs: 0, check: async () => 1 });
    reg.add({ name: 'b', ttlMs: 0, check: async () => 2 });
    await reg.runAll();
    const handler = reg.historyHandler();
    const res = mockRes();
    await handler({ query: { name: 'b' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.probes.length, 1);
    assert.equal(res.body.probes[0].name, 'b');
  });

  it('returns 404 for an unknown probe name', async () => {
    const reg = new HealthRegistry();
    reg.add({ name: 'a', ttlMs: 0, check: async () => 1 });
    const handler = reg.historyHandler();
    const res = mockRes();
    await handler({ query: { name: 'nope' } }, res);
    assert.equal(res.statusCode, 404);
    assert.match(res.body.error, /unknown probe/);
  });

  it('mount() registers the /history route alongside live/ready', () => {
    const calls = [];
    const app = { get: (path, fn) => { calls.push({ path, fn }); } };
    const reg = new HealthRegistry();
    reg.mount(app);
    const paths = calls.map((c) => c.path);
    assert.ok(paths.includes('/internal/health/history'));
    assert.ok(paths.includes('/internal/health/live'));
    assert.ok(paths.includes('/internal/health/ready'));
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

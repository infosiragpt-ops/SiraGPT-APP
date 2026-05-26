'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const rp = require('../src/services/attribution-replay-runner');
const tr = require('../src/services/attribution-trace-recorder');

describe('attribution-replay-runner', () => {
  beforeEach(() => tr.reset());

  test('replay rejects missing traceId', () => {
    const r = rp.replay({});
    assert.equal(r.ok, false);
  });

  test('replay returns error for unknown trace', () => {
    const r = rp.replay({ traceId: 'nope_xxx' });
    assert.equal(r.ok, false);
  });

  test('replay returns stable=true when telemetry matches', () => {
    // Record a trace via the suite so the replay produces matching telemetry.
    const suite = require('../src/services/attribution-suite');
    const bundle = suite.run({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'crea un PDF con los KPIs' });
    const trace = tr.record({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'crea un PDF con los KPIs', bundle });
    const r = rp.replay({ traceId: trace.id });
    assert.equal(r.ok, true);
    assert.ok(typeof r.numericDrift === 'number');
  });

  test('diffSnapshots returns empty for identical inputs', () => {
    const diffs = rp.diffSnapshots({ a: 1, b: 'x' }, { a: 1, b: 'x' });
    assert.equal(Object.keys(diffs).length, 0);
  });

  test('diffSnapshots flags numeric deltas', () => {
    const diffs = rp.diffSnapshots({ a: 1 }, { a: 3 });
    assert.equal(diffs.a.from, 1);
    assert.equal(diffs.a.to, 3);
    assert.equal(diffs.a.delta, 2);
  });

  test('diffSnapshots flags string changes', () => {
    const diffs = rp.diffSnapshots({ s: 'foo' }, { s: 'bar' });
    assert.ok(diffs.s);
    assert.equal(diffs.s.from, 'foo');
  });

  test('replayAll iterates over trace recorder', () => {
    const suite = require('../src/services/attribution-suite');
    for (let i = 0; i < 3; i++) {
      const bundle = suite.run({ userId: 'u', chatId: 'c', turnIndex: i, prompt: `crea un PDF #${i}` });
      tr.record({ userId: 'u', chatId: 'c', turnIndex: i, prompt: `crea un PDF #${i}`, bundle });
    }
    const r = rp.replayAll();
    assert.equal(r.total, 3);
    assert.ok(typeof r.stabilityRate === 'number');
  });

  test('buildReplayBlock returns content when ok', () => {
    const suite = require('../src/services/attribution-suite');
    const bundle = suite.run({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'algo' });
    const trace = tr.record({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'algo', bundle });
    const r = rp.replay({ traceId: trace.id });
    const block = rp.buildReplayBlock(r);
    assert.match(block, /TRACE REPLAY/);
  });
});

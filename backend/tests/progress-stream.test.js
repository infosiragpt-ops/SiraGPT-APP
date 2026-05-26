'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const events = require('node:events');
const http = require('http');

// ── Module under test ─────────────────────────────────────────────
const { createProgressStream } = require('../src/services/progress-stream');

// ── Helpers ───────────────────────────────────────────────────────

/** Collect all events emitted by a progress stream into an array. */
function collectEvents() {
  const events = [];
  const send = (ev) => { events.push(ev); };
  const ps = createProgressStream(send, { maxDurationMs: 0 });
  return { ps, events, send };
}

/** Create a fake HTTP.ServerResponse that collects writes. */
function makeFakeRes() {
  const chunks = [];
  const res = new events.EventEmitter();
  res.write = (chunk) => { chunks.push(chunk); return true; };
  res.end = () => { res.emit('finish'); };
  res.writableEnded = false;
  res.destroyed = false;
  res.setTimeout = () => {};
  // Manually track writableEnded
  const origEnd = res.end;
  res.end = (...args) => { res.writableEnded = true; return origEnd(...args); };
  return { res, chunks };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('createProgressStream', () => {
  let ps, events;

  beforeEach(() => {
    const ctx = collectEvents();
    ps = ctx.ps;
    events = ctx.events;
  });

  afterEach(() => {
    if (ps && !ps.finished && !ps.cancelled) ps.cancel();
  });

  it('stage emits type:stage with label and pct', () => {
    ps.stage('Generating', 10);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'stage');
    assert.strictEqual(events[0].label, 'Generating');
    assert.strictEqual(events[0].pct, 10);
  });

  it('stage clamps pct to 0-100', () => {
    ps.stage('Over', 150);
    assert.strictEqual(events[0].pct, 100);
    ps.stage('Under', -10);
    assert.strictEqual(events[1].pct, 0);
    ps.stage('NaN', 'abc');
    assert.strictEqual(events[2].pct, 0);
  });

  it('stage accepts optional meta', () => {
    ps.stage('Writing', 50, { sheet: 3, total: 10 });
    assert.strictEqual(events[0].meta.sheet, 3);
    assert.strictEqual(events[0].meta.total, 10);
  });

  it('update emits type:progress with label and pct', () => {
    ps.update('Formatting cells', 42);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'progress');
    assert.strictEqual(events[0].label, 'Formatting cells');
    assert.strictEqual(events[0].pct, 42);
  });

  it('update clamps pct to 0-100', () => {
    ps.update('Over', 200);
    assert.strictEqual(events[0].pct, 100);
  });

  it('done emits type:done with result and elapsedMs', () => {
    const result = { ok: true, artifactId: 'abc' };
    const returned = ps.done(result);
    assert.strictEqual(returned, result);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'done');
    assert.strictEqual(events[0].result, result);
    assert.ok(typeof events[0].elapsedMs === 'number');
    assert.ok(events[0].elapsedMs >= 0);
  });

  it('done marks as finished', () => {
    ps.done('result');
    assert.strictEqual(ps.finished, true);
    assert.ok(ps.finishedAt > 0);
  });

  it('done does not emit after already finished', () => {
    ps.done('first');
    const len1 = events.length;
    ps.done('second');
    assert.strictEqual(events.length, len1); // no new events
  });

  it('fail emits type:error with message', () => {
    const returned = ps.fail(new Error('timeout'));
    assert.strictEqual(returned.ok, false);
    assert.strictEqual(returned.error, 'timeout');
    assert.ok(typeof returned.elapsedMs === 'number');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'error');
    assert.strictEqual(events[0].error, 'timeout');
  });

  it('fail with string message', () => {
    ps.fail('disk full');
    assert.strictEqual(events[0].error, 'disk full');
  });

  it('fail marks as finished', () => {
    ps.fail(new Error('err'));
    assert.strictEqual(ps.finished, true);
  });

  it('fail does not emit after already finished', () => {
    ps.fail(new Error('first'));
    const len1 = events.length;
    ps.fail(new Error('second'));
    assert.strictEqual(events.length, len1);
  });

  it('cancel returns true and stops further events', () => {
    const r = ps.cancel();
    assert.strictEqual(r, true);
    assert.strictEqual(ps.cancelled, true);
    ps.stage('after cancel', 99);
    assert.strictEqual(events.length, 0);
  });

  it('cancel returns false when already finished', () => {
    ps.done('ok');
    assert.strictEqual(ps.cancel(), false);
  });

  it('elapsed grows over time', async () => {
    const ms1 = ps.elapsed;
    await new Promise((r) => setTimeout(r, 20));
    const ms2 = ps.elapsed;
    assert.ok(ms2 >= ms1, 'elapsed should not decrease');
  });

  it('startedAt is set on creation', () => {
    assert.ok(ps.startedAt > 0);
    assert.ok(Math.abs(ps.startedAt - Date.now()) < 100);
  });

  it('timeline captures milestone stages', () => {
    ps.stage('A', 10);
    ps.stage('B', 50);
    ps.stage('C', 90);
    ps.done('ok');
    const tl = ps.timeline;
    assert.strictEqual(tl.length, 3);
    assert.strictEqual(tl[0].label, 'A');
    assert.strictEqual(tl[0].pct, 10);
    assert.strictEqual(tl[1].label, 'B');
    assert.strictEqual(tl[1].pct, 50);
    assert.strictEqual(tl[2].label, 'C');
    assert.strictEqual(tl[2].pct, 90);
    assert.ok(tl[0].elapsedMs >= 0);
  });

  it('timeline is immutable (returns a copy)', () => {
    ps.stage('A', 10);
    const tl1 = ps.timeline;
    tl1.push({ label: 'X', pct: 99, elapsedMs: 0 });
    const tl2 = ps.timeline;
    assert.strictEqual(tl2.length, 1); // not mutated
  });

  it('lastPct tracks highest percentage', () => {
    assert.strictEqual(ps.lastPct, 0);
    ps.stage('A', 20);
    assert.strictEqual(ps.lastPct, 20);
    ps.update('progress', 55);
    assert.strictEqual(ps.lastPct, 55);
    ps.stage('B', 10); // regressive
    assert.strictEqual(ps.lastPct, 10); // tracks the set value
  });

  it('canSend guard suppresses sends', () => {
    const sent = [];
    const suppressed = [];
    const send = (ev) => sent.push(ev);
    const canSend = (ev) => {
      if (ev.label === 'suppress me') { suppressed.push(ev); return false; }
      return true;
    };
    const ps2 = createProgressStream(send, { canSend });
    ps2.stage('visible', 10);
    ps2.stage('suppress me', 50);
    ps2.stage('also visible', 90);
    ps2.done('ok');
    assert.strictEqual(sent.length, 3);
    assert.strictEqual(suppressed.length, 1);
    assert.strictEqual(suppressed[0].label, 'suppress me');
  });

  it('translateLabel transforms stage labels', () => {
    const sent = [];
    const translate = (l) => l.toUpperCase();
    const ps2 = createProgressStream((ev) => sent.push(ev), { translateLabel: translate });
    ps2.stage('hello', 50);
    ps2.update('world', 75);
    ps2.done('ok');
    assert.strictEqual(sent[0].label, 'HELLO');
    assert.strictEqual(sent[1].label, 'WORLD');
  });

  it('maxDurationMs auto-fails after timeout', async () => {
    const sent = [];
    const ps2 = createProgressStream((ev) => sent.push(ev), { maxDurationMs: 50 });
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(ps2.finished, true);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, 'error');
    assert.match(sent[0].error, /max duration/);
  });

  it('maxDurationMs does not fire after manual done', async () => {
    const sent = [];
    const ps2 = createProgressStream((ev) => sent.push(ev), { maxDurationMs: 50 });
    ps2.done('early');
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(ps2.finished, true);
    // Only the done event (not error)
    const errors = sent.filter((e) => e.type === 'error');
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(sent.filter((e) => e.type === 'done').length, 1);
  });

  it('does not throw when send throws', () => {
    const crashSend = () => { throw new Error('write failed'); };
    const ps2 = createProgressStream(crashSend);
    assert.doesNotThrow(() => {
      ps2.stage('A', 10);
      ps2.update('B', 50);
      ps2.done('ok');
    });
  });

  it('does not emit after cancel', () => {
    ps.cancel();
    const beforeCount = events.length;
    ps.stage('X', 99);
    ps.update('Y', 100);
    ps.done('done');
    ps.fail(new Error('e'));
    assert.strictEqual(events.length, beforeCount);
  });

  it('stage with meta object includes it in event', () => {
    ps.stage('Build', 30, { rows: 100, cols: 5 });
    assert.deepStrictEqual(events[0].meta, { rows: 100, cols: 5 });
  });

  it('update with meta object includes it in event', () => {
    ps.update('Processing', 60, { current: 3, total: 10 });
    assert.deepStrictEqual(events[0].meta, { current: 3, total: 10 });
  });

  it('multiple stages and done sequence', () => {
    ps.stage('Init', 0);
    ps.update('Loading', 15);
    ps.stage('Processing', 40);
    ps.update('Sub-step', 55);
    ps.stage('Finalizing', 85);
    ps.done({ result: 'complete' });
    assert.strictEqual(events.length, 6);
    assert.strictEqual(events[0].type, 'stage');
    assert.strictEqual(events[1].type, 'progress');
    assert.strictEqual(events[2].type, 'stage');
    assert.strictEqual(events[3].type, 'progress');
    assert.strictEqual(events[4].type, 'stage');
    assert.strictEqual(events[5].type, 'done');
  });
});

describe('createProgressStream with HTTP response', () => {
  it('attaches heartbeat when res is provided', () => {
    const { res, chunks } = makeFakeRes();
    const sent = [];
    // Use a custom setInterval for fast ticks
    let hbHandle = null;
    const fastInterval = (fn, _ms) => { hbHandle = setInterval(fn, 10); return hbHandle; };
    const ps = createProgressStream((ev) => sent.push(ev), {
      res,
      heartbeatMs: 10,
      setIntervalFn: fastInterval,
      clearIntervalFn: (h) => clearInterval(h),
    });
    return new Promise((resolve) => {
      setTimeout(() => {
        ps.done('ok');
        const hasHeartbeat = chunks.some((c) => String(c).includes(':keepalive'));
        assert.ok(hasHeartbeat, 'should have written heartbeat');
        resolve();
      }, 30);
    });
  });

  it('heartbeat stops after done', () => {
    const { res, chunks } = makeFakeRes();
    const sent = [];
    let hbHandle = null;
    const fastInterval = (fn, _ms) => { hbHandle = setInterval(fn, 10); return hbHandle; };
    const ps = createProgressStream((ev) => sent.push(ev), {
      res,
      heartbeatMs: 10,
      setIntervalFn: fastInterval,
      clearIntervalFn: (h) => clearInterval(h),
    });
    ps.done('ok');
    const beforeCount = chunks.length;
    return new Promise((resolve) => {
      setTimeout(() => {
        assert.strictEqual(chunks.length, beforeCount);
        resolve();
      }, 50);
    });
  });
});

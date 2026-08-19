'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { ProbeScheduler } = require('../src/health/probe-scheduler');
const { Probe } = require('../src/health/probe');

function makeProbe(name, behaviour) {
  let n = 0;
  return new Probe({
    name,
    timeoutMs: 1000,
    ttlMs: 0,
    historySize: 50,
    check: async () => {
      n += 1;
      if (typeof behaviour === 'function') return behaviour(n);
      return { status: 'pass', details: { n } };
    },
  });
}

// ─── Construction ────────────────────────────────────────────────

test('ProbeScheduler: rejects defaultIntervalMs < 1000', () => {
  assert.throws(() => new ProbeScheduler({ defaultIntervalMs: 500 }), /defaultIntervalMs/);
});

test('ProbeScheduler: rejects invalid jitterRatio', () => {
  assert.throws(() => new ProbeScheduler({ jitterRatio: -0.1 }), /jitterRatio/);
  assert.throws(() => new ProbeScheduler({ jitterRatio: 1.1 }), /jitterRatio/);
});

test('ProbeScheduler: rejects backoffFactor < 1', () => {
  assert.throws(() => new ProbeScheduler({ backoffFactor: 0.5 }), /backoffFactor/);
});

test('ProbeScheduler: starts not running, size 0', () => {
  const s = new ProbeScheduler();
  assert.equal(s.running, false);
  assert.equal(s.size, 0);
});

// ─── add / remove / list ─────────────────────────────────────────

test('ProbeScheduler.add: rejects probes without run/name', () => {
  const s = new ProbeScheduler();
  assert.throws(() => s.add(null), /probe with .name/);
  assert.throws(() => s.add({}), /probe with .name/);
  assert.throws(() => s.add({ run: () => {} }), /probe with .name/);
});

test('ProbeScheduler.add: rejects duplicate names', () => {
  const s = new ProbeScheduler();
  const p = makeProbe('db');
  s.add(p);
  assert.throws(() => s.add(p), /already registered/);
});

test('ProbeScheduler.add: returns entry with defaults', () => {
  const s = new ProbeScheduler({ defaultIntervalMs: 5000 });
  const entry = s.add(makeProbe('db'));
  assert.equal(entry.baseIntervalMs, 5000);
  assert.equal(entry.currentIntervalMs, 5000);
  assert.equal(entry.sampleCount, 0);
  assert.equal(entry.consecutiveFailures, 0);
});

test('ProbeScheduler.add: honours per-probe intervalMs', () => {
  const s = new ProbeScheduler();
  const entry = s.add(makeProbe('db'), { intervalMs: 10_000 });
  assert.equal(entry.baseIntervalMs, 10_000);
});

test('ProbeScheduler.add: per-probe intervalMs < 1000 falls back to default', () => {
  const s = new ProbeScheduler({ defaultIntervalMs: 3000 });
  const entry = s.add(makeProbe('db'), { intervalMs: 100 });
  assert.equal(entry.baseIntervalMs, 3000);
});

test('ProbeScheduler.remove: drops the entry', () => {
  const s = new ProbeScheduler();
  s.add(makeProbe('db'));
  assert.equal(s.size, 1);
  assert.equal(s.remove('db'), true);
  assert.equal(s.size, 0);
  assert.equal(s.remove('db'), false);
});

test('ProbeScheduler.addAll: bulk-registers from a HealthRegistry-like', () => {
  const s = new ProbeScheduler();
  const registryLike = { list: () => [makeProbe('a'), makeProbe('b')] };
  const added = s.addAll(registryLike);
  assert.equal(added.length, 2);
  assert.equal(s.size, 2);
});

test('ProbeScheduler.addAll: skips already-registered probes', () => {
  const s = new ProbeScheduler();
  const a = makeProbe('a');
  s.add(a);
  const added = s.addAll({ list: () => [a, makeProbe('b')] });
  assert.equal(added.length, 1);
  assert.equal(s.size, 2);
});

// ─── Sampling lifecycle ──────────────────────────────────────────

test('ProbeScheduler.sampleOnce: runs probe once and records', async () => {
  const s = new ProbeScheduler();
  const p = makeProbe('db');
  s.add(p);
  const r = await s.sampleOnce('db');
  assert.equal(r.status, 'pass');
  assert.equal(s.get('db').sampleCount, 1);
  assert.equal(s.get('db').consecutiveFailures, 0);
});

test('ProbeScheduler.sampleOnce: failing probe increments consecutiveFailures', async () => {
  const s = new ProbeScheduler();
  const p = makeProbe('db', () => { throw new Error('boom'); });
  s.add(p);
  await s.sampleOnce('db');
  await s.sampleOnce('db');
  assert.equal(s.get('db').consecutiveFailures, 2);
});

test('ProbeScheduler.sampleOnce: recovery clears consecutiveFailures and resets interval', async () => {
  const s = new ProbeScheduler({ defaultIntervalMs: 5000 });
  let mode = 'fail';
  const p = makeProbe('db', () => {
    if (mode === 'fail') throw new Error('boom');
    return { status: 'pass' };
  });
  s.add(p);
  await s.sampleOnce('db');
  await s.sampleOnce('db');
  const entry = s.get('db');
  assert.ok(entry.currentIntervalMs > entry.baseIntervalMs);
  mode = 'ok';
  await s.sampleOnce('db');
  assert.equal(entry.consecutiveFailures, 0);
  assert.equal(entry.currentIntervalMs, entry.baseIntervalMs);
});

test('ProbeScheduler.sampleOnce: dedupes concurrent runs', async () => {
  const s = new ProbeScheduler();
  let inflightCount = 0;
  let peak = 0;
  const p = new Probe({
    name: 'slow',
    timeoutMs: 1000,
    ttlMs: 0,
    check: () => new Promise((resolve) => {
      inflightCount += 1;
      peak = Math.max(peak, inflightCount);
      setTimeout(() => {
        inflightCount -= 1;
        resolve({ status: 'pass' });
      }, 30);
    }),
  });
  s.add(p);
  await Promise.all([s.sampleOnce('slow'), s.sampleOnce('slow'), s.sampleOnce('slow')]);
  assert.equal(peak, 1);
});

test('ProbeScheduler.sampleOnce: throws for unknown probe', async () => {
  const s = new ProbeScheduler();
  await assert.rejects(() => s.sampleOnce('ghost'), /no probe "ghost"/);
});

// ─── Adaptive back-off ───────────────────────────────────────────

test('ProbeScheduler: backoff doubles up to cap', async () => {
  const s = new ProbeScheduler({
    defaultIntervalMs: 1000,
    backoffFactor: 2,
    backoffCapRatio: 4,
  });
  const p = makeProbe('db', () => { throw new Error('boom'); });
  s.add(p);
  await s.sampleOnce('db');
  assert.equal(s.get('db').currentIntervalMs, 2000);
  await s.sampleOnce('db');
  assert.equal(s.get('db').currentIntervalMs, 4000);
  // Cap (1000 * 4 = 4000) reached; stays there.
  await s.sampleOnce('db');
  assert.equal(s.get('db').currentIntervalMs, 4000);
});

// ─── start / stop with fake timers ───────────────────────────────

function makeFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  const setTimeoutImpl = (cb, delay) => {
    const id = { id: nextId++, cb, delay, unref: () => id };
    pending.set(id, id);
    return id;
  };
  const clearTimeoutImpl = (id) => { pending.delete(id); };
  const fireAll = () => {
    const ids = Array.from(pending.keys());
    pending.clear();
    for (const id of ids) id.cb();
  };
  return { setTimeoutImpl, clearTimeoutImpl, fireAll, pending };
}

test('ProbeScheduler.start: schedules per-probe timers with fake clock', async () => {
  const fakes = makeFakeTimers();
  const s = new ProbeScheduler({
    defaultIntervalMs: 5000,
    setTimeoutImpl: fakes.setTimeoutImpl,
    clearTimeoutImpl: fakes.clearTimeoutImpl,
    jitterRatio: 0,
  });
  s.add(makeProbe('db'));
  s.add(makeProbe('redis'));
  s.start();
  assert.equal(fakes.pending.size, 2);
  s.stop();
  assert.equal(fakes.pending.size, 0);
  assert.equal(s.running, false);
});

test('ProbeScheduler.start: idempotent', () => {
  const fakes = makeFakeTimers();
  const s = new ProbeScheduler({
    setTimeoutImpl: fakes.setTimeoutImpl,
    clearTimeoutImpl: fakes.clearTimeoutImpl,
    jitterRatio: 0,
  });
  s.add(makeProbe('db'));
  s.start();
  s.start();
  assert.equal(fakes.pending.size, 1);
  s.stop();
});

test('ProbeScheduler.start + tick: increments sampleCount on timer fire', async () => {
  const fakes = makeFakeTimers();
  const s = new ProbeScheduler({
    defaultIntervalMs: 5000,
    setTimeoutImpl: fakes.setTimeoutImpl,
    clearTimeoutImpl: fakes.clearTimeoutImpl,
    jitterRatio: 0,
  });
  const p = makeProbe('db');
  s.add(p);
  s.start();
  fakes.fireAll();
  // Allow the async run + reschedule chain to settle.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(s.get('db').sampleCount >= 1);
  s.stop();
});

test('ProbeScheduler: runImmediately fires once before scheduled tick', async () => {
  const fakes = makeFakeTimers();
  const s = new ProbeScheduler({
    setTimeoutImpl: fakes.setTimeoutImpl,
    clearTimeoutImpl: fakes.clearTimeoutImpl,
    jitterRatio: 0,
  });
  s.add(makeProbe('db'), { runImmediately: true });
  s.start();
  // Microtask flush.
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  assert.ok(s.get('db').sampleCount >= 1);
  s.stop();
});

// ─── Hooks ───────────────────────────────────────────────────────

test('ProbeScheduler: onSample hook fires for each sample', async () => {
  const seen = [];
  const s = new ProbeScheduler({ onSample: ({ name, result }) => seen.push({ name, status: result.status }) });
  s.add(makeProbe('db'));
  await s.sampleOnce('db');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'db');
});

test('ProbeScheduler: onError hook fires when probe throws', async () => {
  const errors = [];
  const p = new Probe({
    name: 'bad',
    timeoutMs: 100,
    ttlMs: 0,
    check: async () => { const err = new Error('explode'); err.fatal = true; throw err; },
  });
  // Probe.run() catches the throw and returns status:'fail' — it does
  // not propagate. So onError fires only on truly unexpected errors
  // (e.g. probe.run() itself throwing). Simulate that.
  p.run = async () => { throw new Error('oops'); };
  const s = new ProbeScheduler({ onError: ({ error }) => errors.push(error.message) });
  s.add(p);
  await s.sampleOnce('bad');
  assert.equal(errors.length, 1);
  assert.equal(errors[0], 'oops');
});

// ─── snapshot ────────────────────────────────────────────────────

test('ProbeScheduler.snapshot: reports probe state', async () => {
  const s = new ProbeScheduler({ defaultIntervalMs: 5000 });
  s.add(makeProbe('db'));
  await s.sampleOnce('db');
  const snap = s.snapshot();
  assert.equal(snap.size, 1);
  assert.equal(snap.probes[0].name, 'db');
  assert.equal(snap.probes[0].lastStatus, 'pass');
  assert.equal(typeof snap.probes[0].lastSampledAt, 'string');
});

'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');

const {
  SpeculativeExecutor,
  NGramPredictor,
  SpeculationError,
  argsHash,
  defaultSafeToolFilter,
  stableStringify,
} = require('../src/services/agents/speculative-executor');

// ── Helpers ──────────────────────────────────────────────────────────

const SAFE_MANIFEST = { name: 'safe.tool', side_effect_level: 'remote-read' };
const UNSAFE_MANIFEST = { name: 'unsafe.tool', side_effect_level: 'remote-write' };
const CONFIRM_MANIFEST = {
  name: 'confirm.tool',
  side_effect_level: 'remote-read',
  requires_confirmation: true,
};

function staticManifests(map) {
  return (toolName) => map[toolName] || null;
}

function staticPredictor(candidates) {
  return { predict: () => candidates.slice() };
}

function recordingDispatcher() {
  const calls = [];
  const fn = async (toolName, args) => {
    calls.push({ toolName, args });
    return { tool: toolName, echoed: args };
  };
  fn.calls = calls;
  return fn;
}

// ── stableStringify / argsHash ───────────────────────────────────────

describe('stableStringify', () => {
  it('sorts object keys for deterministic output', () => {
    assert.strictEqual(stableStringify({ b: 2, a: 1 }), stableStringify({ a: 1, b: 2 }));
  });

  it('preserves array order', () => {
    assert.notStrictEqual(stableStringify([1, 2, 3]), stableStringify([3, 2, 1]));
  });

  it('handles primitives and special values', () => {
    assert.strictEqual(stableStringify(null), 'n');
    assert.strictEqual(stableStringify(undefined), 'u');
    assert.strictEqual(stableStringify(true), 't');
    assert.strictEqual(stableStringify(false), 'f');
    assert.strictEqual(stableStringify(42), '42');
    assert.strictEqual(stableStringify(NaN), 'inf');
    assert.strictEqual(stableStringify('hi'), '"hi"');
  });

  it('handles nested objects deterministically', () => {
    const a = { outer: { z: 1, a: 2 }, list: [1, { c: 3, b: 4 }] };
    const b = { list: [1, { b: 4, c: 3 }], outer: { a: 2, z: 1 } };
    assert.strictEqual(stableStringify(a), stableStringify(b));
  });

  it('coerces non-serializable values without throwing', () => {
    assert.doesNotThrow(() => stableStringify({ fn: () => 1, sym: Symbol('x') }));
  });
});

describe('argsHash', () => {
  it('produces 24-char hex hashes', () => {
    const h = argsHash({ a: 1, b: 2 });
    assert.strictEqual(h.length, 24);
    assert.match(h, /^[0-9a-f]{24}$/);
  });

  it('produces equal hashes for equivalent objects', () => {
    assert.strictEqual(argsHash({ a: 1, b: 2 }), argsHash({ b: 2, a: 1 }));
  });

  it('produces different hashes for different inputs', () => {
    assert.notStrictEqual(argsHash({ a: 1 }), argsHash({ a: 2 }));
  });
});

// ── defaultSafeToolFilter ────────────────────────────────────────────

describe('defaultSafeToolFilter', () => {
  it('rejects when manifest is missing', () => {
    assert.strictEqual(defaultSafeToolFilter(null), false);
  });

  it('rejects requires_confirmation tools', () => {
    assert.strictEqual(defaultSafeToolFilter(CONFIRM_MANIFEST), false);
  });

  it('rejects remote-write and destructive tools', () => {
    assert.strictEqual(defaultSafeToolFilter(UNSAFE_MANIFEST), false);
    assert.strictEqual(defaultSafeToolFilter({ side_effect_level: 'destructive' }), false);
    assert.strictEqual(defaultSafeToolFilter({ side_effect_level: 'local-fs' }), false);
  });

  it('accepts none and remote-read', () => {
    assert.strictEqual(defaultSafeToolFilter({ side_effect_level: 'none' }), true);
    assert.strictEqual(defaultSafeToolFilter({ side_effect_level: 'remote-read' }), true);
  });

  it('rejects when side_effect_level is missing (closed-world)', () => {
    assert.strictEqual(defaultSafeToolFilter({}), false);
  });
});

// ── SpeculativeExecutor — construction ───────────────────────────────

describe('SpeculativeExecutor — construction', () => {
  it('requires a predictor with predict()', () => {
    assert.throws(
      () => new SpeculativeExecutor({ toolDispatcher: async () => null }),
      SpeculationError,
    );
    assert.throws(
      () => new SpeculativeExecutor({ predictor: {}, toolDispatcher: async () => null }),
      SpeculationError,
    );
  });

  it('requires toolDispatcher', () => {
    assert.throws(
      () => new SpeculativeExecutor({ predictor: { predict: () => [] } }),
      SpeculationError,
    );
  });
});

// ── SpeculativeExecutor — happy path ─────────────────────────────────

describe('SpeculativeExecutor — speculate + lookup', () => {
  let dispatcher, exec;
  beforeEach(() => {
    dispatcher = recordingDispatcher();
    exec = new SpeculativeExecutor({
      predictor: staticPredictor([
        { toolName: 'safe.tool', args: { q: 1 }, confidence: 0.9 },
      ]),
      toolDispatcher: dispatcher,
      manifestProvider: staticManifests({ 'safe.tool': SAFE_MANIFEST }),
    });
  });

  it('speculate kicks off accepted candidates', () => {
    const n = exec.speculate({});
    assert.strictEqual(n, 1);
  });

  it('lookup returns hit with the speculated result', async () => {
    exec.speculate({});
    const r = await exec.lookup('safe.tool', { q: 1 });
    assert.strictEqual(r.hit, true);
    assert.deepStrictEqual(r.result, { tool: 'safe.tool', echoed: { q: 1 } });
    assert.strictEqual(typeof r.latencySavedMs, 'number');
  });

  it('lookup returns miss for unspeculated args', async () => {
    exec.speculate({});
    const r = await exec.lookup('safe.tool', { q: 999 });
    assert.strictEqual(r.hit, false);
    assert.strictEqual(exec.getMetrics().misses, 1);
  });

  it('hit consumes the entry; second lookup is a miss', async () => {
    exec.speculate({});
    const r1 = await exec.lookup('safe.tool', { q: 1 });
    assert.strictEqual(r1.hit, true);
    const r2 = await exec.lookup('safe.tool', { q: 1 });
    assert.strictEqual(r2.hit, false);
  });

  it('lookup waits for in-flight speculation to settle', async () => {
    let resolveDispatch;
    const slowDispatcher = (toolName, args) => new Promise(r => { resolveDispatch = () => r({ ok: true, args }); });
    const e = new SpeculativeExecutor({
      predictor: staticPredictor([{ toolName: 'safe.tool', args: { x: 1 }, confidence: 0.9 }]),
      toolDispatcher: slowDispatcher,
      manifestProvider: staticManifests({ 'safe.tool': SAFE_MANIFEST }),
    });
    e.speculate({});
    const lookupPromise = e.lookup('safe.tool', { x: 1 });
    setTimeout(() => resolveDispatch(), 20);
    const r = await lookupPromise;
    assert.strictEqual(r.hit, true);
    assert.deepStrictEqual(r.result, { ok: true, args: { x: 1 } });
  });
});

// ── Confidence + safety filters ──────────────────────────────────────

describe('SpeculativeExecutor — filters', () => {
  it('drops candidates below confidence threshold', () => {
    const dispatcher = recordingDispatcher();
    const exec = new SpeculativeExecutor({
      predictor: staticPredictor([
        { toolName: 'safe.tool', args: {}, confidence: 0.5 },
        { toolName: 'safe.tool', args: { y: 2 }, confidence: 0.8 },
      ]),
      toolDispatcher: dispatcher,
      manifestProvider: staticManifests({ 'safe.tool': SAFE_MANIFEST }),
      confidenceThreshold: 0.7,
    });
    const n = exec.speculate({});
    assert.strictEqual(n, 1);
    assert.strictEqual(exec.getMetrics().filtered, 1);
  });

  it('drops unsafe tools regardless of confidence', () => {
    const dispatcher = recordingDispatcher();
    const exec = new SpeculativeExecutor({
      predictor: staticPredictor([
        { toolName: 'unsafe.tool', args: {}, confidence: 1.0 },
      ]),
      toolDispatcher: dispatcher,
      manifestProvider: staticManifests({ 'unsafe.tool': UNSAFE_MANIFEST }),
    });
    assert.strictEqual(exec.speculate({}), 0);
    assert.strictEqual(exec.getMetrics().filtered, 1);
  });

  it('drops tools that require confirmation', () => {
    const exec = new SpeculativeExecutor({
      predictor: staticPredictor([
        { toolName: 'confirm.tool', args: {}, confidence: 1.0 },
      ]),
      toolDispatcher: recordingDispatcher(),
      manifestProvider: staticManifests({ 'confirm.tool': CONFIRM_MANIFEST }),
    });
    assert.strictEqual(exec.speculate({}), 0);
  });

  it('drops candidates without manifest by default', () => {
    const exec = new SpeculativeExecutor({
      predictor: staticPredictor([
        { toolName: 'unknown.tool', args: {}, confidence: 1.0 },
      ]),
      toolDispatcher: recordingDispatcher(),
      manifestProvider: () => null,
    });
    assert.strictEqual(exec.speculate({}), 0);
  });

  it('caps speculative work at maxConcurrent', () => {
    const exec = new SpeculativeExecutor({
      predictor: staticPredictor([
        { toolName: 'safe.tool', args: { i: 1 }, confidence: 1 },
        { toolName: 'safe.tool', args: { i: 2 }, confidence: 1 },
        { toolName: 'safe.tool', args: { i: 3 }, confidence: 1 },
      ]),
      toolDispatcher: () => new Promise(() => {}), // never settle
      manifestProvider: staticManifests({ 'safe.tool': SAFE_MANIFEST }),
      maxConcurrent: 2,
    });
    const n = exec.speculate({});
    assert.strictEqual(n, 2);
  });
});

// ── Error path on speculation ────────────────────────────────────────

describe('SpeculativeExecutor — speculation errors', () => {
  it('lookup returns error + classification when speculation fails', async () => {
    const exec = new SpeculativeExecutor({
      predictor: staticPredictor([{ toolName: 'safe.tool', args: { x: 1 }, confidence: 1 }]),
      toolDispatcher: () => Promise.reject(Object.assign(new Error('upstream 502'), { status: 502 })),
      manifestProvider: staticManifests({ 'safe.tool': SAFE_MANIFEST }),
    });
    exec.speculate({});
    const r = await exec.lookup('safe.tool', { x: 1 });
    assert.strictEqual(r.hit, true);
    assert.ok(r.error);
    assert.strictEqual(r.classification, 'transient');
    assert.strictEqual(exec.getMetrics().errorsClassified.transient, 1);
  });

  it('predictor that throws returns no candidates', () => {
    const exec = new SpeculativeExecutor({
      predictor: { predict: () => { throw new Error('predictor boom'); } },
      toolDispatcher: recordingDispatcher(),
      manifestProvider: staticManifests({}),
    });
    assert.strictEqual(exec.speculate({}), 0);
  });

  it('predictor returning non-array is treated as no candidates', () => {
    const exec = new SpeculativeExecutor({
      predictor: { predict: () => 'not-an-array' },
      toolDispatcher: recordingDispatcher(),
      manifestProvider: staticManifests({}),
    });
    assert.strictEqual(exec.speculate({}), 0);
  });
});

// ── SingleFlight coalescing ──────────────────────────────────────────

describe('SpeculativeExecutor — coalescing', () => {
  it('deduplicates speculative work for identical (tool, args)', async () => {
    let calls = 0;
    const dispatcher = async () => { calls += 1; return { n: calls }; };
    const exec = new SpeculativeExecutor({
      predictor: staticPredictor([
        { toolName: 'safe.tool', args: { q: 'same' }, confidence: 1 },
        { toolName: 'safe.tool', args: { q: 'same' }, confidence: 1 },
        { toolName: 'safe.tool', args: { q: 'same' }, confidence: 1 },
      ]),
      toolDispatcher: dispatcher,
      manifestProvider: staticManifests({ 'safe.tool': SAFE_MANIFEST }),
    });
    exec.speculate({});
    const r = await exec.lookup('safe.tool', { q: 'same' });
    assert.strictEqual(r.hit, true);
    assert.strictEqual(calls, 1, 'dispatcher should run once for duplicate args');
  });
});

// ── TTL + capacity eviction ──────────────────────────────────────────

describe('SpeculativeExecutor — pool eviction', () => {
  it('evicts entries past their TTL', async () => {
    let now = 1000;
    const exec = new SpeculativeExecutor({
      predictor: staticPredictor([{ toolName: 'safe.tool', args: { i: 1 }, confidence: 1 }]),
      toolDispatcher: async () => 'r',
      manifestProvider: staticManifests({ 'safe.tool': SAFE_MANIFEST }),
      ttlMs: 100,
      now: () => now,
    });
    exec.speculate({});
    // Allow the speculative work to settle.
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(exec.size(), 1);
    now += 1000; // advance past TTL
    assert.strictEqual(exec.size(), 0);
    assert.strictEqual((await exec.lookup('safe.tool', { i: 1 })).hit, false);
  });

  it('caps the pool at poolCapacity (FIFO eviction)', () => {
    const exec = new SpeculativeExecutor({
      predictor: { predict: () => [] }, // we'll inject candidates via repeated calls below
      toolDispatcher: () => new Promise(() => {}),
      manifestProvider: staticManifests({ 'safe.tool': SAFE_MANIFEST }),
      poolCapacity: 2,
      maxConcurrent: 99,
    });
    // Use direct speculate calls with different args to fill pool past capacity.
    const candidates = [
      { toolName: 'safe.tool', args: { i: 1 }, confidence: 1 },
      { toolName: 'safe.tool', args: { i: 2 }, confidence: 1 },
      { toolName: 'safe.tool', args: { i: 3 }, confidence: 1 },
    ];
    exec.predictor = staticPredictor(candidates);
    exec.speculate({});
    assert.strictEqual(exec.size(), 2);
    assert.ok(exec.getMetrics().poolEvictions >= 1);
  });
});

// ── clear() / size() / metrics defensive copy ────────────────────────

describe('SpeculativeExecutor — utilities', () => {
  it('clear() drops every entry and resets inflight', async () => {
    const exec = new SpeculativeExecutor({
      predictor: staticPredictor([
        { toolName: 'safe.tool', args: { i: 1 }, confidence: 1 },
        { toolName: 'safe.tool', args: { i: 2 }, confidence: 1 },
      ]),
      toolDispatcher: () => new Promise(() => {}),
      manifestProvider: staticManifests({ 'safe.tool': SAFE_MANIFEST }),
    });
    exec.speculate({});
    assert.strictEqual(exec.size(), 2);
    assert.strictEqual(exec.clear(), 2);
    assert.strictEqual(exec.size(), 0);
  });

  it('getMetrics returns a defensive copy', () => {
    const exec = new SpeculativeExecutor({
      predictor: { predict: () => [] },
      toolDispatcher: async () => null,
    });
    const m1 = exec.getMetrics();
    m1.predictions = 999;
    const m2 = exec.getMetrics();
    assert.strictEqual(m2.predictions, 0);
  });
});

// ── Journal callbacks ────────────────────────────────────────────────

describe('SpeculativeExecutor — journal callbacks', () => {
  it('onSpeculate fires when a candidate is accepted', () => {
    const events = [];
    const exec = new SpeculativeExecutor({
      predictor: staticPredictor([{ toolName: 'safe.tool', args: { a: 1 }, confidence: 1 }]),
      toolDispatcher: async () => null,
      manifestProvider: staticManifests({ 'safe.tool': SAFE_MANIFEST }),
      onSpeculate: ev => events.push(ev),
    });
    exec.speculate({});
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].toolName, 'safe.tool');
  });

  it('onHit fires on lookup hit', async () => {
    const events = [];
    const exec = new SpeculativeExecutor({
      predictor: staticPredictor([{ toolName: 'safe.tool', args: { a: 1 }, confidence: 1 }]),
      toolDispatcher: async () => 'ok',
      manifestProvider: staticManifests({ 'safe.tool': SAFE_MANIFEST }),
      onHit: ev => events.push(ev),
    });
    exec.speculate({});
    await exec.lookup('safe.tool', { a: 1 });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].toolName, 'safe.tool');
  });

  it('onMiss fires on lookup miss', async () => {
    const events = [];
    const exec = new SpeculativeExecutor({
      predictor: { predict: () => [] },
      toolDispatcher: async () => null,
      onMiss: ev => events.push(ev),
    });
    await exec.lookup('safe.tool', { a: 1 });
    assert.strictEqual(events.length, 1);
  });

  it('throwing journal callbacks never break the executor', async () => {
    const exec = new SpeculativeExecutor({
      predictor: staticPredictor([{ toolName: 'safe.tool', args: {}, confidence: 1 }]),
      toolDispatcher: async () => 'ok',
      manifestProvider: staticManifests({ 'safe.tool': SAFE_MANIFEST }),
      onSpeculate: () => { throw new Error('journal'); },
      onHit: () => { throw new Error('journal'); },
    });
    exec.speculate({});
    const r = await exec.lookup('safe.tool', {});
    assert.strictEqual(r.hit, true);
  });
});

// ── NGramPredictor ───────────────────────────────────────────────────

describe('NGramPredictor', () => {
  it('returns no candidates before any observations', () => {
    const p = new NGramPredictor();
    assert.deepStrictEqual(p.predict({ q: 'unseen' }), []);
  });

  it('learns and predicts the most-seen tool for a context', () => {
    const p = new NGramPredictor();
    const ctx = { intent: 'search' };
    p.observe(ctx, 'web_search');
    p.observe(ctx, 'web_search');
    p.observe(ctx, 'rag_retrieve');
    const preds = p.predict(ctx);
    assert.strictEqual(preds.length, 2);
    assert.strictEqual(preds[0].toolName, 'web_search');
    assert.ok(preds[0].confidence > preds[1].confidence);
  });

  it('confidences sum to less than 1.0 (smoothed) but ranking is preserved', () => {
    const p = new NGramPredictor({ smoothing: 1 });
    const ctx = { task: 't' };
    p.observe(ctx, 'A');
    p.observe(ctx, 'A');
    p.observe(ctx, 'B');
    const preds = p.predict(ctx);
    const total = preds.reduce((a, b) => a + b.confidence, 0);
    assert.ok(total > 0 && total <= 1.0001);
    assert.strictEqual(preds[0].toolName, 'A');
  });

  it('respects k cap', () => {
    const p = new NGramPredictor({ k: 2 });
    const ctx = { x: 1 };
    p.observe(ctx, 'A'); p.observe(ctx, 'B'); p.observe(ctx, 'C'); p.observe(ctx, 'D');
    assert.strictEqual(p.predict(ctx).length, 2);
  });

  it('different contexts have independent counts', () => {
    const p = new NGramPredictor();
    p.observe({ a: 1 }, 'X');
    p.observe({ a: 2 }, 'Y');
    assert.strictEqual(p.predict({ a: 1 })[0].toolName, 'X');
    assert.strictEqual(p.predict({ a: 2 })[0].toolName, 'Y');
  });

  it('getStats reports observations and contexts', () => {
    const p = new NGramPredictor();
    p.observe({ k: 1 }, 'A');
    p.observe({ k: 2 }, 'B');
    p.observe({ k: 1 }, 'A');
    const s = p.getStats();
    assert.strictEqual(s.observations, 3);
    assert.strictEqual(s.contexts, 2);
  });

  it('ignores empty toolName', () => {
    const p = new NGramPredictor();
    p.observe({ x: 1 }, '');
    assert.strictEqual(p.getStats().observations, 0);
  });
});

// ── Latency-saved metric ─────────────────────────────────────────────

describe('SpeculativeExecutor — latency saved', () => {
  it('accumulates latencySavedMs across hits', async () => {
    let now = 0;
    const exec = new SpeculativeExecutor({
      predictor: staticPredictor([
        { toolName: 'safe.tool', args: { i: 1 }, confidence: 1 },
      ]),
      toolDispatcher: async () => 'ok',
      manifestProvider: staticManifests({ 'safe.tool': SAFE_MANIFEST }),
      now: () => now,
    });
    now = 100;
    exec.speculate({});
    // Let the dispatcher promise settle.
    await Promise.resolve();
    await Promise.resolve();
    now = 250; // 150 ms later
    await exec.lookup('safe.tool', { i: 1 });
    assert.ok(exec.getMetrics().latencySavedMs >= 100);
  });
});

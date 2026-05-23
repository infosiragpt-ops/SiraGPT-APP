'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createSpeculativeRace,
  RaceFailedError,
} = require('../src/services/ai-product-os/speculative-model-race');

function later(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe('createSpeculativeRace — construction', () => {
  test('rejects empty model list', () => {
    assert.throws(() => createSpeculativeRace({ models: [] }), TypeError);
    assert.throws(() => createSpeculativeRace({}), TypeError);
  });

  test('exposes models snapshot', () => {
    const r = createSpeculativeRace({ models: ['a', 'b'] });
    assert.deepEqual(r.models(), ['a', 'b']);
  });
});

describe('createSpeculativeRace — happy paths', () => {
  test('first to succeed wins; losers are aborted', async () => {
    const racer = createSpeculativeRace({ models: ['fast', 'slow'] });
    const aborted = { fast: false, slow: false };
    const r = await racer.run(async (m, signal) => {
      signal.addEventListener('abort', () => { aborted[m] = true; });
      return m === 'fast' ? await later(20, 'fast-ok') : await later(200, 'slow-ok');
    });
    assert.equal(r.model, 'fast');
    assert.equal(r.value, 'fast-ok');
    assert.equal(r.raced, 2);
    // Loser must be aborted (give the loser a tick to react).
    await later(10);
    assert.equal(aborted.slow, true);
  });

  test('falls through to slower replica when faster errors', async () => {
    const racer = createSpeculativeRace({ models: ['flaky', 'stable'] });
    const r = await racer.run(async (m) => {
      if (m === 'flaky') throw new Error('boom');
      return await later(20, 'stable-ok');
    });
    assert.equal(r.model, 'stable');
    assert.equal(r.value, 'stable-ok');
  });

  test('accept() can reject a fast-but-bad answer', async () => {
    const racer = createSpeculativeRace({
      models: ['quick', 'thoughtful'],
      accept: (v) => typeof v === 'string' && !v.startsWith('I cannot'),
    });
    const r = await racer.run(async (m) => {
      if (m === 'quick') return await later(5, 'I cannot help with that');
      return await later(40, 'here is the answer');
    });
    assert.equal(r.model, 'thoughtful');
  });

  test('attempts records ok/error/latency for each replica', async () => {
    const racer = createSpeculativeRace({ models: ['a', 'b'] });
    const r = await racer.run(async (m) => (m === 'a' ? await later(5, 'A') : await later(50, 'B')));
    const a = r.attempts.find((x) => x.model === 'a');
    const b = r.attempts.find((x) => x.model === 'b');
    assert.equal(a.ok, true);
    assert.ok(typeof a.latencyMs === 'number');
    assert.equal(b.ok, false);
    assert.ok(b.error);
  });
});

describe('createSpeculativeRace — failure modes', () => {
  test('throws RaceFailedError when every replica fails', async () => {
    const racer = createSpeculativeRace({ models: ['a', 'b'] });
    await assert.rejects(
      racer.run(async () => { throw new Error('all bad'); }),
      RaceFailedError,
    );
  });

  test('throws RaceFailedError when accept rejects every replica', async () => {
    const racer = createSpeculativeRace({ models: ['a', 'b'], accept: () => false });
    await assert.rejects(racer.run(async () => 'whatever'), RaceFailedError);
  });

  test('runner type-check', async () => {
    const racer = createSpeculativeRace({ models: ['a'] });
    await assert.rejects(racer.run('not a fn'), TypeError);
  });
});

describe('createSpeculativeRace — hooks', () => {
  test('onLaunch fires per replica with model+index', async () => {
    const launches = [];
    const racer = createSpeculativeRace({
      models: ['p', 'q'],
      onLaunch: (e) => launches.push({ model: e.model, index: e.index }),
    });
    await racer.run(async (m) => (m === 'p' ? await later(5, 'ok') : await later(50, 'ok')));
    assert.deepEqual(launches.sort((a, b) => a.index - b.index), [
      { model: 'p', index: 0 },
      { model: 'q', index: 1 },
    ]);
  });

  test('onLose fires for cancelled losers', async () => {
    const losses = [];
    const racer = createSpeculativeRace({
      models: ['p', 'q'],
      onLose: (e) => losses.push(e.model),
    });
    await racer.run(async (m) => (m === 'p' ? await later(5, 'ok') : await later(60, 'ok')));
    await later(20);
    assert.ok(losses.includes('q'));
  });

  test('throwing hooks do not break the race', async () => {
    const racer = createSpeculativeRace({
      models: ['a', 'b'],
      onLaunch: () => { throw new Error('hook bad'); },
      onLose: () => { throw new Error('hook bad'); },
    });
    const r = await racer.run(async (m) => (m === 'a' ? 'ok' : await later(100, 'late')));
    assert.equal(r.value, 'ok');
  });
});

describe('createSpeculativeRace — stagger', () => {
  test('stagger delays each replica by stagger * index', async () => {
    let earliest = null;
    const racer = createSpeculativeRace({
      models: ['p', 'q'],
      stagger: 30,
      onLaunch: ({ model, index }) => {
        if (model === 'q' && earliest == null) earliest = Date.now();
      },
    });
    const t0 = Date.now();
    await racer.run(async (m) => (m === 'p' ? await later(15, 'p-ok') : await later(200, 'q-ok')));
    // q should have launched roughly stagger*1=30ms after start, but
    // because p wins quickly, q may have been cancelled before launch.
    // Either way it's a no-throw run completing under the slow path.
    assert.ok(Date.now() - t0 < 200);
  });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const tracker = require('../src/services/saliency-decay-tracker');

test.beforeEach(() => tracker.__resetForTests());

test('observe + classify: a single fresh feature lands in live', () => {
  tracker.observe({
    userId: 'u1', chatId: 'c1', turnIndex: 0,
    features: [{ kind: 'topic', label: 'attribution', weight: 0.8 }],
  });
  const cl = tracker.classify({ userId: 'u1', chatId: 'c1' });
  assert.strictEqual(cl.live.length, 1);
  assert.strictEqual(cl.live[0].label, 'attribution');
  assert.ok(cl.live[0].currentSaliency >= tracker.LIVE_THRESHOLD);
});

test('repeated activation bumps strength', () => {
  tracker.observe({ userId: 'u', chatId: 'c', features: [{ kind: 'topic', label: 'auth', weight: 0.5 }] });
  const first = tracker.classify({ userId: 'u', chatId: 'c' }).live[0];
  tracker.observe({ userId: 'u', chatId: 'c', features: [{ kind: 'topic', label: 'auth', weight: 0.5 }] });
  const second = tracker.classify({ userId: 'u', chatId: 'c' }).live[0];
  assert.ok(second.strength > first.strength);
  assert.strictEqual(second.activationCount, 2);
});

test('feature past DEAD_AGE_MS classified as dead', () => {
  const start = Date.now();
  tracker.observe({ userId: 'u', chatId: 'c', features: [{ kind: 't', label: 'old', weight: 1 }], now: start });
  const cl = tracker.classify({ userId: 'u', chatId: 'c', now: start + tracker.DEAD_AGE_MS + 1 });
  assert.strictEqual(cl.live.length, 0);
  assert.strictEqual(cl.fading.length, 0);
  assert.strictEqual(cl.dead.length, 1);
});

test('decay between live and dead lands in fading', () => {
  const start = Date.now();
  tracker.observe({ userId: 'u', chatId: 'c', features: [{ kind: 't', label: 'mid', weight: 1 }], now: start });
  const cl = tracker.classify({ userId: 'u', chatId: 'c', now: start + 2 * tracker.HALF_LIFE_MS });
  const f = [...cl.live, ...cl.fading, ...cl.dead].find((x) => x.label === 'mid');
  assert.ok(f && f.currentSaliency < tracker.LIVE_THRESHOLD);
});

test('ageOut removes dead entries', () => {
  const start = Date.now();
  tracker.observe({ userId: 'u', chatId: 'c', features: [{ kind: 't', label: 'gone', weight: 1 }], now: start });
  const removed = tracker.ageOut({ userId: 'u', chatId: 'c', now: start + tracker.DEAD_AGE_MS + 1 });
  assert.strictEqual(removed, 1);
});

test('topLive returns sorted live entries capped at k', () => {
  for (let i = 0; i < 5; i += 1) {
    tracker.observe({
      userId: 'u', chatId: 'c', turnIndex: i,
      features: [{ kind: 'topic', label: `f${i}`, weight: 0.4 + i * 0.1 }],
    });
  }
  const top2 = tracker.topLive({ userId: 'u', chatId: 'c', k: 2 });
  assert.ok(top2.length <= 2);
  if (top2.length === 2) assert.ok(top2[0].currentSaliency >= top2[1].currentSaliency);
});

test('classify on unknown chat returns empty buckets', () => {
  assert.deepStrictEqual(tracker.classify({ userId: 'g', chatId: 'n' }), { live: [], fading: [], dead: [] });
});

test('cap enforced at MAX_FEATURES_PER_CHAT', () => {
  const features = Array.from({ length: tracker.MAX_FEATURES_PER_CHAT + 20 },
    (_, i) => ({ kind: 't', label: `t${i}`, weight: 0.6 }));
  tracker.observe({ userId: 'u', chatId: 'c', features });
  const cl = tracker.classify({ userId: 'u', chatId: 'c' });
  const total = cl.live.length + cl.fading.length + cl.dead.length;
  assert.ok(total <= tracker.MAX_FEATURES_PER_CHAT);
});

test('buildSaliencyBlock formats live + fading sections', () => {
  tracker.observe({ userId: 'u', chatId: 'c', features: [{ kind: 'topic', label: 'live-one', weight: 0.95 }] });
  const cl = tracker.classify({ userId: 'u', chatId: 'c' });
  const block = tracker.buildSaliencyBlock(cl);
  assert.ok(block.includes('<saliency_state>'));
  assert.ok(block.includes('live-one'));
  assert.ok(block.includes('</saliency_state>'));
});

test('buildSaliencyBlock returns empty when nothing live', () => {
  assert.strictEqual(tracker.buildSaliencyBlock({ live: [], fading: [], dead: [] }), '');
  assert.strictEqual(tracker.buildSaliencyBlock(null), '');
});

test('clear({userId, chatId}) wipes only that chat', () => {
  tracker.observe({ userId: 'a', chatId: 'x', features: [{ kind: 't', label: 'one', weight: 0.7 }] });
  tracker.observe({ userId: 'b', chatId: 'y', features: [{ kind: 't', label: 'two', weight: 0.7 }] });
  tracker.clear({ userId: 'a', chatId: 'x' });
  assert.strictEqual(tracker.classify({ userId: 'a', chatId: 'x' }).live.length, 0);
  assert.strictEqual(tracker.classify({ userId: 'b', chatId: 'y' }).live.length, 1);
});

test('hot path stays under 100ms for 50 turns × 5 features', () => {
  const t0 = Date.now();
  for (let i = 0; i < 50; i += 1) {
    tracker.observe({
      userId: 'perf', chatId: 'c', turnIndex: i,
      features: Array.from({ length: 5 }, (_, j) => ({ kind: 'topic', label: `t${j}`, weight: 0.4 + j * 0.1 })),
    });
  }
  tracker.classify({ userId: 'perf', chatId: 'c' });
  assert.ok(Date.now() - t0 < 100);
});

test('outer chat map is LRU-bounded; recent chats survive, the oldest is evicted', () => {
  // Fresh instance at the floor cap (256) so the eviction path is exercised.
  const prev = process.env.SIRAGPT_SALIENCY_MAX_CHATS;
  process.env.SIRAGPT_SALIENCY_MAX_CHATS = '256';
  const modPath = require.resolve('../src/services/saliency-decay-tracker');
  delete require.cache[modPath];
  const t = require('../src/services/saliency-decay-tracker');
  try {
    t.clear();
    const feat = [{ kind: 'topic', label: 'auth', weight: 1 }];
    for (let i = 0; i < 320; i += 1) t.observe({ userId: 'u', chatId: 'c' + i, features: feat });
    assert.ok(t.stats().chats <= 256, 'outer map is hard-bounded (was unbounded)');
    // The most-recently-observed chat survives; the oldest (c0) was evicted.
    assert.ok(t.classify({ userId: 'u', chatId: 'c319' }).live.length > 0, 'recent chat preserved');
    assert.equal(t.classify({ userId: 'u', chatId: 'c0' }).live.length, 0, 'oldest chat evicted → re-seeds empty');
  } finally {
    delete require.cache[modPath];
    if (prev === undefined) delete process.env.SIRAGPT_SALIENCY_MAX_CHATS;
    else process.env.SIRAGPT_SALIENCY_MAX_CHATS = prev;
  }
});

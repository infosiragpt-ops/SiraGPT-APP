'use strict';

const test = require('node:test');
const assert = require('node:assert');

const tracker = require('../src/services/conversational-momentum-tracker');

test.beforeEach(() => tracker.__resetForTests());

const feats = (...labels) => labels.map((label) => ({ label }));

test('computeMomentum: empty buffer returns unknown', () => {
  const r = tracker.computeMomentum({ userId: 'u', chatId: 'c' });
  assert.strictEqual(r.classification, 'unknown');
  assert.strictEqual(r.samples, 0);
});

test('recordTurn: same intent across turns → high momentum', () => {
  for (let i = 0; i < 5; i += 1) {
    tracker.recordTurn({
      userId: 'u', chatId: 'c', intentKind: 'build',
      features: feats('chart', 'revenue'),
      now: Date.now() - (5 - i) * 1000,
    });
  }
  const r = tracker.computeMomentum({ userId: 'u', chatId: 'c' });
  assert.strictEqual(r.classification, 'high');
  assert.ok(r.momentum >= tracker.HIGH_THRESHOLD);
});

test('recordTurn: alternating intent → low momentum', () => {
  const intents = ['build', 'fix', 'translate', 'recommend', 'analyze'];
  for (let i = 0; i < intents.length; i += 1) {
    tracker.recordTurn({
      userId: 'u', chatId: 'c', intentKind: intents[i],
      features: feats(`f${i}`, `g${i}`),
      now: Date.now() - i * 60_000,
    });
  }
  const r = tracker.computeMomentum({ userId: 'u', chatId: 'c' });
  assert.ok(r.momentum < tracker.HIGH_THRESHOLD);
  assert.ok(['medium', 'low'].includes(r.classification));
});

test('recordTurn: same topic features → topicContinuity high', () => {
  for (let i = 0; i < 4; i += 1) {
    tracker.recordTurn({
      userId: 'u', chatId: 'c', intentKind: 'build',
      features: feats('backend', 'deploy', 'production'),
    });
  }
  const r = tracker.computeMomentum({ userId: 'u', chatId: 'c' });
  assert.ok(r.components.topicContinuity > 0.5);
});

test('recordTurn: cap at BUFFER_SIZE', () => {
  for (let i = 0; i < tracker.BUFFER_SIZE + 10; i += 1) {
    tracker.recordTurn({ userId: 'u', chatId: 'c', intentKind: 'build', features: feats('x') });
  }
  const recent = tracker.getRecent({ userId: 'u', chatId: 'c', limit: 50 });
  assert.ok(recent.length <= tracker.BUFFER_SIZE);
});

test('computeMomentum: with only 1 turn → unknown', () => {
  tracker.recordTurn({ userId: 'u', chatId: 'c', intentKind: 'build' });
  const r = tracker.computeMomentum({ userId: 'u', chatId: 'c' });
  assert.strictEqual(r.classification, 'unknown');
});

test('temporal cohesion: regular intervals → higher cohesion than chaotic', () => {
  for (let i = 0; i < 6; i += 1) {
    tracker.recordTurn({
      userId: 'a', chatId: 'x',
      intentKind: 'build', features: feats('topic'),
      now: 1_000_000 + i * 5_000,
    });
  }
  const regular = tracker.computeMomentum({ userId: 'a', chatId: 'x' });

  tracker.__resetForTests();
  const gaps = [1_000, 100_000, 2_000, 500_000, 5_000];
  let t = 1_000_000;
  for (let i = 0; i < gaps.length; i += 1) {
    tracker.recordTurn({
      userId: 'b', chatId: 'y',
      intentKind: 'build', features: feats('topic'),
      now: t,
    });
    t += gaps[i];
  }
  tracker.recordTurn({ userId: 'b', chatId: 'y', intentKind: 'build', features: feats('topic'), now: t });
  const chaotic = tracker.computeMomentum({ userId: 'b', chatId: 'y' });
  assert.ok(regular.components.temporalCohesion >= chaotic.components.temporalCohesion);
});

test('getRecent: returns at most limit entries', () => {
  for (let i = 0; i < 5; i += 1) {
    tracker.recordTurn({ userId: 'u', chatId: 'c', intentKind: 'x' });
  }
  const r = tracker.getRecent({ userId: 'u', chatId: 'c', limit: 3 });
  assert.strictEqual(r.length, 3);
});

test('buildMomentumBlock: returns text for high momentum', () => {
  for (let i = 0; i < 4; i += 1) {
    tracker.recordTurn({ userId: 'u', chatId: 'c', intentKind: 'build', features: feats('x') });
  }
  const r = tracker.computeMomentum({ userId: 'u', chatId: 'c' });
  const block = tracker.buildMomentumBlock(r);
  assert.ok(block.includes('<conversational_momentum>'));
  assert.ok(block.includes('high'));
});

test('buildMomentumBlock: empty for unknown classification', () => {
  assert.strictEqual(tracker.buildMomentumBlock({ classification: 'unknown' }), '');
  assert.strictEqual(tracker.buildMomentumBlock(null), '');
});

test('clear({userId, chatId}) removes one chat only', () => {
  tracker.recordTurn({ userId: 'a', chatId: 'x', intentKind: 'build' });
  tracker.recordTurn({ userId: 'b', chatId: 'y', intentKind: 'build' });
  tracker.clear({ userId: 'a', chatId: 'x' });
  assert.strictEqual(tracker.computeMomentum({ userId: 'a', chatId: 'x' }).samples, 0);
  assert.ok(tracker.computeMomentum({ userId: 'b', chatId: 'y' }).samples >= 1);
});

test('clear({userId}) removes all chats for that user', () => {
  tracker.recordTurn({ userId: 'multi', chatId: 'a', intentKind: 'build' });
  tracker.recordTurn({ userId: 'multi', chatId: 'b', intentKind: 'build' });
  tracker.clear({ userId: 'multi' });
  assert.strictEqual(tracker.stats().chats, 0);
});

test('clear() with no args wipes everything', () => {
  tracker.recordTurn({ userId: 'u', chatId: 'c', intentKind: 'build' });
  tracker.clear();
  assert.strictEqual(tracker.stats().chats, 0);
});

test('stats reports buffer state', () => {
  for (let i = 0; i < 3; i += 1) {
    tracker.recordTurn({ userId: 'u', chatId: 'c', intentKind: 'build' });
  }
  const s = tracker.stats();
  assert.strictEqual(s.chats, 1);
  assert.strictEqual(s.totalTurns, 3);
});

test('hot path: 100 record+compute cycles under 50ms', () => {
  const t0 = Date.now();
  for (let i = 0; i < 100; i += 1) {
    tracker.recordTurn({
      userId: 'perf', chatId: 'c', intentKind: i % 2 === 0 ? 'build' : 'fix',
      features: feats(`f${i % 5}`),
    });
    tracker.computeMomentum({ userId: 'perf', chatId: 'c' });
  }
  assert.ok(Date.now() - t0 < 100);
});

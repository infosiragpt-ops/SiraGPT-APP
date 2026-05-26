'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fb = require('../src/services/attribution-feedback-recorder');
const tr = require('../src/services/attribution-trace-recorder');

const fakeBundle = (overrides = {}) => ({
  verdict: 'allow',
  telemetry: { primaryIntent: 'fix', driftClass: 'continuation', ...overrides.telemetry },
});

describe('attribution-feedback-recorder', () => {
  beforeEach(() => { fb.reset(); tr.reset(); });

  test('record rejects invalid reactions', () => {
    const r = fb.record({ reaction: 'love_it' });
    assert.equal(r.ok, false);
  });

  test('record accepts helpful + links to trace snapshot', () => {
    const t = tr.record({ userId: 'u', chatId: 'c', bundle: fakeBundle() });
    const r = fb.record({ userId: 'u', chatId: 'c', traceId: t.id, reaction: 'helpful' });
    assert.equal(r.ok, true);
    assert.equal(r.entry.traceSnapshot?.primaryIntent, 'fix');
  });

  test('list filters by chatId and reaction', () => {
    const t = tr.record({ bundle: fakeBundle() });
    fb.record({ chatId: 'A', traceId: t.id, reaction: 'helpful' });
    fb.record({ chatId: 'B', traceId: t.id, reaction: 'not_helpful' });
    const a = fb.list({ chatId: 'A' });
    assert.equal(a.length, 1);
    const nh = fb.list({ reaction: 'not_helpful' });
    assert.equal(nh.length, 1);
  });

  test('aggregate groups by reaction by default', () => {
    const t = tr.record({ bundle: fakeBundle() });
    fb.record({ traceId: t.id, reaction: 'helpful' });
    fb.record({ traceId: t.id, reaction: 'helpful' });
    fb.record({ traceId: t.id, reaction: 'not_helpful' });
    const a = fb.aggregate();
    assert.equal(a.count, 3);
    assert.equal(a.groups.helpful?.total, 2);
    assert.equal(a.groups.not_helpful?.total, 1);
  });

  test('aggregate groupBy=intent buckets by primaryIntent', () => {
    const t1 = tr.record({ bundle: fakeBundle({ telemetry: { primaryIntent: 'fix' } }) });
    const t2 = tr.record({ bundle: fakeBundle({ telemetry: { primaryIntent: 'create' } }) });
    fb.record({ traceId: t1.id, reaction: 'helpful' });
    fb.record({ traceId: t2.id, reaction: 'regenerate' });
    const a = fb.aggregate({ groupBy: 'intent' });
    assert.ok(a.groups.fix);
    assert.ok(a.groups.create);
  });

  test('helpfulnessScore reflects helpful ratio', () => {
    const t = tr.record({ bundle: fakeBundle() });
    fb.record({ traceId: t.id, reaction: 'helpful' });
    fb.record({ traceId: t.id, reaction: 'helpful' });
    fb.record({ traceId: t.id, reaction: 'not_helpful' });
    const a = fb.aggregate();
    const group = a.groups.helpful || a.groups.not_helpful;
    // helpfulness is computed per-group; check via intent group
    const a2 = fb.aggregate({ groupBy: 'intent' });
    const fixGroup = a2.groups.fix;
    assert.ok(fixGroup);
    assert.ok(fixGroup.helpfulnessScore >= 0.6);
  });

  test('list returns recency-sorted', () => {
    const t = tr.record({ bundle: fakeBundle() });
    const a = fb.record({ traceId: t.id, reaction: 'helpful' });
    const b = fb.record({ traceId: t.id, reaction: 'not_helpful' });
    const list = fb.list();
    assert.equal(list[0].id, b.entry.id);
    assert.equal(list[1].id, a.entry.id);
  });

  test('stats returns count and by-reaction breakdown', () => {
    const t = tr.record({ bundle: fakeBundle() });
    fb.record({ traceId: t.id, reaction: 'helpful' });
    fb.record({ traceId: t.id, reaction: 'regenerate' });
    const s = fb.stats();
    assert.equal(s.count, 2);
    assert.equal(s.byReaction.regenerate, 1);
  });

  test('respects MAX_ENTRIES bound', () => {
    const t = tr.record({ bundle: fakeBundle() });
    const max = fb.MAX_ENTRIES;
    for (let i = 0; i < max + 10; i++) fb.record({ traceId: t.id, reaction: 'helpful' });
    // stats reports the in-memory count which is capped at MAX_ENTRIES;
    // list itself caps at 500 by design.
    assert.equal(fb.stats().count, max);
  });
});

'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const tr = require('../src/services/attribution-trace-recorder');

const fakeBundle = (overrides = {}) => ({
  verdict: 'allow',
  telemetry: {
    primaryIntent: 'fix',
    multiHopDepth: 1,
    planNodes: 2,
    conflicts: 0,
    driftClass: 'continuation',
    beliefsObserved: 1,
    beliefsContradicted: 0,
    faithfulnessGrade: null,
    latencyMs: 12,
    ...overrides.telemetry,
  },
  ...overrides,
});

describe('attribution-trace-recorder', () => {
  beforeEach(() => tr.reset());

  test('record stores a trace and returns the entry', () => {
    const t = tr.record({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'arregla el bug', bundle: fakeBundle() });
    assert.ok(t);
    assert.ok(t.id);
    assert.equal(t.verdict, 'allow');
  });

  test('record returns null when no bundle', () => {
    assert.equal(tr.record({ userId: 'u' }), null);
  });

  test('list filters by chatId', () => {
    tr.record({ userId: 'u', chatId: 'A', bundle: fakeBundle() });
    tr.record({ userId: 'u', chatId: 'B', bundle: fakeBundle() });
    const a = tr.list({ chatId: 'A' });
    assert.equal(a.length, 1);
    assert.equal(a[0].chatId, 'A');
  });

  test('list filters by userId', () => {
    tr.record({ userId: 'alice', chatId: 'c', bundle: fakeBundle() });
    tr.record({ userId: 'bob', chatId: 'c', bundle: fakeBundle() });
    const alice = tr.list({ userId: 'alice' });
    assert.equal(alice.length, 1);
  });

  test('list returns recency-sorted', () => {
    const t1 = tr.record({ userId: 'u', chatId: 'c', turnIndex: 0, bundle: fakeBundle() });
    const t2 = tr.record({ userId: 'u', chatId: 'c', turnIndex: 1, bundle: fakeBundle() });
    const list = tr.list();
    assert.equal(list[0].id, t2.id);
    assert.equal(list[1].id, t1.id);
  });

  test('get returns trace by id', () => {
    const t = tr.record({ userId: 'u', chatId: 'c', bundle: fakeBundle() });
    assert.equal(tr.get({ id: t.id })?.id, t.id);
  });

  test('stats aggregates verdict and drift counts', () => {
    tr.record({ bundle: fakeBundle({ verdict: 'allow' }) });
    tr.record({ bundle: fakeBundle({ verdict: 'refuse' }) });
    tr.record({ bundle: fakeBundle({ telemetry: { driftClass: 'hard_shift' } }) });
    const s = tr.stats();
    assert.equal(s.count, 3);
    assert.equal(s.byVerdict.refuse, 1);
    assert.equal(s.byVerdict.allow, 2);
    assert.ok(s.byDrift.hard_shift >= 1);
  });

  test('confidence merged into snapshot when provided', () => {
    const t = tr.record({ userId: 'u', chatId: 'c', bundle: fakeBundle(), confidence: { score: 0.8, grade: 'B' } });
    assert.equal(t.summarySnapshot.confidenceGrade, 'B');
    assert.equal(t.summarySnapshot.confidenceScore, 0.8);
  });

  test('respects MAX_TRACES bound', () => {
    const max = tr.MAX_TRACES;
    for (let i = 0; i < max + 20; i++) tr.record({ bundle: fakeBundle() });
    assert.equal(tr.list({ limit: max + 100 }).length, max);
  });
});

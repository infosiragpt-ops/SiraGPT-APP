'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const metrics = require('../src/services/attribution-metrics');

describe('attribution-metrics', () => {
  beforeEach(() => metrics.reset());

  test('snapshot returns zeros on empty store', () => {
    const s = metrics.snapshot();
    assert.equal(s.count, 0);
    assert.equal(s.intents.length, 0);
  });

  test('record then snapshot reflects latency percentiles', () => {
    for (let i = 0; i < 10; i++) {
      metrics.record({ userId: 'u', latencyMs: 10 + i, primaryIntent: 'intent_a', language: 'es' });
    }
    const s = metrics.snapshot();
    assert.equal(s.count, 10);
    assert.ok(s.latency.p50 >= 10);
    assert.ok(s.latency.p90 >= s.latency.p50);
    assert.equal(s.intents[0].label, 'intent_a');
    assert.equal(s.intents[0].count, 10);
    assert.equal(s.languages.es, 10);
  });

  test('intent transitions tracked between distinct intents per user', () => {
    metrics.record({ userId: 'u', primaryIntent: 'A' });
    metrics.record({ userId: 'u', primaryIntent: 'B' });
    metrics.record({ userId: 'u', primaryIntent: 'C' });
    const s = metrics.snapshot();
    assert.ok(s.topTransitions.length >= 1);
    assert.ok(s.topTransitions.some((t) => t.from === 'A' && t.to === 'B'));
  });

  test('multi-hop and plan averages computed', () => {
    metrics.record({ multiHopDepth: 1, planNodes: 0, suppressionConflicts: 0 });
    metrics.record({ multiHopDepth: 3, planNodes: 4, suppressionConflicts: 1 });
    const s = metrics.snapshot();
    assert.equal(s.multiHopAvg, 2);
    assert.equal(s.planAvg, 2);
    assert.equal(s.conflictsTotal, 1);
  });

  test('faithfulness average tracked when scored', () => {
    metrics.record({ faithfulnessGrade: 'A', faithfulnessScore: 0.95 });
    metrics.record({ faithfulnessGrade: 'C', faithfulnessScore: 0.75 });
    const s = metrics.snapshot();
    assert.equal(s.faithfulness.measured, 2);
    assert.equal(s.faithfulness.grades.A, 1);
  });

  test('windowMs filters records by recency', () => {
    metrics.record({ latencyMs: 100, timestamp: Date.now() - 60_000 });
    metrics.record({ latencyMs: 200, timestamp: Date.now() });
    const recent = metrics.snapshot({ windowMs: 10_000 });
    assert.equal(recent.count, 1);
  });

  test('reset clears records and matrices', () => {
    metrics.record({ primaryIntent: 'x' });
    metrics.reset();
    const s = metrics.snapshot();
    assert.equal(s.count, 0);
  });
});

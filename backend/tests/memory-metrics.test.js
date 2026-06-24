'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const metrics = require('../src/services/memory-metrics');

test('record + snapshot: counts events and derives rates', () => {
  metrics.reset();
  metrics.record('turn');
  metrics.record('stored', 2);
  metrics.record('superseded');
  metrics.record('recall_decision');
  metrics.record('recalled', 3);
  metrics.recordReason('referencia personal');

  const s = metrics.snapshot();
  assert.equal(s.turns, 1);
  assert.equal(s.stored, 2);
  assert.equal(s.superseded, 1);
  assert.equal(s.recallDecisions, 1);
  assert.equal(s.recalled, 3);
  assert.equal(s.recallHitRate, 1); // 1 decision, 0 empty
  assert.equal(s.avgRecalledPerHit, 3);
  assert.equal(s.lastReason, 'referencia personal');
});

test('recall hit rate accounts for empty recalls', () => {
  metrics.reset();
  metrics.record('recall_decision');
  metrics.record('recalled', 2);
  metrics.record('recall_decision');
  metrics.record('recall_empty');
  const s = metrics.snapshot();
  assert.equal(s.recallDecisions, 2);
  assert.equal(s.recallEmpty, 1);
  assert.equal(s.recallHitRate, 0.5);
});

test('toPrometheusText: exposes counters in prom format', () => {
  metrics.reset();
  metrics.record('stored', 5);
  const text = metrics.toPrometheusText();
  assert.match(text, /sira_memory_stored_total 5/);
  assert.match(text, /# TYPE sira_memory_stored_total counter/);
});

test('record never throws on bad input', () => {
  assert.doesNotThrow(() => metrics.record('unknown_event'));
  assert.doesNotThrow(() => metrics.record('stored', NaN));
  assert.doesNotThrow(() => metrics.recordReason(null));
});

test('reset clears everything', () => {
  metrics.record('stored', 9);
  metrics.reset();
  const s = metrics.snapshot();
  assert.equal(s.stored, 0);
  assert.equal(s.turns, 0);
  assert.equal(s.lastReason, '');
});

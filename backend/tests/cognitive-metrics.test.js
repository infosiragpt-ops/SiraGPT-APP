'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const metrics = require('../src/services/cognitive-metrics');

beforeEach(() => metrics.reset());

const decision = (over = {}) => ({
  difficulty: { bucket: over.bucket || 'moderate' },
  risk: { level: over.risk || 'low' },
  routing: {
    action: over.action || 'keep',
    mode: over.mode || 'escalate',
    changed: !!over.changed,
    userModel: over.userModel || 'gpt-4o-mini',
    selectedModel: over.selectedModel || 'gpt-4o-mini',
  },
});

describe('recordRoutingDecision', () => {
  test('counts totals, actions, difficulty, risk, mode', () => {
    metrics.recordRoutingDecision(decision({ action: 'keep', bucket: 'trivial' }));
    metrics.recordRoutingDecision(decision({ action: 'escalate', bucket: 'complex', changed: true, userModel: 'a', selectedModel: 'b' }));
    const s = metrics.snapshot();
    assert.equal(s.routing.total, 2);
    assert.equal(s.routing.changed, 1);
    assert.equal(s.routing.byAction.keep, 1);
    assert.equal(s.routing.byAction.escalate, 1);
    assert.equal(s.routing.byDifficulty.trivial, 1);
    assert.equal(s.routing.byDifficulty.complex, 1);
    assert.equal(s.routing.escalationRate, 0.5);
    assert.deepEqual(s.routing.topEscalations[0], { key: 'a→b', count: 1 });
  });

  test('never throws on garbage', () => {
    metrics.recordRoutingDecision(null);
    metrics.recordRoutingDecision({});
    metrics.recordRoutingDecision({ routing: {} });
    assert.equal(metrics.snapshot().routing.total, 1); // only the one with a routing object
  });
});

describe('recordFaithfulness', () => {
  test('tracks grades + per-model annotate rate', () => {
    metrics.recordFaithfulness({ grade: 'A', action: 'pass', model: 'm1' });
    metrics.recordFaithfulness({ grade: 'F', action: 'annotate', model: 'm1' });
    const s = metrics.snapshot();
    assert.equal(s.faithfulness.total, 2);
    assert.equal(s.faithfulness.annotated, 1);
    assert.equal(s.faithfulness.byGrade.A, 1);
    assert.equal(s.faithfulness.byGrade.F, 1);
    assert.equal(s.faithfulness.byModel.m1.total, 2);
    assert.equal(s.faithfulness.byModel.m1.annotated, 1);
    assert.equal(s.faithfulness.byModel.m1.annotateRate, 0.5);
  });
});

describe('recordCompute', () => {
  test('counts modes', () => {
    metrics.recordCompute({ mode: 'extended' });
    metrics.recordCompute({ mode: 'extended' });
    metrics.recordCompute({ mode: 'self_consistency' });
    const s = metrics.snapshot();
    assert.equal(s.compute.total, 3);
    assert.equal(s.compute.byMode.extended, 2);
    assert.equal(s.compute.byMode.self_consistency, 1);
  });
});

describe('toPrometheusText', () => {
  test('emits valid exposition with our metric names', () => {
    metrics.recordRoutingDecision(decision({ action: 'escalate', changed: true }));
    metrics.recordFaithfulness({ grade: 'B', action: 'pass', model: 'm' });
    metrics.recordCompute({ mode: 'extended' });
    const text = metrics.toPrometheusText();
    assert.match(text, /# TYPE sira_cognitive_routing_total counter/);
    assert.match(text, /sira_cognitive_routing_action\{action="escalate"\} 1/);
    assert.match(text, /sira_cognitive_faithfulness_grade\{grade="B"\} 1/);
    assert.match(text, /sira_cognitive_compute_mode\{mode="extended"\} 1/);
  });

  test('escapes CR/LF, quotes, and backslashes in dynamic labels', () => {
    metrics.recordRoutingDecision(decision({
      action: 'keep\r\ninjected_metric 1"\\tail',
    }));
    const text = metrics.toPrometheusText();

    assert.equal(text.includes('\r'), false);
    assert.equal(text.split('\n').some((line) => line.startsWith('injected_metric ')), false);
    assert.ok(text.includes('action="keep\\ninjected_metric 1\\"\\\\tail"'));
  });
});

describe('cardinality cap', () => {
  test('routing escalation labels are bounded', () => {
    for (let i = 0; i < 100; i += 1) {
      metrics.recordRoutingDecision(decision({ action: 'escalate', changed: true, userModel: `u${i}`, selectedModel: `v${i}` }));
    }
    const s = metrics.snapshot();
    // topEscalations is capped at 10 in the snapshot
    assert.ok(s.routing.topEscalations.length <= 10);
  });
});

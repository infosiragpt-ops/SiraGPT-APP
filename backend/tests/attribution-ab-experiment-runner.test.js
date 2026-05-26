'use strict';

const test = require('node:test');
const assert = require('node:assert');

const runner = require('../src/services/attribution-ab-experiment-runner');

const cases = [
  { id: 'c1', prompt: 'p1', expectedIntent: 'build' },
  { id: 'c2', prompt: 'p2', expectedIntent: 'fix' },
  { id: 'c3', prompt: 'p3', expectedIntent: 'explain' },
];

test('runExperiment: A wins when better metrics', () => {
  const better = () => ({ intentMatch: true, topicCoverage: 0.9, latencyMs: 30, anomalyScore: 0.1 });
  const worse = () => ({ intentMatch: false, topicCoverage: 0.3, latencyMs: 500, anomalyScore: 0.6 });
  const r = runner.runExperiment({ name: 'pa-vs-pb', cases, scorerA: better, scorerB: worse });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.comparison.winner, 'A');
  assert.ok(r.comparison.compositeA > r.comparison.compositeB);
});

test('runExperiment: B wins when better metrics', () => {
  const worse = () => ({ intentMatch: false, topicCoverage: 0.2, latencyMs: 400, anomalyScore: 0.7 });
  const better = () => ({ intentMatch: true, topicCoverage: 0.95, latencyMs: 20, anomalyScore: 0.05 });
  const r = runner.runExperiment({ cases, scorerA: worse, scorerB: better });
  assert.strictEqual(r.comparison.winner, 'B');
});

test('runExperiment: tie when within margin', () => {
  const scorerA = () => ({ intentMatch: true, topicCoverage: 0.6, latencyMs: 100, anomalyScore: 0.2 });
  const scorerB = () => ({ intentMatch: true, topicCoverage: 0.61, latencyMs: 102, anomalyScore: 0.2 });
  const r = runner.runExperiment({ cases, scorerA, scorerB });
  assert.strictEqual(r.comparison.winner, 'tie');
});

test('runExperiment: rejects missing scorers', () => {
  const r = runner.runExperiment({ cases });
  assert.strictEqual(r.ok, false);
});

test('runExperiment: rejects empty cases', () => {
  const r = runner.runExperiment({ cases: [], scorerA: () => ({}), scorerB: () => ({}) });
  assert.strictEqual(r.ok, false);
});

test('runExperiment: tolerates scorer that throws', () => {
  const ok = () => ({ intentMatch: true, topicCoverage: 0.8, latencyMs: 50, anomalyScore: 0.1 });
  const boom = () => { throw new Error('boom'); };
  const r = runner.runExperiment({ cases, scorerA: ok, scorerB: boom });
  assert.strictEqual(r.ok, true);
  assert.ok(r.summaryB.errors > 0);
});

test('runExperiment: includePerCase emits per-case detail', () => {
  const s = () => ({ intentMatch: true, topicCoverage: 0.8 });
  const r = runner.runExperiment({ cases, scorerA: s, scorerB: s, opts: { includePerCase: true } });
  assert.ok(Array.isArray(r.perCase));
  assert.strictEqual(r.perCase.length, cases.length);
  assert.strictEqual(r.perCase[0].id, 'c1');
});

test('summarise: reports rates + percentiles', () => {
  const scores = [
    { intentMatch: true, topicCoverage: 0.8, citationCoverage: 0.6, latencyMs: 10, anomalyScore: 0.1 },
    { intentMatch: false, topicCoverage: 0.4, citationCoverage: 0.3, latencyMs: 30, anomalyScore: 0.3 },
    { intentMatch: true, topicCoverage: 0.7, citationCoverage: 0.5, latencyMs: 20, anomalyScore: 0.2 },
  ];
  const s = runner.summarise(scores);
  assert.strictEqual(s.cases, 3);
  assert.ok(s.intentMatchRate > 0.5);
  assert.ok(s.topicCoverageMean > 0.5);
  assert.ok(s.latencyP50Ms >= 10 && s.latencyP50Ms <= 30);
});

test('summarise: empty list returns sane defaults', () => {
  const s = runner.summarise([]);
  assert.strictEqual(s.cases, 0);
  assert.strictEqual(s.intentMatchRate, 0);
});

test('composite: respects custom weights', () => {
  const summary = {
    intentMatchRate: 1, topicCoverageMean: 1, citationCoverageMean: 1,
    anomalyMean: 0, latencyMeanMs: 10,
  };
  const score = runner.composite(summary);
  assert.ok(score >= 0.95); // near max
});

test('composite: latency above 1s tanks score', () => {
  const summary = {
    intentMatchRate: 1, topicCoverageMean: 1, citationCoverageMean: 1,
    anomalyMean: 0, latencyMeanMs: 2000,
  };
  const score = runner.composite(summary);
  assert.ok(score < 0.95);
});

test('compareSummaries: detects deltas', () => {
  const a = runner.summarise([
    { intentMatch: false, topicCoverage: 0.3, latencyMs: 100 },
  ]);
  const b = runner.summarise([
    { intentMatch: true, topicCoverage: 0.9, latencyMs: 50 },
  ]);
  const c = runner.compareSummaries(a, b);
  assert.ok(c.deltas.intentMatchRate > 0);
  assert.ok(c.deltas.topicCoverageMean > 0);
});

test('buildExperimentBlock returns prompt text', () => {
  const better = () => ({ intentMatch: true, topicCoverage: 0.9, latencyMs: 30, anomalyScore: 0.1 });
  const worse = () => ({ intentMatch: false, topicCoverage: 0.3, latencyMs: 500, anomalyScore: 0.6 });
  const r = runner.runExperiment({ cases, scorerA: better, scorerB: worse });
  const block = runner.buildExperimentBlock(r);
  assert.ok(block.includes('<ab_experiment>'));
  assert.ok(block.includes('Winner'));
});

test('buildExperimentBlock empty for failed run', () => {
  assert.strictEqual(runner.buildExperimentBlock(null), '');
  assert.strictEqual(runner.buildExperimentBlock({ ok: false }), '');
});

test('hot path: 100 cases × 2 scorers under 50ms', () => {
  const bigCases = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, prompt: `p${i}` }));
  const s = () => ({ intentMatch: true, topicCoverage: 0.5, latencyMs: 10 });
  const t0 = Date.now();
  runner.runExperiment({ cases: bigCases, scorerA: s, scorerB: s });
  assert.ok(Date.now() - t0 < 100);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const harness = require('../scripts/run-attribution-quality-eval');

test('evaluateOne returns the full result shape for a build prompt', () => {
  const r = harness.evaluateOne({
    id: 't1',
    prompt: 'Build me a chart of monthly revenue.',
    expectedIntent: 'build',
    expectedTopics: ['chart', 'revenue'],
    expectedLanguage: 'en',
  });
  assert.strictEqual(r.id, 't1');
  assert.ok(typeof r.matchedTop1 === 'boolean');
  assert.ok(typeof r.matchedTop3 === 'boolean');
  assert.ok(r.topicScore >= 0 && r.topicScore <= 1);
  assert.ok(typeof r.languageMatched === 'boolean');
  assert.ok(typeof r.latencyMs === 'number' && r.latencyMs >= 0);
});

test('evaluateOne tolerates missing optional expectations', () => {
  const r = harness.evaluateOne({ id: 'lean', prompt: 'Explain caching strategies.', expectedIntent: 'explain' });
  assert.ok(typeof r.matchedTop1 === 'boolean');
  assert.strictEqual(r.topicScore, 1);
});

test('aggregate computes per-metric averages and latency percentiles', () => {
  const results = [
    { id: 'a', matchedTop1: true, matchedTop3: true, topicScore: 1, languageMatched: true, hopsMatched: true, latencyMs: 10 },
    { id: 'b', matchedTop1: false, matchedTop3: true, topicScore: 0.5, languageMatched: true, hopsMatched: false, latencyMs: 20 },
    { id: 'c', matchedTop1: true, matchedTop3: true, topicScore: 1, languageMatched: false, hopsMatched: true, latencyMs: 30 },
  ];
  const agg = harness.aggregate(results);
  assert.strictEqual(agg.cases, 3);
  assert.ok(agg.intentPrecision >= 0 && agg.intentPrecision <= 1);
  assert.ok(agg.intentRecallTop3 >= agg.intentPrecision);
  assert.ok(agg.topicCoverage >= 0.8);
  assert.ok(agg.languageAccuracy < 1);
  assert.ok(agg.latencyP50Ms >= 10 && agg.latencyP50Ms <= 30);
  assert.ok(agg.latencyP95Ms >= agg.latencyP50Ms);
});

test('aggregate returns null on empty input', () => {
  assert.strictEqual(harness.aggregate([]), null);
});

test('diffAgainstBaseline flags regression when intent precision drops > 5 %', () => {
  const cur = { intentPrecision: 0.5, intentRecallTop3: 0.9, topicCoverage: 0.8, languageAccuracy: 0.9, multiHopAccuracy: 0.7, latencyP95Ms: 50 };
  const base = { intentPrecision: 0.7, intentRecallTop3: 0.9, topicCoverage: 0.8, languageAccuracy: 0.9, multiHopAccuracy: 0.7, latencyP95Ms: 50 };
  const diff = harness.diffAgainstBaseline(cur, base);
  assert.strictEqual(diff.ok, false);
  assert.ok(diff.regressions.find((r) => r.metric === 'intentPrecision'));
});

test('diffAgainstBaseline returns ok=true with no baseline', () => {
  assert.deepStrictEqual(harness.diffAgainstBaseline({ intentPrecision: 0.5 }, null), { ok: true, regressions: [] });
});

test('diffAgainstBaseline catches > 50% latency regression', () => {
  const cur = { intentPrecision: 0.9, intentRecallTop3: 0.9, topicCoverage: 0.9, languageAccuracy: 0.9, multiHopAccuracy: 0.9, latencyP95Ms: 100 };
  const base = { intentPrecision: 0.9, intentRecallTop3: 0.9, topicCoverage: 0.9, languageAccuracy: 0.9, multiHopAccuracy: 0.9, latencyP95Ms: 50 };
  const diff = harness.diffAgainstBaseline(cur, base);
  assert.strictEqual(diff.ok, false);
  assert.ok(diff.regressions.find((r) => r.metric === 'latencyP95Ms'));
});

test('DEFAULT_DATASET is reasonable', () => {
  assert.ok(Array.isArray(harness.DEFAULT_DATASET));
  assert.ok(harness.DEFAULT_DATASET.length >= 15);
  for (const c of harness.DEFAULT_DATASET) {
    assert.ok(typeof c.id === 'string' && c.id.length > 0);
    assert.ok(typeof c.prompt === 'string' && c.prompt.length > 0);
    assert.ok(typeof c.expectedIntent === 'string');
  }
});

test('full default-dataset run completes within sane bounds', () => {
  const results = harness.DEFAULT_DATASET.map(harness.evaluateOne);
  const agg = harness.aggregate(results);
  // Heuristic floors — confirm pipeline doesn't crash and stays roughly stable.
  assert.ok(agg.intentRecallTop3 >= 0.20, `intent recall ${agg.intentRecallTop3} below 0.20 floor`);
  assert.ok(agg.topicCoverage >= 0.15, `topic coverage ${agg.topicCoverage} below 0.15 floor`);
  assert.ok(agg.languageAccuracy >= 0.60, `language accuracy ${agg.languageAccuracy} below 0.60 floor`);
  assert.ok(agg.latencyP95Ms < 200, `p95 latency ${agg.latencyP95Ms}ms above 200ms ceiling`);
});

test('loadDataset returns DEFAULT_DATASET when no file given', () => {
  assert.strictEqual(harness.loadDataset(null), harness.DEFAULT_DATASET);
});

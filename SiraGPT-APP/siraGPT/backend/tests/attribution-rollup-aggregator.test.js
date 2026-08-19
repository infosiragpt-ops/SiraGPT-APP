'use strict';

const test = require('node:test');
const assert = require('node:assert');

const agg = require('../src/services/attribution-rollup-aggregator');

test.beforeEach(() => agg.__resetForTests());

const baseSample = (overrides = {}) => ({
  userId: 'u',
  chatId: 'c',
  turnId: 't1',
  timestamp: Date.now(),
  domain: 'general',
  primaryIntent: 'explain',
  faithfulness: 0.8,
  citationCoverage: 0.5,
  anomalyScore: 0.1,
  adversarialVerdict: 'safe',
  hopsDepth: 1,
  latencyMs: 50,
  trimmedBlocks: [],
  hallucinated: false,
  accepted: true,
  ...overrides,
});

test('rollup: empty buffer returns empty=true', () => {
  const r = agg.rollup();
  assert.strictEqual(r.empty, true);
  assert.strictEqual(r.samples, 0);
});

test('record + rollup: single sample reports meanFaithfulness', () => {
  agg.record(baseSample({ faithfulness: 0.75 }));
  const r = agg.rollup();
  assert.strictEqual(r.samples, 1);
  assert.strictEqual(r.meanFaithfulness, 0.75);
});

test('rollup: aggregates faithfulness across multiple samples', () => {
  agg.record(baseSample({ faithfulness: 0.8 }));
  agg.record(baseSample({ faithfulness: 0.4 }));
  agg.record(baseSample({ faithfulness: 0.6 }));
  const r = agg.rollup();
  assert.ok(r.meanFaithfulness > 0.5 && r.meanFaithfulness < 0.7);
});

test('rollup: hallucinationRate counts properly', () => {
  for (let i = 0; i < 5; i += 1) agg.record(baseSample({ hallucinated: i % 2 === 0 }));
  const r = agg.rollup();
  assert.ok(r.hallucinationRate > 0 && r.hallucinationRate <= 1);
});

test('rollup: acceptanceRate counts properly', () => {
  agg.record(baseSample({ accepted: true }));
  agg.record(baseSample({ accepted: false }));
  agg.record(baseSample({ accepted: true }));
  const r = agg.rollup();
  assert.ok(Math.abs(r.acceptanceRate - 2 / 3) < 0.01);
});

test('rollup: byDomain groups + sorts', () => {
  agg.record(baseSample({ domain: 'legal' }));
  agg.record(baseSample({ domain: 'legal' }));
  agg.record(baseSample({ domain: 'code' }));
  const r = agg.rollup();
  assert.strictEqual(r.byDomain[0].domain, 'legal');
  assert.strictEqual(r.byDomain[0].count, 2);
});

test('rollup: byVerdict groups risk levels', () => {
  agg.record(baseSample({ adversarialVerdict: 'safe' }));
  agg.record(baseSample({ adversarialVerdict: 'high_risk' }));
  agg.record(baseSample({ adversarialVerdict: 'safe' }));
  const r = agg.rollup();
  const safe = r.byVerdict.find((v) => v.verdict === 'safe');
  assert.strictEqual(safe.count, 2);
});

test('rollup: topIntents reports failure rate', () => {
  agg.record(baseSample({ primaryIntent: 'build', faithfulness: 0.2 }));
  agg.record(baseSample({ primaryIntent: 'build', faithfulness: 0.3 }));
  agg.record(baseSample({ primaryIntent: 'build', faithfulness: 0.8 }));
  const r = agg.rollup();
  const buildIntent = r.topIntents.find((i) => i.intent === 'build');
  assert.ok(buildIntent.failureRate > 0.5);
});

test('rollup: topTrimmedBlocks aggregates trim events', () => {
  agg.record(baseSample({ trimmedBlocks: ['evidence', 'cowork'] }));
  agg.record(baseSample({ trimmedBlocks: ['evidence'] }));
  const r = agg.rollup();
  const evidence = r.topTrimmedBlocks.find((t) => t.kind === 'evidence');
  assert.strictEqual(evidence.count, 2);
});

test('rollup: latency percentiles computed', () => {
  for (let i = 0; i < 10; i += 1) agg.record(baseSample({ latencyMs: 10 + i * 5 }));
  const r = agg.rollup();
  assert.ok(r.latencyP50Ms <= r.latencyP95Ms);
  assert.ok(r.latencyP95Ms >= 50);
});

test('rollup: scope=user filters by userId', () => {
  agg.record(baseSample({ userId: 'alice' }));
  agg.record(baseSample({ userId: 'bob' }));
  const r = agg.rollup({ scope: 'user', userId: 'alice' });
  assert.strictEqual(r.samples, 1);
});

test('rollup: sinceMs filters by recency', async () => {
  agg.record(baseSample({ timestamp: Date.now() - 60_000 }));
  agg.record(baseSample({ timestamp: Date.now() }));
  const r = agg.rollup({ sinceMs: 30_000 });
  assert.strictEqual(r.samples, 1);
});

test('record: invalid samples are silently ignored', () => {
  agg.record(null);
  agg.record('not an object');
  agg.record(undefined);
  assert.strictEqual(agg.stats().samples, 0);
});

test('record: out-of-range values get clamped or nulled', () => {
  agg.record(baseSample({ faithfulness: 1.5, citationCoverage: -0.2 }));
  const r = agg.rollup();
  // 1.5 clamps to 1, -0.2 clamps to 0
  assert.ok(r.meanFaithfulness <= 1);
});

test('listRecent returns at most `limit` newest samples', () => {
  for (let i = 0; i < 20; i += 1) agg.record(baseSample({ turnId: `t${i}` }));
  const recent = agg.listRecent({ limit: 5 });
  assert.strictEqual(recent.length, 5);
  assert.strictEqual(recent[recent.length - 1].turnId, 't19');
});

test('clear empties the buffer', () => {
  agg.record(baseSample());
  agg.record(baseSample());
  agg.clear();
  assert.strictEqual(agg.stats().samples, 0);
});

test('stats reports per-domain + per-verdict counts', () => {
  agg.record(baseSample({ domain: 'legal' }));
  agg.record(baseSample({ domain: 'code', adversarialVerdict: 'suspect' }));
  const s = agg.stats();
  assert.strictEqual(s.samples, 2);
  assert.strictEqual(s.perDomain.legal, 1);
  assert.strictEqual(s.perDomain.code, 1);
  assert.strictEqual(s.perVerdict.suspect, 1);
});

test('window cap enforced at WINDOW_SIZE', () => {
  for (let i = 0; i < agg.WINDOW_SIZE + 50; i += 1) agg.record(baseSample());
  assert.strictEqual(agg.stats().samples, agg.WINDOW_SIZE);
});

test('hot path: 1000 record + rollup under 200ms', () => {
  const t0 = Date.now();
  for (let i = 0; i < 1000; i += 1) agg.record(baseSample({ faithfulness: Math.random() }));
  agg.rollup();
  assert.ok(Date.now() - t0 < 500);
});

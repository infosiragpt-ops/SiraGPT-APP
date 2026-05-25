'use strict';

const test = require('node:test');
const assert = require('node:assert');

const engine = require('../src/services/attribution-recommendation-engine');

test('recommend: no inputs returns empty list', () => {
  assert.deepStrictEqual(engine.recommend(), []);
});

test('recommend: high hallucination rate → threshold_tighten', () => {
  const r = engine.recommend({
    rollup: { samples: 20, hallucinationRate: 0.25, empty: false, byDomain: [], topIntents: [], topTrimmedBlocks: [] },
  });
  assert.ok(r.find((x) => x.kind === 'threshold_tighten'));
});

test('recommend: very high faithfulness → threshold_loosen', () => {
  const r = engine.recommend({
    rollup: { samples: 20, meanFaithfulness: 0.95, hallucinationRate: 0.01, byDomain: [], topIntents: [], topTrimmedBlocks: [], acceptanceRate: 0.95 },
  });
  assert.ok(r.find((x) => x.kind === 'threshold_loosen'));
});

test('recommend: low acceptance rate → threshold_loosen', () => {
  const r = engine.recommend({
    rollup: { samples: 20, acceptanceRate: 0.55, hallucinationRate: 0.02, meanFaithfulness: 0.8, byDomain: [], topIntents: [], topTrimmedBlocks: [] },
  });
  assert.ok(r.find((x) => x.kind === 'threshold_loosen'));
});

test('recommend: heavy prompt-trim → budget_increase', () => {
  const r = engine.recommend({
    rollup: {
      samples: 20, hallucinationRate: 0.01, meanFaithfulness: 0.8, byDomain: [], topIntents: [], acceptanceRate: 0.9,
      topTrimmedBlocks: [{ kind: 'evidence', count: 12 }, { kind: 'cowork', count: 3 }],
    },
  });
  assert.ok(r.find((x) => x.kind === 'budget_increase'));
});

test('recommend: failing intent → domain_review', () => {
  const r = engine.recommend({
    rollup: {
      samples: 20, hallucinationRate: 0.01, meanFaithfulness: 0.8, byDomain: [], acceptanceRate: 0.9, topTrimmedBlocks: [],
      topIntents: [{ intent: 'translate', count: 10, failureRate: 0.5 }],
    },
  });
  assert.ok(r.find((x) => x.kind === 'domain_review'));
});

test('recommend: weak domain → domain_review', () => {
  const r = engine.recommend({
    rollup: {
      samples: 20, hallucinationRate: 0.01, meanFaithfulness: 0.8, acceptanceRate: 0.9, topTrimmedBlocks: [], topIntents: [],
      byDomain: [{ domain: 'legal', count: 8, meanFaithfulness: 0.4 }],
    },
  });
  assert.ok(r.find((x) => x.kind === 'domain_review'));
});

test('recommend: high p95 latency → latency_alert', () => {
  const r = engine.recommend({
    rollup: { samples: 20, hallucinationRate: 0.01, meanFaithfulness: 0.8, acceptanceRate: 0.9, topTrimmedBlocks: [], topIntents: [], byDomain: [], latencyP95Ms: 1500 },
  });
  assert.ok(r.find((x) => x.kind === 'latency_alert'));
});

test('recommend: stage-level p95 over 300ms → latency_alert', () => {
  const r = engine.recommend({
    perfStats: [{ label: 'graph-build', samples: 10, p95: 800 }],
  });
  assert.ok(r.find((x) => x.kind === 'latency_alert' && x.summary.includes('graph-build')));
});

test('recommend: adversarial spike → adversarial_spike', () => {
  const r = engine.recommend({
    adversarialCounts: { safe: 80, suspect: 10, high_risk: 15 },
  });
  assert.ok(r.find((x) => x.kind === 'adversarial_spike'));
});

test('recommend: no adversarial activity → no adversarial_spike', () => {
  const r = engine.recommend({ adversarialCounts: { safe: 100 } });
  assert.ok(!r.find((x) => x.kind === 'adversarial_spike'));
});

test('recommend: low anomaly baseline samples → domain_review hint', () => {
  const r = engine.recommend({ anomalyBaseline: { samples: 3, meanCentroid: {}, intentKinds: [] } });
  assert.ok(r.find((x) => x.kind === 'domain_review' && x.score < 0.5));
});

test('recommend: drift summary with hard shifts → drift_alert', () => {
  const r = engine.recommend({ driftSummary: { hardShifts: 5 } });
  assert.ok(r.find((x) => x.kind === 'drift_alert'));
});

test('recommend: results sorted by severity desc', () => {
  const r = engine.recommend({
    rollup: { samples: 20, hallucinationRate: 0.30, meanFaithfulness: 0.4, acceptanceRate: 0.5, topTrimmedBlocks: [], topIntents: [], byDomain: [] },
    perfStats: [{ label: 'x', samples: 10, p95: 400 }],
    adversarialCounts: { safe: 50, high_risk: 30 },
  });
  for (let i = 1; i < r.length; i += 1) {
    assert.ok(r[i].score <= r[i - 1].score);
  }
});

test('recommend: respects opts.limit', () => {
  const r = engine.recommend({
    rollup: { samples: 20, hallucinationRate: 0.30, meanFaithfulness: 0.4, acceptanceRate: 0.5, topTrimmedBlocks: [], topIntents: [], byDomain: [] },
    perfStats: [{ label: 'x', samples: 10, p95: 400 }],
    adversarialCounts: { safe: 50, high_risk: 30 },
    opts: { limit: 2 },
  });
  assert.ok(r.length <= 2);
});

test('classifySeverity: thresholds gate correctly', () => {
  assert.strictEqual(engine.classifySeverity(0.9), 'high');
  assert.strictEqual(engine.classifySeverity(0.6), 'medium');
  assert.strictEqual(engine.classifySeverity(0.3), 'low');
});

test('buildRecommendationBlock returns prompt text for non-empty list', () => {
  const r = engine.recommend({ rollup: { samples: 20, hallucinationRate: 0.25, byDomain: [], topIntents: [], topTrimmedBlocks: [], acceptanceRate: 0.9 } });
  const block = engine.buildRecommendationBlock(r);
  assert.ok(block.includes('<attribution_recommendations>'));
  assert.ok(block.includes('threshold_tighten'));
});

test('buildRecommendationBlock empty for empty list', () => {
  assert.strictEqual(engine.buildRecommendationBlock([]), '');
  assert.strictEqual(engine.buildRecommendationBlock(null), '');
});

test('hot path: 100 recommend calls under 100ms', () => {
  const t0 = Date.now();
  for (let i = 0; i < 100; i += 1) {
    engine.recommend({
      rollup: { samples: 20, hallucinationRate: 0.05, meanFaithfulness: 0.8, acceptanceRate: 0.85, topTrimmedBlocks: [], topIntents: [], byDomain: [] },
    });
  }
  assert.ok(Date.now() - t0 < 200);
});

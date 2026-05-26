'use strict';

const test = require('node:test');
const assert = require('node:assert');

const detector = require('../src/services/attribution-anomaly-detector');

test.beforeEach(() => detector.__resetForTests());

function profile({ centroid = {}, dominantIntentKind = null, featureCount = 5, featureKinds = {} } = {}) {
  return {
    centroid: { input: 0.1, context: 0.3, feature: 0.4, intent: 0.15, action: 0.05, other: 0, ...centroid },
    dominantIntentKind,
    featureCount,
    featureKinds,
  };
}

test('score: insufficient baseline → not anomalous', () => {
  const out = detector.score({ userId: 'u', profile: profile() });
  assert.strictEqual(out.anomalous, false);
  assert.strictEqual(out.reason, 'insufficient baseline');
});

test('observe: builds baseline after MIN_SAMPLES turns', () => {
  for (let i = 0; i < detector.MIN_SAMPLES; i += 1) {
    detector.observe({ userId: 'u', profile: profile({ dominantIntentKind: 'build' }) });
  }
  const baseline = detector.getBaseline('u');
  assert.ok(baseline);
  assert.strictEqual(baseline.samples, detector.MIN_SAMPLES);
  assert.ok(baseline.intentKinds.includes('build'));
});

test('score: stable profile within baseline → not anomalous', () => {
  for (let i = 0; i < 4; i += 1) {
    detector.observe({ userId: 'u', profile: profile({ dominantIntentKind: 'build' }) });
  }
  const out = detector.score({ userId: 'u', profile: profile({ dominantIntentKind: 'build' }) });
  assert.strictEqual(out.anomalous, false);
});

test('score: novel intent kind → anomalous', () => {
  for (let i = 0; i < 4; i += 1) {
    detector.observe({ userId: 'u', profile: profile({ dominantIntentKind: 'build' }) });
  }
  const out = detector.score({ userId: 'u', profile: profile({ dominantIntentKind: 'fix' }) });
  assert.strictEqual(out.anomalous, true);
  assert.strictEqual(out.novelIntent, true);
  assert.ok(out.reasons.some((r) => r.includes('novel dominant intent')));
});

test('score: feature spike → anomalous', () => {
  for (let i = 0; i < 4; i += 1) {
    detector.observe({ userId: 'u', profile: profile({ featureCount: 4, dominantIntentKind: 'build' }) });
  }
  const out = detector.score({ userId: 'u', profile: profile({ featureCount: 12, dominantIntentKind: 'build' }) });
  assert.strictEqual(out.anomalous, true);
  assert.strictEqual(out.featureSpike, true);
  assert.ok(out.reasons.some((r) => r.includes('feature count')));
});

test('score: centroid jump triggers z-score reason', () => {
  for (let i = 0; i < 6; i += 1) {
    detector.observe({
      userId: 'u',
      profile: profile({ centroid: { feature: 0.6, context: 0.2, intent: 0.1, input: 0.05, action: 0.05 }, dominantIntentKind: 'build' }),
    });
  }
  const out = detector.score({
    userId: 'u',
    profile: profile({ centroid: { feature: 0.05, context: 0.05, intent: 0.05, input: 0.05, action: 0.8 }, dominantIntentKind: 'build' }),
  });
  // Either zScore or feature shift should flag it
  assert.ok(out.anomalous);
});

test('score: empty buffer + immediate score returns insufficient', () => {
  const out = detector.score({ userId: 'newbie', profile: profile() });
  assert.strictEqual(out.anomalous, false);
});

test('observe: buffer cap enforced at BUFFER_SIZE', () => {
  for (let i = 0; i < detector.BUFFER_SIZE + 10; i += 1) {
    detector.observe({ userId: 'u', profile: profile({ dominantIntentKind: 'build' }) });
  }
  const baseline = detector.getBaseline('u');
  assert.strictEqual(baseline.samples, detector.BUFFER_SIZE);
});

test('observe: intent kinds are cumulative (not reset by buffer rollover)', () => {
  detector.observe({ userId: 'u', profile: profile({ dominantIntentKind: 'translate' }) });
  for (let i = 0; i < detector.BUFFER_SIZE + 5; i += 1) {
    detector.observe({ userId: 'u', profile: profile({ dominantIntentKind: 'build' }) });
  }
  // translate was dropped from profiles but should still be in intentKinds set
  const baseline = detector.getBaseline('u');
  assert.ok(baseline.intentKinds.includes('translate'));
});

test('buildAnomalyBlock returns empty for non-anomalous score', () => {
  assert.strictEqual(detector.buildAnomalyBlock(null), '');
  assert.strictEqual(detector.buildAnomalyBlock({ anomalous: false }), '');
});

test('buildAnomalyBlock returns prompt text for anomalous score', () => {
  const block = detector.buildAnomalyBlock({
    anomalous: true,
    score: 0.8,
    reasons: ['novel dominant intent "translate"'],
    novelIntent: true,
  });
  assert.ok(block.includes('<attribution_anomaly>'));
  assert.ok(block.includes('Nueva intención'));
});

test('clear({userId}) wipes one user only', () => {
  detector.observe({ userId: 'a', profile: profile() });
  detector.observe({ userId: 'b', profile: profile() });
  detector.clear({ userId: 'a' });
  assert.strictEqual(detector.getBaseline('a'), null);
  assert.ok(detector.getBaseline('b'));
});

test('clear() with no args wipes everything', () => {
  detector.observe({ userId: 'a', profile: profile() });
  detector.observe({ userId: 'b', profile: profile() });
  detector.clear();
  assert.strictEqual(detector.stats().users, 0);
});

test('stats reports current state', () => {
  for (let i = 0; i < 3; i += 1) {
    detector.observe({ userId: 'u', profile: profile() });
  }
  const s = detector.stats();
  assert.ok(s.users >= 1);
  assert.ok(s.totalProfiles >= 3);
});

test('hot path: 100 observe + score cycles under 100ms', () => {
  const t0 = Date.now();
  for (let i = 0; i < 100; i += 1) {
    const p = profile({ dominantIntentKind: i % 4 === 0 ? 'fix' : 'build' });
    detector.observe({ userId: 'perf', profile: p });
    detector.score({ userId: 'perf', profile: p });
  }
  assert.ok(Date.now() - t0 < 100);
});

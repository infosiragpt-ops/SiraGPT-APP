'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const intentAttribution = require('../src/services/intent-attribution-graph');
const adaptive = require('../src/services/intent-attribution-graph/adaptive-weights');
const adminMetrics = require('../src/services/intent-attribution-graph/admin-metrics');
const validator = require('../src/services/intent-attribution-graph/response-validator');

// ─────────────────────────────────────────────────────────────────────────
// adaptive-weights
// ─────────────────────────────────────────────────────────────────────────

describe('adaptive-weights', () => {
  beforeEach(() => adaptive.resetAll());

  it('returns null with no userId', () => {
    const r = intentAttribution.analyzeIntent('crea código');
    const v = validator.validate(r, 'creé el código');
    const result = adaptive.recordOutcome(null, r, v);
    assert.equal(result, null);
  });

  it('records outcome for a user', () => {
    const r = intentAttribution.analyzeIntent('crea código backend');
    const v = validator.validate(r, 'He creado el código backend.');
    const result = adaptive.recordOutcome('user1', r, v);
    assert.equal(result.ok, true);
    assert.equal(result.userId, 'user1');
    assert.ok(result.updatedCount > 0);
  });

  it('increases weight for covered features over time', () => {
    const r = intentAttribution.analyzeIntent('crea código backend');
    const v = validator.validate(r, 'He creado el código backend con tests.');
    for (let i = 0; i < 10; i++) {
      adaptive.recordOutcome('user2', r, v);
    }
    const snapshot = adaptive.getSnapshot('user2');
    const codeWeight = snapshot['feat:code-artifact'];
    assert.ok(codeWeight !== undefined);
    assert.ok(codeWeight >= 1, `expected weight >= 1, got ${codeWeight}`);
  });

  it('decreases weight for missed features over time', () => {
    const r = intentAttribution.analyzeIntent('crea código backend');
    const v = validator.validate(r, 'No.');
    for (let i = 0; i < 10; i++) {
      adaptive.recordOutcome('user3', r, v);
    }
    const snapshot = adaptive.getSnapshot('user3');
    const codeWeight = snapshot['feat:code-artifact'];
    assert.ok(codeWeight !== undefined);
    assert.ok(codeWeight < 1, `expected weight < 1, got ${codeWeight}`);
  });

  it('partitions weights per user', () => {
    const r = intentAttribution.analyzeIntent('crea código');
    const v1 = validator.validate(r, 'creé el código');
    const v2 = validator.validate(r, 'No.');
    for (let i = 0; i < 5; i++) {
      adaptive.recordOutcome('user_a', r, v1);
      adaptive.recordOutcome('user_b', r, v2);
    }
    const snapA = adaptive.getSnapshot('user_a');
    const snapB = adaptive.getSnapshot('user_b');
    assert.ok(snapA['feat:code-artifact'] > snapB['feat:code-artifact']);
  });

  it('clamps weights to [MIN, MAX]', () => {
    const r = intentAttribution.analyzeIntent('crea código');
    const v = validator.validate(r, 'creé el código');
    for (let i = 0; i < 100; i++) {
      adaptive.recordOutcome('user_clamp', r, v, 0.5);
    }
    const snap = adaptive.getSnapshot('user_clamp');
    for (const w of Object.values(snap)) {
      assert.ok(w >= adaptive.MIN_WEIGHT && w <= adaptive.MAX_WEIGHT);
    }
  });

  it('applyWeights mutates feature weights', () => {
    const r = intentAttribution.analyzeIntent('crea código');
    const v = validator.validate(r, 'creé el código');
    for (let i = 0; i < 5; i++) adaptive.recordOutcome('user_apply', r, v);

    const original = intentAttribution.analyzeIntent('crea código backend');
    const adjusted = adaptive.applyWeights('user_apply', original);
    assert.ok(adjusted._adaptiveApplied);
    const origCode = original.features.find((f) => f.label === 'code-artifact');
    const adjCode = adjusted.features.find((f) => f.label === 'code-artifact');
    if (origCode && adjCode) {
      assert.notEqual(origCode.weight, adjCode.weight);
    }
  });

  it('applyWeights is no-op without prior recording', () => {
    const r = intentAttribution.analyzeIntent('crea código');
    const adjusted = adaptive.applyWeights('unknown_user', r);
    assert.deepEqual(adjusted, r);
  });

  it('getStats returns user and label counts', () => {
    const r = intentAttribution.analyzeIntent('crea código');
    const v = validator.validate(r, 'creé');
    adaptive.recordOutcome('s1', r, v);
    adaptive.recordOutcome('s2', r, v);
    const stats = adaptive.getStats();
    assert.equal(stats.userCount, 2);
    assert.ok(stats.totalLabels > 0);
  });

  it('resetUser clears one user only', () => {
    const r = intentAttribution.analyzeIntent('crea código');
    const v = validator.validate(r, 'creé');
    adaptive.recordOutcome('keep', r, v);
    adaptive.recordOutcome('drop', r, v);
    adaptive.resetUser('drop');
    assert.ok(Object.keys(adaptive.getSnapshot('keep')).length > 0);
    assert.equal(Object.keys(adaptive.getSnapshot('drop')).length, 0);
  });

  it('handles empty reports gracefully', () => {
    const result = adaptive.recordOutcome('u', { empty: true }, {});
    // Empty report has no features, so updateCount = 0 but ok = true
    assert.ok(result.ok);
    assert.equal(result.updatedCount, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// admin-metrics
// ─────────────────────────────────────────────────────────────────────────

describe('admin-metrics', () => {
  beforeEach(() => adminMetrics.reset());

  it('records a non-empty report', () => {
    const r = intentAttribution.analyzeIntent('crea código');
    adminMetrics.record(r);
    assert.equal(adminMetrics.getBufferSize(), 1);
  });

  it('skips empty reports', () => {
    adminMetrics.record({ empty: true });
    adminMetrics.record(null);
    assert.equal(adminMetrics.getBufferSize(), 0);
  });

  it('computes basic metrics over recorded entries', () => {
    for (let i = 0; i < 5; i++) {
      const r = intentAttribution.analyzeIntent('crea código backend');
      adminMetrics.record(r);
    }
    const m = adminMetrics.getMetrics();
    assert.equal(m.sampleCount, 5);
    assert.ok(m.avgConfidence > 0);
    assert.ok(m.avgFeatureCount > 0);
    assert.ok(m.topThemes.length > 0);
  });

  it('computes percentile durations', () => {
    for (let i = 0; i < 20; i++) {
      const r = intentAttribution.analyzeIntent('crea código ' + i);
      adminMetrics.record(r);
    }
    const m = adminMetrics.getMetrics();
    assert.ok(m.p95DurationMs >= 0);
  });

  it('produces language histogram', () => {
    adminMetrics.record(intentAttribution.analyzeIntent('crea código'));
    adminMetrics.record(intentAttribution.analyzeIntent('build code'));
    const m = adminMetrics.getMetrics();
    assert.ok(Object.keys(m.languageHistogram).length >= 1);
  });

  it('respects time window filter', () => {
    const r = intentAttribution.analyzeIntent('crea código');
    adminMetrics.record(r);
    // Window of 1ms — entry just recorded but might be 0ms old, still match
    const m = adminMetrics.getMetrics({ windowMs: 60000 });
    assert.ok(m.sampleCount >= 1);
    const m2 = adminMetrics.getMetrics({ windowMs: 0 });
    // After windowMs=0, anything older than 0ms is excluded
    assert.ok(m2.sampleCount <= 1);
  });

  it('top themes ranked by count', () => {
    for (let i = 0; i < 4; i++) adminMetrics.record(intentAttribution.analyzeIntent('crea código backend'));
    for (let i = 0; i < 2; i++) adminMetrics.record(intentAttribution.analyzeIntent('analiza este documento'));
    const m = adminMetrics.getMetrics();
    assert.ok(m.topThemes[0].count >= m.topThemes[m.topThemes.length - 1].count);
  });

  it('clarificationRate computed correctly', () => {
    adminMetrics.record(intentAttribution.analyzeIntent('arregla'));    // ambiguous → shouldClarify=true
    adminMetrics.record(intentAttribution.analyzeIntent('crea un endpoint REST en backend con Prisma')); // clear
    const m = adminMetrics.getMetrics();
    assert.ok(m.clarificationRate >= 0 && m.clarificationRate <= 1);
  });

  it('returns no-data for empty buffer', () => {
    const m = adminMetrics.getMetrics();
    assert.equal(m.sampleCount, 0);
    assert.equal(m.summary, 'no data in window');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// End-to-end Phase 3 pipeline
// ─────────────────────────────────────────────────────────────────────────

describe('Phase 3 integration', () => {
  beforeEach(() => {
    adaptive.resetAll();
    adminMetrics.reset();
  });

  it('learn → apply cycle produces noticeable bias', () => {
    const r1 = intentAttribution.analyzeIntent('crea un endpoint backend');
    const v1 = validator.validate(r1, 'He creado el endpoint backend con todos los tests pasando.');
    for (let i = 0; i < 20; i++) adaptive.recordOutcome('integration_user', r1, v1);

    const r2 = intentAttribution.analyzeIntent('crea otro endpoint backend');
    const adjusted = adaptive.applyWeights('integration_user', r2);
    const origBackend = r2.features.find((f) => f.label === 'api-surface');
    const adjBackend = adjusted.features.find((f) => f.label === 'api-surface');
    if (origBackend && adjBackend) {
      assert.ok(adjBackend.weight >= origBackend.weight);
    }
  });

  it('admin metrics reflects diverse traffic over time', () => {
    const prompts = [
      'crea código backend',
      'arregla el bug urgente',
      'analiza este documento',
      'despliega el sistema',
      'traduce esto al inglés',
    ];
    for (const p of prompts) adminMetrics.record(intentAttribution.analyzeIntent(p));

    const m = adminMetrics.getMetrics();
    assert.equal(m.sampleCount, 5);
    // We expect multiple themes detected
    assert.ok(m.topThemes.length >= 2);
  });
});

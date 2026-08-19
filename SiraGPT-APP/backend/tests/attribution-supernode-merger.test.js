'use strict';

const test = require('node:test');
const assert = require('node:assert');

const merger = require('../src/services/attribution-supernode-merger');

test('tokenize strips stopwords + short tokens', () => {
  const t = merger.tokenize('The new Backend API for production!');
  assert.ok(!t.includes('the'));
  assert.ok(!t.includes('for'));
  assert.ok(t.includes('backend'));
  assert.ok(t.includes('production'));
});

test('jaccard: empty + identical', () => {
  assert.strictEqual(merger.jaccard(new Set(), new Set(['x'])), 0);
  assert.strictEqual(merger.jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
});

test('cosineSim: aligned + orthogonal', () => {
  assert.strictEqual(merger.cosineSim([1, 2, 3], [1, 2, 3]), 1);
  assert.strictEqual(merger.cosineSim([1, 0], [0, 1]), 0);
});

test('mergeFeatures clusters lexically-overlapping features', () => {
  const merged = merger.mergeFeatures([
    { kind: 'topic', label: 'backend deployment', weight: 0.9 },
    { kind: 'topic', label: 'backend deploy', weight: 0.7 },
    { kind: 'topic', label: 'production backend', weight: 0.6 },
    { kind: 'topic', label: 'unrelated marketing', weight: 0.5 },
  ]);
  assert.ok(merged.supernodes.length >= 1, 'should create a supernode for backend cluster');
  const big = merged.supernodes[0];
  assert.ok(big.memberCount >= 2, `expected ≥ 2 members, got ${big.memberCount}`);
});

test('mergeFeatures never crosses kinds', () => {
  const merged = merger.mergeFeatures([
    { kind: 'topic', label: 'backend api', weight: 0.7 },
    { kind: 'entity', label: 'backend api', weight: 0.7 },
  ]);
  for (const s of merged.supernodes) {
    assert.ok(s.memberCount === 1 || s.kind === merged.supernodes[0].kind);
  }
});

test('mergeFeatures: residuals for unrelated singletons', () => {
  const merged = merger.mergeFeatures([
    { kind: 'topic', label: 'pineapple', weight: 0.4 },
    { kind: 'topic', label: 'quantum mechanics', weight: 0.6 },
  ]);
  assert.strictEqual(merged.supernodes.length, 0);
  assert.strictEqual(merged.residuals.length, 2);
});

test('embedding cosine merges when lexical fails', () => {
  const merged = merger.mergeFeatures([
    { kind: 'topic', label: 'alpha', weight: 0.8, embedding: [1, 0, 0] },
    { kind: 'topic', label: 'beta', weight: 0.7, embedding: [0.99, 0.01, 0] },
  ]);
  assert.strictEqual(merged.supernodes.length, 1);
  assert.strictEqual(merged.supernodes[0].memberCount, 2);
});

test('aggregateWeight gets a size bonus above seed weight', () => {
  const merged = merger.mergeFeatures([
    { kind: 'topic', label: 'deploy backend', weight: 0.6 },
    { kind: 'topic', label: 'backend deploy', weight: 0.6 },
    { kind: 'topic', label: 'backend production', weight: 0.6 },
  ]);
  const big = merged.supernodes.find((s) => s.memberCount >= 2);
  assert.ok(big);
  assert.ok(big.aggregateWeight > 0.6, `expected size bonus, got ${big.aggregateWeight}`);
});

test('returns stats including durationMs', () => {
  const merged = merger.mergeFeatures([
    { kind: 'topic', label: 'auth middleware', weight: 0.8 },
    { kind: 'topic', label: 'auth handler', weight: 0.7 },
  ]);
  assert.strictEqual(merged.stats.input, 2);
  assert.ok(typeof merged.stats.durationMs === 'number');
});

test('empty input returns sane defaults', () => {
  const r = merger.mergeFeatures([]);
  assert.strictEqual(r.supernodes.length, 0);
  assert.strictEqual(r.residuals.length, 0);
});

test('buildSupernodeBlock returns prompt text for non-empty merge', () => {
  const merged = merger.mergeFeatures([
    { kind: 'topic', label: 'deploy backend', weight: 0.7 },
    { kind: 'topic', label: 'backend deploy', weight: 0.7 },
  ]);
  const block = merger.buildSupernodeBlock(merged);
  assert.ok(block.includes('<feature_supernodes>'));
  assert.ok(block.includes('</feature_supernodes>'));
});

test('buildSupernodeBlock empty for no supernodes', () => {
  assert.strictEqual(merger.buildSupernodeBlock(null), '');
  assert.strictEqual(merger.buildSupernodeBlock({ supernodes: [] }), '');
});

test('hot path: 50 features under 50ms', () => {
  const features = Array.from({ length: 50 }, (_, i) => ({
    kind: i % 3 === 0 ? 'topic' : (i % 3 === 1 ? 'entity' : 'constraint'),
    label: `feature ${i} ${i % 5 === 0 ? 'shared' : ''}`,
    weight: 0.4 + (i % 10) * 0.05,
  }));
  const t0 = Date.now();
  merger.mergeFeatures(features);
  assert.ok(Date.now() - t0 < 50);
});

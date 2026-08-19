'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const sim = require('../src/services/concept-similarity');

describe('concept-similarity', () => {
  test('canonical maps surfaces to canonical groups', () => {
    assert.equal(sim.canonical('frontend'), 'ui');
    assert.equal(sim.canonical('UI'), 'ui');
    assert.equal(sim.canonical('interfaz'), 'ui');
    assert.equal(sim.canonical('arregla'), 'fix');
    assert.equal(sim.canonical('debug'), 'fix');
  });

  test('canonical accepts concept objects', () => {
    assert.equal(sim.canonical({ normalized: 'despliega' }), 'deploy');
    assert.equal(sim.canonical({ surface: 'Ship' }), 'deploy');
  });

  test('canonical falls back to normalized surface when no match', () => {
    assert.equal(sim.canonical('xyzzy_unknown'), 'xyzzy_unknown');
  });

  test('similarityScore = 1 for same canonical', () => {
    assert.equal(sim.similarityScore('frontend', 'UI'), 1);
    assert.equal(sim.similarityScore('arregla', 'fix'), 1);
  });

  test('similarityScore = 0 for unrelated', () => {
    assert.equal(sim.similarityScore('frontend', 'database'), 0);
  });

  test('cluster groups concepts by canonical', () => {
    const concepts = [
      { surface: 'frontend', normalized: 'frontend', weight: 0.6 },
      { surface: 'UI', normalized: 'ui', weight: 0.7 },
      { surface: 'interfaz', normalized: 'interfaz', weight: 0.5 },
      { surface: 'backend', normalized: 'backend', weight: 0.8 },
    ];
    const groups = sim.cluster(concepts);
    const ui = groups.find((g) => g.canonical === 'ui');
    assert.ok(ui);
    assert.equal(ui.members.length, 3);
    assert.ok(groups.find((g) => g.canonical === 'backend'));
  });

  test('extractAndCluster runs the full pipeline', () => {
    const r = sim.extractAndCluster('Arregla el bug del frontend y despliega');
    assert.ok(r.clusters.length >= 1);
    assert.ok(r.clusters.find((c) => c.canonical === 'fix') || r.clusters.find((c) => c.canonical === 'ui'));
  });

  test('buildSimilarityBlock returns content when clusters exist', () => {
    const r = sim.extractAndCluster('Arregla el bug del frontend y despliega el backend');
    const block = sim.buildSimilarityBlock(r.clusters);
    assert.match(block, /CONCEPT SUPERNODES/);
  });

  test('buildSimilarityBlock empty for no clusters', () => {
    assert.equal(sim.buildSimilarityBlock([]), '');
  });

  test('GROUPS is frozen', () => {
    assert.throws(() => { sim.GROUPS.foo = 'bar'; });
  });
});

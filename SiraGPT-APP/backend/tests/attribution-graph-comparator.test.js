'use strict';

const test = require('node:test');
const assert = require('node:assert');

const cmp = require('../src/services/attribution-graph-comparator');

function makeGraph(nodes, edges = []) {
  const map = new Map();
  for (const n of nodes) map.set(n.id, n);
  return { nodes: map, edges };
}

test('identical graphs report zero shift', () => {
  const g = makeGraph(
    [
      { id: 'i', type: 'input', text: 'msg' },
      { id: 'c', type: 'context', kind: 'memory', text: 'fact' },
      { id: 'in', type: 'intent', text: 'build', weight: 0.8 },
    ],
    [{ from: 'i', to: 'in', weight: 0.7 }],
  );
  const d = cmp.compareGraphs(g, g);
  assert.strictEqual(d.topologyShiftScore, 0);
  assert.strictEqual(d.intentShift.changed, false);
});

test('added node detected', () => {
  const g1 = makeGraph([{ id: 'i', type: 'input', text: 'msg' }]);
  const g2 = makeGraph([{ id: 'i', type: 'input', text: 'msg' }, { id: 'c', type: 'context', text: 'extra' }]);
  const d = cmp.compareGraphs(g1, g2);
  assert.strictEqual(d.nodesAdded.length, 1);
  assert.strictEqual(d.nodesAdded[0].type, 'context');
});

test('removed node detected', () => {
  const g1 = makeGraph([{ id: 'i', type: 'input', text: 'msg' }, { id: 'c', type: 'context', text: 'extra' }]);
  const g2 = makeGraph([{ id: 'i', type: 'input', text: 'msg' }]);
  const d = cmp.compareGraphs(g1, g2);
  assert.strictEqual(d.nodesRemoved.length, 1);
});

test('weight-shifted edges flagged for delta ≥ 0.05', () => {
  const g1 = makeGraph([{ id: 'a', type: 'input' }, { id: 'b', type: 'feature' }], [{ from: 'a', to: 'b', weight: 0.5 }]);
  const g2 = makeGraph([{ id: 'a', type: 'input' }, { id: 'b', type: 'feature' }], [{ from: 'a', to: 'b', weight: 0.75 }]);
  const d = cmp.compareGraphs(g1, g2);
  assert.strictEqual(d.edgesShifted.length, 1);
});

test('small edge-weight delta ignored', () => {
  const g1 = makeGraph([{ id: 'a', type: 'input' }, { id: 'b', type: 'feature' }], [{ from: 'a', to: 'b', weight: 0.5 }]);
  const g2 = makeGraph([{ id: 'a', type: 'input' }, { id: 'b', type: 'feature' }], [{ from: 'a', to: 'b', weight: 0.51 }]);
  const d = cmp.compareGraphs(g1, g2);
  assert.strictEqual(d.edgesShifted.length, 0);
});

test('intent shift flagged on dominant-intent change', () => {
  const g1 = makeGraph([{ id: 'i1', type: 'intent', text: 'build chart', weight: 0.8 }]);
  const g2 = makeGraph([{ id: 'i2', type: 'intent', text: 'fix bug', weight: 0.8 }]);
  const d = cmp.compareGraphs(g1, g2);
  assert.strictEqual(d.intentShift.changed, true);
  assert.strictEqual(d.intentShift.before.label, 'build chart');
  assert.strictEqual(d.intentShift.after.label, 'fix bug');
});

test('same dominant intent → not flagged', () => {
  const g1 = makeGraph([{ id: 'i1', type: 'intent', text: 'build', weight: 0.7 }]);
  const g2 = makeGraph([{ id: 'i2', type: 'intent', text: 'build', weight: 0.9 }]);
  const d = cmp.compareGraphs(g1, g2);
  assert.strictEqual(d.intentShift.changed, false);
});

test('graphCentroid + centroidDrift compute type proportions', () => {
  const a = cmp.graphCentroid([{ type: 'input' }, { type: 'context' }, { type: 'feature' }, { type: 'feature' }]);
  const b = cmp.graphCentroid([{ type: 'input' }, { type: 'context' }, { type: 'intent' }]);
  assert.ok(a.feature > b.feature);
  const drift = cmp.centroidDrift(a, b);
  assert.ok(drift > 0 && drift <= 1);
});

test('feature churn counts changed feature nodes only', () => {
  const g1 = makeGraph([{ id: 'i', type: 'input' }, { id: 'f1', type: 'feature', text: 'A' }, { id: 'f2', type: 'feature', text: 'B' }]);
  const g2 = makeGraph([{ id: 'i', type: 'input' }, { id: 'f3', type: 'feature', text: 'C' }]);
  const d = cmp.compareGraphs(g1, g2);
  assert.strictEqual(d.featureChurn, 3);
});

test('topologyShiftScore stays in [0, 1]', () => {
  const g1 = makeGraph([{ id: 'a', type: 'input' }]);
  const g2 = makeGraph(
    Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, type: 'feature', text: `t${i}` })),
    Array.from({ length: 15 }, (_, i) => ({ from: 'n0', to: `n${i + 1}`, weight: 0.5 })),
  );
  const d = cmp.compareGraphs(g1, g2);
  assert.ok(d.topologyShiftScore >= 0 && d.topologyShiftScore <= 1);
});

test('buildDiffSummary produces a one-line log', () => {
  const g1 = makeGraph([{ id: 'a', type: 'input' }]);
  const g2 = makeGraph([{ id: 'a', type: 'input' }, { id: 'b', type: 'feature' }]);
  const summary = cmp.buildDiffSummary(cmp.compareGraphs(g1, g2));
  assert.ok(summary.includes('[graph-diff]'));
});

test('buildDiffBlock returns a prompt block', () => {
  const g1 = makeGraph([{ id: 'i', type: 'intent', text: 'build' }]);
  const g2 = makeGraph([{ id: 'i', type: 'intent', text: 'fix' }]);
  const block = cmp.buildDiffBlock(cmp.compareGraphs(g1, g2));
  assert.ok(block.includes('<attribution_graph_diff>'));
});

test('handles array-shaped graph.nodes', () => {
  const g1 = { nodes: [{ id: 'a', type: 'input' }], edges: [] };
  const g2 = { nodes: [{ id: 'a', type: 'input' }, { id: 'b', type: 'feature' }], edges: [] };
  const d = cmp.compareGraphs(g1, g2);
  assert.strictEqual(d.nodesAdded.length, 1);
});

test('hot path: 30-node graphs compared in < 50ms', () => {
  const big = makeGraph(
    Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, type: 'feature', text: `t${i}` })),
    Array.from({ length: 25 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}`, weight: 0.5 })),
  );
  const t0 = Date.now();
  cmp.compareGraphs(big, big);
  assert.ok(Date.now() - t0 < 50);
});

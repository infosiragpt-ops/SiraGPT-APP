'use strict';

const test = require('node:test');
const assert = require('node:assert');

const viz = require('../src/services/attribution-graph-visualizer');

function makeGraph() {
  // simulates the shape attribution-graph.buildGraph() returns (Map-based nodes)
  const nodes = new Map();
  nodes.set('input_0', { id: 'input_0', type: 'input', text: 'user msg', weight: 1 });
  nodes.set('ctx_1', { id: 'ctx_1', type: 'context', kind: 'memory', text: 'user fact', weight: 0.7 });
  nodes.set('feat_1', { id: 'feat_1', type: 'feature', text: 'topic', weight: 0.6 });
  nodes.set('intent_1', { id: 'intent_1', type: 'intent', text: 'build chart', weight: 0.8 });
  const edges = [
    { from: 'input_0', to: 'ctx_1', weight: 0.5 },
    { from: 'input_0', to: 'feat_1', weight: 0.6 },
    { from: 'feat_1', to: 'intent_1', weight: 0.7 },
  ];
  return { nodes, edges, inputId: 'input_0' };
}

test('colourForType returns the canonical palette colour', () => {
  assert.strictEqual(viz.colourForType('input'), '#1f77b4');
  assert.strictEqual(viz.colourForType('context'), '#2ca02c');
  assert.strictEqual(viz.colourForType('unknown'), '#888');
});

test('toMermaid renders a flowchart with node + edge entries', () => {
  const text = viz.toMermaid(makeGraph());
  assert.ok(text.startsWith('flowchart LR'));
  assert.ok(text.includes('input_0'));
  assert.ok(text.includes('intent_1'));
  assert.ok(text.includes('classDef input fill:#1f77b4'));
  assert.ok(text.includes('-->'));
});

test('toMermaid handles empty graph', () => {
  assert.ok(viz.toMermaid({ nodes: new Map(), edges: [] }).includes('empty graph'));
  assert.ok(viz.toMermaid(null).includes('empty graph'));
});

test('toCytoscape returns nodes + edges with styles', () => {
  const out = viz.toCytoscape(makeGraph());
  assert.ok(Array.isArray(out.nodes) && out.nodes.length === 4);
  assert.ok(Array.isArray(out.edges) && out.edges.length === 3);
  const intent = out.nodes.find((n) => n.data.id === 'intent_1');
  assert.strictEqual(intent.data.type, 'intent');
  assert.ok(intent.style['background-color']);
  for (const e of out.edges) {
    assert.ok(typeof e.style.opacity === 'number');
    assert.ok(e.style.width >= 1);
  }
});

test('toCytoscape filters weak edges below minEdgeWeight', () => {
  const graph = {
    nodes: new Map([
      ['a', { id: 'a', type: 'input' }],
      ['b', { id: 'b', type: 'context' }],
    ]),
    edges: [
      { from: 'a', to: 'b', weight: 0.01 },
      { from: 'a', to: 'b', weight: 0.6 },
    ],
  };
  const out = viz.toCytoscape(graph, { minEdgeWeight: 0.1 });
  assert.strictEqual(out.edges.length, 1);
});

test('toCompactJSON returns palette + legend + stats', () => {
  const out = viz.toCompactJSON(makeGraph());
  assert.ok(Array.isArray(out.nodes));
  assert.ok(Array.isArray(out.edges));
  assert.ok(out.palette);
  assert.ok(Array.isArray(out.legend));
  assert.strictEqual(out.stats.nodeCount, 4);
  assert.strictEqual(out.stats.edgeCount, 3);
  assert.ok(out.stats.typeBreakdown.intent === 1);
});

test('toCompactJSON survives JSON round-trip', () => {
  const out = viz.toCompactJSON(makeGraph());
  const round = JSON.parse(JSON.stringify(out));
  assert.strictEqual(round.nodes.length, out.nodes.length);
  assert.strictEqual(round.edges.length, out.edges.length);
});

test('buildLegend returns one entry per canonical type', () => {
  const legend = viz.buildLegend();
  const types = legend.map((l) => l.type);
  for (const t of ['input', 'context', 'feature', 'intent', 'action']) {
    assert.ok(types.includes(t));
  }
});

test('handles Array-shaped graph.nodes (not just Map)', () => {
  const graph = {
    nodes: [
      { id: 'a', type: 'input', text: 'x' },
      { id: 'b', type: 'feature', text: 'y' },
    ],
    edges: [{ from: 'a', to: 'b', weight: 0.5 }],
  };
  const out = viz.toCompactJSON(graph);
  assert.strictEqual(out.nodes.length, 2);
  assert.strictEqual(out.edges.length, 1);
});

test('sanitizes IDs to safe alphanumerics', () => {
  const graph = {
    nodes: new Map([['weird id with spaces & symbols', { id: 'weird id with spaces & symbols', type: 'feature' }]]),
    edges: [],
  };
  const out = viz.toCompactJSON(graph);
  assert.ok(/^[a-zA-Z0-9_]+$/.test(out.nodes[0].id));
});

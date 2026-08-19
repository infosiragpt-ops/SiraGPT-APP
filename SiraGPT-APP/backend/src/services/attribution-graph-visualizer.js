'use strict';

/**
 * attribution-graph-visualizer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Turns an attribution-graph snapshot (from `attribution-graph.js` or
 * the meta-engine bundle) into JSON-safe rendering payloads for the
 * UI explainer panel. Three output shapes:
 *
 *   1. toMermaid(graph)      → string  (Mermaid flowchart syntax)
 *   2. toCytoscape(graph)    → { nodes: [...], edges: [...] }  for cytoscape.js
 *   3. toCompactJSON(graph)  → { nodes, edges, palette, legend }
 *
 * Per-node colour is derived from `type` (input / context / feature /
 * intent / action) with a fixed palette; per-edge opacity scales with
 * weight so weak edges fade.
 *
 * Pure JS, no DOM. Designed to run server-side and ship a payload to a
 * front-end that renders without re-computing layout.
 *
 * Public API:
 *   toMermaid(graph, opts?)
 *   toCytoscape(graph, opts?)
 *   toCompactJSON(graph, opts?)
 *   buildLegend(opts?)
 *   colourForType(type)
 */

const TYPE_COLOURS = Object.freeze({
  input: '#1f77b4',
  context: '#2ca02c',
  feature: '#ff7f0e',
  intent: '#9467bd',
  action: '#d62728',
});

const TYPE_SHAPES = Object.freeze({
  input: 'rect',
  context: 'roundrectangle',
  feature: 'ellipse',
  intent: 'diamond',
  action: 'hexagon',
});

const DEFAULT_PALETTE = TYPE_COLOURS;

function colourForType(type) {
  return TYPE_COLOURS[type] || '#888';
}

function sanitizeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
}

function sanitizeLabel(label, max = 60) {
  return String(label || '').replace(/[\n\r"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function nodesFromGraph(graph) {
  if (!graph) return [];
  if (graph.nodes instanceof Map) return [...graph.nodes.values()];
  if (Array.isArray(graph.nodes)) return graph.nodes;
  return [];
}

function edgesFromGraph(graph) {
  if (!graph) return [];
  if (Array.isArray(graph.edges)) return graph.edges;
  return [];
}

function toMermaid(graph, opts = {}) {
  const nodes = nodesFromGraph(graph);
  const edges = edgesFromGraph(graph);
  if (nodes.length === 0) return 'flowchart LR\n  %% empty graph';
  const lines = ['flowchart LR'];
  for (const n of nodes) {
    const id = sanitizeId(n.id);
    const label = `${(n.type || 'node').slice(0, 1).toUpperCase()}: ${sanitizeLabel(n.text || n.label || id, 40)}`;
    lines.push(`  ${id}["${label}"]:::${n.type || 'node'}`);
  }
  for (const e of edges) {
    const from = sanitizeId(e.from);
    const to = sanitizeId(e.to);
    const weight = Number(e.weight || 0).toFixed(2);
    lines.push(`  ${from} -->|${weight}| ${to}`);
  }
  // class styles
  for (const [type, hex] of Object.entries(TYPE_COLOURS)) {
    lines.push(`  classDef ${type} fill:${hex},stroke:${hex},color:#fff`);
  }
  const text = lines.join('\n');
  const max = Number(opts.maxChars) || 12_000;
  return text.length <= max ? text : `${text.slice(0, max - 20)}\n%% truncated`;
}

function toCytoscape(graph, opts = {}) {
  const nodes = nodesFromGraph(graph);
  const edges = edgesFromGraph(graph);
  const minEdgeWeight = Number.isFinite(Number(opts.minEdgeWeight)) ? Number(opts.minEdgeWeight) : 0.05;
  return {
    nodes: nodes.map((n) => ({
      data: {
        id: sanitizeId(n.id),
        label: sanitizeLabel(n.text || n.label || n.id, 80),
        type: n.type || 'node',
        kind: n.kind || null,
        weight: typeof n.weight === 'number' ? Number(n.weight.toFixed(3)) : null,
      },
      classes: n.type || 'node',
      style: {
        'background-color': colourForType(n.type),
        shape: TYPE_SHAPES[n.type] || 'ellipse',
      },
    })),
    edges: edges
      .filter((e) => Number(e.weight || 0) >= minEdgeWeight)
      .map((e, i) => ({
        data: {
          id: `e_${i}`,
          source: sanitizeId(e.from),
          target: sanitizeId(e.to),
          weight: Number(e.weight || 0).toFixed(3),
        },
        style: {
          'line-color': '#777',
          opacity: Math.max(0.15, Math.min(1, Number(e.weight || 0))),
          width: 1 + Math.min(4, Math.max(0, Number(e.weight || 0) * 4)),
        },
      })),
  };
}

function buildLegend() {
  return Object.entries(TYPE_COLOURS).map(([type, colour]) => ({
    type,
    colour,
    shape: TYPE_SHAPES[type] || 'ellipse',
    description: legendDescription(type),
  }));
}

function legendDescription(type) {
  switch (type) {
    case 'input': return 'The current user message.';
    case 'context': return 'Retrieved supporting evidence (RAG, memory, past turns).';
    case 'feature': return 'Derived signal: entity, topic, or constraint.';
    case 'intent': return 'Inferred sub-intent the user wants.';
    case 'action': return 'Recommended response strategy / tool choice.';
    default: return 'Unclassified node.';
  }
}

function toCompactJSON(graph, opts = {}) {
  const nodes = nodesFromGraph(graph);
  const edges = edgesFromGraph(graph);
  const minEdgeWeight = Number.isFinite(Number(opts.minEdgeWeight)) ? Number(opts.minEdgeWeight) : 0.05;
  return {
    nodes: nodes.map((n) => ({
      id: sanitizeId(n.id),
      label: sanitizeLabel(n.text || n.label || n.id, 80),
      type: n.type || 'node',
      kind: n.kind || null,
      weight: typeof n.weight === 'number' ? Number(n.weight.toFixed(3)) : null,
      colour: colourForType(n.type),
      shape: TYPE_SHAPES[n.type] || 'ellipse',
    })),
    edges: edges
      .filter((e) => Number(e.weight || 0) >= minEdgeWeight)
      .map((e) => ({
        from: sanitizeId(e.from),
        to: sanitizeId(e.to),
        weight: Number(Number(e.weight || 0).toFixed(3)),
      })),
    palette: DEFAULT_PALETTE,
    legend: buildLegend(),
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      typeBreakdown: nodes.reduce((acc, n) => {
        const t = n.type || 'node';
        acc[t] = (acc[t] || 0) + 1;
        return acc;
      }, {}),
    },
  };
}

module.exports = {
  toMermaid,
  toCytoscape,
  toCompactJSON,
  buildLegend,
  colourForType,
  TYPE_COLOURS,
  TYPE_SHAPES,
};

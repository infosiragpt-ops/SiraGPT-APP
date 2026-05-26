'use strict';

/**
 * attribution-graph-comparator.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Structural diff between two attribution graphs. Pairs with
 * `attribution-graph.js` and the visualizer to support A/B testing
 * prompts and turn-over-turn delta inspection.
 *
 * Output of compareGraphs(graphA, graphB):
 *   • nodesAdded / nodesRemoved (matched semantically by
 *     type+kind+label so renamed-id nodes still match)
 *   • commonNodes count
 *   • edgesAdded / edgesRemoved / edgesShifted (delta ≥ 0.05)
 *   • topologyShiftScore  ∈ [0, 1]  — Jaccard-style churn / size
 *   • intentShift         — does the dominant intent change?
 *   • featureChurn        — added + removed feature nodes
 *   • centroidBefore / centroidAfter / centroidDrift (L1 / 2 on
 *     type-proportion vectors)
 *
 * Pure JS, no I/O. Hot path < 5 ms for ~30 nodes each.
 *
 * Public API:
 *   compareGraphs(graphA, graphB, opts?)   → DiffReport
 *   buildDiffSummary(report)               → one-line log string
 *   buildDiffBlock(report, opts?)          → prompt-ready string
 */

function nodesFromGraph(graph) {
  if (!graph) return [];
  if (graph.nodes instanceof Map) return [...graph.nodes.values()];
  if (Array.isArray(graph.nodes)) return graph.nodes;
  return [];
}

function edgesFromGraph(graph) {
  if (!graph || !Array.isArray(graph.edges)) return [];
  return graph.edges;
}

function nodeSemanticKey(node) {
  const t = String(node?.type || 'node').toLowerCase();
  const k = String(node?.kind || '').toLowerCase();
  const l = String(node?.text || node?.label || '').toLowerCase().slice(0, 80);
  return `${t}::${k}::${l}`;
}

const edgeKey = (e) => `${e.from}=>${e.to}`;

function nodesBySemantic(nodes) {
  const map = new Map();
  for (const n of nodes) {
    const key = nodeSemanticKey(n);
    const list = map.get(key) || [];
    list.push(n);
    map.set(key, list);
  }
  return map;
}

function dominantIntent(nodes) {
  const intents = nodes.filter((n) => n.type === 'intent');
  if (intents.length === 0) return null;
  intents.sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0));
  return intents[0];
}

function graphCentroid(nodes) {
  const counts = { input: 0, context: 0, feature: 0, intent: 0, action: 0, other: 0 };
  let total = 0;
  for (const n of nodes) {
    const t = n.type || 'other';
    counts[t] = (counts[t] || 0) + 1;
    total += 1;
  }
  if (total === 0) return counts;
  const out = {};
  for (const [k, v] of Object.entries(counts)) out[k] = Number((v / total).toFixed(3));
  return out;
}

function centroidDrift(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let sum = 0;
  for (const k of keys) sum += Math.abs((a[k] || 0) - (b[k] || 0));
  return Number((sum / 2).toFixed(3));
}

function diffNodes(nodesA, nodesB) {
  const semA = nodesBySemantic(nodesA);
  const semB = nodesBySemantic(nodesB);
  const added = [];
  const removed = [];
  const common = [];
  for (const [key, list] of semB) {
    if (semA.has(key)) common.push({ key, count: Math.min(list.length, semA.get(key).length) });
    else added.push(...list);
  }
  for (const [key, list] of semA) {
    if (!semB.has(key)) removed.push(...list);
  }
  return { added, removed, common };
}

function diffEdges(edgesA, edgesB) {
  const mapA = new Map();
  const mapB = new Map();
  for (const e of edgesA) mapA.set(edgeKey(e), e);
  for (const e of edgesB) mapB.set(edgeKey(e), e);
  const added = [];
  const removed = [];
  const shifted = [];
  for (const [k, e] of mapB) {
    if (mapA.has(k)) {
      const prev = mapA.get(k);
      const delta = (Number(e.weight) || 0) - (Number(prev.weight) || 0);
      if (Math.abs(delta) >= 0.05) {
        shifted.push({ key: k, weightBefore: prev.weight, weightAfter: e.weight, delta: Number(delta.toFixed(3)) });
      }
    } else added.push(e);
  }
  for (const [k, e] of mapA) if (!mapB.has(k)) removed.push(e);
  return { added, removed, shifted };
}

function topologyShiftScore(nodeDiff, edgeDiff, totalA, totalB) {
  const totalUnit = Math.max(1, totalA + totalB);
  const churn = nodeDiff.added.length + nodeDiff.removed.length
              + edgeDiff.added.length + edgeDiff.removed.length
              + edgeDiff.shifted.length;
  return Number(Math.min(1, churn / totalUnit).toFixed(3));
}

function compareGraphs(graphA, graphB, _opts = {}) {
  const nodesA = nodesFromGraph(graphA);
  const nodesB = nodesFromGraph(graphB);
  const edgesA = edgesFromGraph(graphA);
  const edgesB = edgesFromGraph(graphB);

  const nodeDiff = diffNodes(nodesA, nodesB);
  const edgeDiff = diffEdges(edgesA, edgesB);
  const intentA = dominantIntent(nodesA);
  const intentB = dominantIntent(nodesB);
  const centroidA = graphCentroid(nodesA);
  const centroidB = graphCentroid(nodesB);

  const totalA = nodesA.length + edgesA.length;
  const totalB = nodesB.length + edgesB.length;
  const shiftScore = topologyShiftScore(nodeDiff, edgeDiff, totalA, totalB);

  return {
    nodesAdded: nodeDiff.added.map((n) => ({ id: n.id, type: n.type, label: n.text || n.label || '' })),
    nodesRemoved: nodeDiff.removed.map((n) => ({ id: n.id, type: n.type, label: n.text || n.label || '' })),
    commonNodes: nodeDiff.common.length,
    edgesAdded: edgeDiff.added.map((e) => ({ from: e.from, to: e.to, weight: e.weight })),
    edgesRemoved: edgeDiff.removed.map((e) => ({ from: e.from, to: e.to, weight: e.weight })),
    edgesShifted: edgeDiff.shifted,
    intentShift: !intentA && !intentB
      ? { changed: false }
      : (!intentA || !intentB || nodeSemanticKey(intentA) !== nodeSemanticKey(intentB))
        ? {
            changed: true,
            before: intentA ? { kind: intentA.kind, label: intentA.text || intentA.label, weight: intentA.weight } : null,
            after: intentB ? { kind: intentB.kind, label: intentB.text || intentB.label, weight: intentB.weight } : null,
          }
        : { changed: false },
    centroidBefore: centroidA,
    centroidAfter: centroidB,
    centroidDrift: centroidDrift(centroidA, centroidB),
    topologyShiftScore: shiftScore,
    featureChurn: nodeDiff.added.filter((n) => n.type === 'feature').length
                + nodeDiff.removed.filter((n) => n.type === 'feature').length,
    nodeCounts: { a: nodesA.length, b: nodesB.length },
    edgeCounts: { a: edgesA.length, b: edgesB.length },
  };
}

function buildDiffSummary(report) {
  if (!report) return '';
  const intent = report.intentShift?.changed ? 'intent CHANGED' : 'intent stable';
  return `[graph-diff] nodes Δ=${report.nodesAdded.length}+/${report.nodesRemoved.length}- edges Δ=${report.edgesAdded.length}+/${report.edgesRemoved.length}-/${report.edgesShifted.length}~ ${intent} centroid-drift=${report.centroidDrift} shift=${report.topologyShiftScore}`;
}

function buildDiffBlock(report, opts = {}) {
  if (!report) return '';
  const lines = ['\n\n<attribution_graph_diff>'];
  lines.push(`Topology shift: ${report.topologyShiftScore} · centroid drift: ${report.centroidDrift}`);
  lines.push(`Nodes: A=${report.nodeCounts.a} → B=${report.nodeCounts.b} (added ${report.nodesAdded.length}, removed ${report.nodesRemoved.length})`);
  lines.push(`Edges: A=${report.edgeCounts.a} → B=${report.edgeCounts.b} (added ${report.edgesAdded.length}, removed ${report.edgesRemoved.length}, weight-shifted ${report.edgesShifted.length})`);
  if (report.intentShift?.changed) {
    const before = report.intentShift.before?.label || 'none';
    const after = report.intentShift.after?.label || 'none';
    lines.push(`Dominant intent: "${before}" → "${after}"`);
  } else {
    lines.push('Dominant intent: unchanged');
  }
  if (Array.isArray(report.nodesAdded) && report.nodesAdded.length > 0) {
    lines.push(`Nodes added: ${report.nodesAdded.slice(0, 4).map((n) => `${n.type}:${(n.label || '').slice(0, 30)}`).join(', ')}`);
  }
  if (Array.isArray(report.nodesRemoved) && report.nodesRemoved.length > 0) {
    lines.push(`Nodes removed: ${report.nodesRemoved.slice(0, 4).map((n) => `${n.type}:${(n.label || '').slice(0, 30)}`).join(', ')}`);
  }
  lines.push('</attribution_graph_diff>');
  const text = lines.join('\n');
  const max = Number(opts.maxChars) || 1200;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

module.exports = {
  compareGraphs, buildDiffSummary, buildDiffBlock,
  nodeSemanticKey, graphCentroid, centroidDrift, dominantIntent,
};

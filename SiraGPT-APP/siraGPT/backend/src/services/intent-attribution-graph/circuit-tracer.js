'use strict';

/**
 * Circuit tracer — multi-step reasoning chains over the attribution graph.
 *
 * Mirrors the paper's Dallas→Texas→Austin example: rather than a flat
 * "what does the user want", we trace the implicit reasoning chain the
 * assistant has to perform.
 *
 *   surface request   →   intermediate concept(s)   →   downstream goal
 *
 * Each circuit is a path root → action → object [→ implicit] [→ supernode]
 * that captures one coherent strand of the request.
 *
 * Circuits are useful for the LLM because they make the *implied
 * intermediate steps* explicit, reducing the chance the model shortcuts
 * the reasoning ("I'll just answer the question" vs. "first fetch the
 * URL, then summarize, then generate a brief").
 */

const { neighbors } = require('./attribution-graph');
const { FEATURE_CATEGORIES } = require('./feature-extractor');

const MAX_CIRCUITS = 12;
const MAX_PATH_DEPTH = 6;

function describeStep(node) {
  if (!node) return '';
  if (node.synthetic) return 'user goal';
  if (node.category === 'root') return 'user goal';
  const verb = {
    action: 'wants to',
    object: 'targeting',
    modifier: 'qualified by',
    constraint: 'bounded by',
    temporal: 'when',
    condition: 'if',
    persona: 'as',
    tone: 'tone:',
    language: 'in',
    reference: 'about',
    negation: 'NOT',
    emotion: 'feeling',
    implicit: 'implicitly needs',
  }[node.category] || node.category;
  return `${verb} ${node.label}`;
}

function pathString(path) {
  return path.map(describeStep).filter(Boolean).join(' → ');
}

function pathWeight(path, edges) {
  if (path.length < 2) return 0;
  let w = 1;
  for (let i = 0; i < path.length - 1; i++) {
    const src = path[i].id;
    const tgt = path[i + 1].id;
    const e = edges.find((edge) => edge.source === src && edge.target === tgt);
    if (!e) return 0;
    w *= e.weight;
  }
  // multiply by terminal node weight × confidence so longer paths with strong endpoints rank higher
  const tail = path[path.length - 1];
  return w * (tail.weight || 0.5) * (tail.confidence || 0.5);
}

function* iterateOutPaths(graph, startNode, depth) {
  if (depth <= 0) { yield [startNode]; return; }
  const downstream = neighbors(graph, startNode.id, 'out');
  if (!downstream.length) { yield [startNode]; return; }
  for (const { node } of downstream) {
    for (const subPath of iterateOutPaths(graph, node, depth - 1)) {
      yield [startNode, ...subPath];
    }
  }
}

function uniqueById(paths) {
  const seen = new Set();
  const out = [];
  for (const p of paths) {
    const key = p.map((n) => n.id).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function buildCircuits(graph, supernodes = []) {
  if (!graph?.nodes?.length) return [];
  const root = graph.nodes.find((n) => n.synthetic) || graph.nodes[0];

  // Enumerate all paths from root up to MAX_PATH_DEPTH.
  const allPaths = [];
  for (const path of iterateOutPaths(graph, root, MAX_PATH_DEPTH)) {
    if (path.length >= 3) allPaths.push(path);
  }

  // Keep only paths that *end* on an action / object / implicit (interesting tails)
  const keepCategories = new Set([
    FEATURE_CATEGORIES.ACTION,
    FEATURE_CATEGORIES.OBJECT,
    FEATURE_CATEGORIES.IMPLICIT,
  ]);
  const filtered = allPaths.filter((p) => {
    const tail = p[p.length - 1];
    return tail && keepCategories.has(tail.category);
  });

  const unique = uniqueById(filtered);

  // Score and rank
  const scored = unique.map((p) => ({
    nodes: p.map((n) => ({ id: n.id, label: n.label, category: n.category })),
    description: pathString(p),
    depth: p.length - 1,
    score: +pathWeight(p, graph.edges).toFixed(4),
  }))
    .filter((c) => c.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CIRCUITS);

  // Tag each circuit with the supernode whose members cover the most steps
  for (const c of scored) {
    const memberIdLookup = c.nodes.map((n) => n.id);
    let best = null;
    let bestOverlap = 0;
    for (const sn of supernodes) {
      const overlap = sn.members.filter((mid) => memberIdLookup.includes(mid)).length;
      if (overlap > bestOverlap) { best = sn; bestOverlap = overlap; }
    }
    c.supernodeId = best?.id || null;
    c.themeLabel = best?.label || null;
  }

  return scored;
}

module.exports = { buildCircuits };

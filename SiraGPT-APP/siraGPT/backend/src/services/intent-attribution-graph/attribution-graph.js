'use strict';

/**
 * Attribution graph — directed graph of features with weighted edges.
 *
 * Inspired by Anthropic's cross-layer transcoder graphs: each node is an
 * interpretable "feature", and each directed edge represents a causal /
 * contributory relationship. Edge weight reflects how strongly the source
 * feature drives the target feature in the user's intent.
 *
 * We don't have model internals here, so we infer edges with deterministic
 * rules: action→object, modifier→action, constraint→{action,object},
 * negation→nearest-feature, condition→action, reference→action,
 * implicit-feature→originating-feature, persona→{tone,output-style}.
 *
 * Edges are also annotated with an "edgeType" so downstream consumers
 * (supernode builder, circuit tracer, prompt formatter) can interpret them.
 */

const { FEATURE_CATEGORIES } = require('./feature-extractor');

const EDGE_TYPES = Object.freeze({
  ACTION_ON: 'action-on',
  MODIFIES: 'modifies',
  CONSTRAINS: 'constrains',
  NEGATES: 'negates',
  GATES: 'gates',
  REFERS_TO: 'refers-to',
  IMPLIES: 'implies',
  STYLES: 'styles',
  TARGETS: 'targets',
});

function spanDistance(a, b) {
  if (!a?.sourceSpan || !b?.sourceSpan) return Number.POSITIVE_INFINITY;
  return Math.abs(a.sourceSpan.start - b.sourceSpan.start);
}

function nearestNode(target, candidates) {
  if (!candidates.length) return null;
  let best = candidates[0];
  let bestDist = spanDistance(target, candidates[0]);
  for (let i = 1; i < candidates.length; i++) {
    const d = spanDistance(target, candidates[i]);
    if (d < bestDist) { best = candidates[i]; bestDist = d; }
  }
  return best;
}

function pushEdge(edges, sourceId, targetId, edgeType, weight, rationale) {
  if (!sourceId || !targetId || sourceId === targetId) return;
  edges.push({
    id: `${sourceId}→${targetId}:${edgeType}`,
    source: sourceId,
    target: targetId,
    edgeType,
    weight: Math.max(0, Math.min(1, weight)),
    rationale,
  });
}

function indexBy(features, category) {
  return features.filter((f) => f.category === category);
}

function buildGraph(extractionResult) {
  const features = Array.isArray(extractionResult?.features) ? extractionResult.features : [];
  const nodes = features.map((f) => ({ ...f, indegree: 0, outdegree: 0 }));
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const edges = [];

  const actions = indexBy(nodes, FEATURE_CATEGORIES.ACTION);
  const objects = indexBy(nodes, FEATURE_CATEGORIES.OBJECT);
  const modifiers = indexBy(nodes, FEATURE_CATEGORIES.MODIFIER);
  const constraints = indexBy(nodes, FEATURE_CATEGORIES.CONSTRAINT);
  const negations = indexBy(nodes, FEATURE_CATEGORIES.NEGATION);
  const conditions = indexBy(nodes, FEATURE_CATEGORIES.CONDITION);
  const references = indexBy(nodes, FEATURE_CATEGORIES.REFERENCE);
  const implicits = indexBy(nodes, FEATURE_CATEGORIES.IMPLICIT);
  const personas = indexBy(nodes, FEATURE_CATEGORIES.PERSONA);
  const tones = indexBy(nodes, FEATURE_CATEGORIES.TONE);
  const langs = indexBy(nodes, FEATURE_CATEGORIES.LANGUAGE);
  const emotions = indexBy(nodes, FEATURE_CATEGORIES.EMOTION);

  // 1. Each action → each plausible object (action-on)
  //    Weight scales with proximity in the text.
  for (const action of actions) {
    if (!objects.length) continue;
    for (const obj of objects) {
      const dist = spanDistance(action, obj);
      const proximityWeight = dist === Number.POSITIVE_INFINITY
        ? 0.3
        : Math.max(0.3, 1 - Math.min(1, dist / 120));
      pushEdge(edges, action.id, obj.id, EDGE_TYPES.ACTION_ON,
        proximityWeight * action.weight * obj.weight,
        `action "${action.label}" acts on object "${obj.label}"`);
    }
  }

  // 2. Modifiers attach to the nearest action (modifies)
  for (const mod of modifiers) {
    const target = nearestNode(mod, actions) || nearestNode(mod, objects);
    if (!target) continue;
    pushEdge(edges, mod.id, target.id, EDGE_TYPES.MODIFIES,
      0.85 * mod.weight,
      `modifier "${mod.label}" qualifies "${target.label}"`);
  }

  // 3. Constraints attach to the nearest action AND nearest object (constrains)
  for (const c of constraints) {
    const action = nearestNode(c, actions);
    const obj = nearestNode(c, objects);
    if (action) pushEdge(edges, c.id, action.id, EDGE_TYPES.CONSTRAINS, 0.8, `constraint "${c.label}" binds "${action.label}"`);
    if (obj && (!action || obj.id !== action.id)) {
      pushEdge(edges, c.id, obj.id, EDGE_TYPES.CONSTRAINS, 0.7, `constraint "${c.label}" binds "${obj.label}"`);
    }
  }

  // 4. Negations flip the nearest feature (any category) within a short window
  for (const neg of negations) {
    const all = nodes.filter((n) => n.id !== neg.id && n.category !== FEATURE_CATEGORIES.IMPLICIT);
    const nearest = nearestNode(neg, all);
    if (!nearest) continue;
    pushEdge(edges, neg.id, nearest.id, EDGE_TYPES.NEGATES, 0.95, `negation flips "${nearest.label}"`);
  }

  // 5. Conditions gate actions (gates)
  for (const cond of conditions) {
    const target = nearestNode(cond, actions);
    if (!target) continue;
    pushEdge(edges, cond.id, target.id, EDGE_TYPES.GATES, 0.7, `condition "${cond.label}" gates "${target.label}"`);
  }

  // 6. References tie back to the nearest action (refers-to)
  for (const ref of references) {
    const target = nearestNode(ref, actions);
    if (!target) continue;
    pushEdge(edges, ref.id, target.id, EDGE_TYPES.REFERS_TO, 0.65, `reference "${ref.label}" anchors "${target.label}"`);
  }

  // 7. Implicit features point back at originating action+object pair
  for (const imp of implicits) {
    // Heuristic mapping: implicit label → likely originating feature label
    const map = {
      'expect-tests': ['create', 'code-artifact'],
      'expect-pre-flight-checks': ['execute', null],
      'expect-regression-test': ['modify', 'defect'],
      'expect-summary': ['analyze', null],
      'fetch-and-summarize-url': [null, null],
      'fast-iteration': [null, null],
      'resume-prior-task': ['continue', null],
    };
    const [actLabel, objLabel] = map[imp.label] || [null, null];
    const linkedActions = actLabel ? actions.filter((a) => a.label === actLabel) : actions;
    const linkedObjects = objLabel ? objects.filter((o) => o.label === objLabel) : [];
    for (const a of linkedActions) pushEdge(edges, a.id, imp.id, EDGE_TYPES.IMPLIES, imp.weight * 0.8, `"${a.label}" implies "${imp.label}"`);
    for (const o of linkedObjects) pushEdge(edges, o.id, imp.id, EDGE_TYPES.IMPLIES, imp.weight * 0.7, `"${o.label}" implies "${imp.label}"`);
  }

  // 8. Persona / tone / language style the output (styles)
  for (const p of personas) {
    for (const a of actions) pushEdge(edges, p.id, a.id, EDGE_TYPES.STYLES, 0.55, `persona "${p.label}" styles "${a.label}"`);
  }
  for (const t of tones) {
    for (const a of actions) pushEdge(edges, t.id, a.id, EDGE_TYPES.STYLES, 0.5, `tone "${t.label}" styles "${a.label}"`);
  }
  for (const lg of langs) {
    for (const a of actions) pushEdge(edges, lg.id, a.id, EDGE_TYPES.STYLES, 0.6, `language "${lg.label}" styles "${a.label}"`);
  }

  // 9. Emotions amplify the urgency of nearest action (modifies, soft)
  for (const e of emotions) {
    const target = nearestNode(e, actions);
    if (!target) continue;
    pushEdge(edges, e.id, target.id, EDGE_TYPES.MODIFIES, 0.55, `emotion "${e.label}" colors "${target.label}"`);
  }

  // 10. Synthetic ROOT → top-N actions (targets) so graph is rooted.
  if (actions.length) {
    const root = {
      id: 'root',
      category: 'root',
      label: 'user-goal',
      sourceSpan: null,
      weight: 1,
      confidence: 1,
      evidence: 'synthetic root representing the overall user intent',
      indegree: 0,
      outdegree: 0,
      synthetic: true,
    };
    nodes.unshift(root);
    nodesById.set(root.id, root);
    for (const a of actions) pushEdge(edges, root.id, a.id, EDGE_TYPES.TARGETS, a.weight * a.confidence, `root targets "${a.label}"`);
  }

  // Compute degrees
  for (const e of edges) {
    const src = nodesById.get(e.source);
    const tgt = nodesById.get(e.target);
    if (src) src.outdegree += 1;
    if (tgt) tgt.indegree += 1;
  }

  return {
    nodes,
    edges,
    nodesById,
    rootId: nodes.find((n) => n.synthetic)?.id || null,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      avgOutdegree: nodes.length ? +(edges.length / nodes.length).toFixed(2) : 0,
    },
  };
}

function topNodesByImportance(graph, limit = 10) {
  if (!graph?.nodes) return [];
  return [...graph.nodes]
    .filter((n) => !n.synthetic)
    .map((n) => ({
      ...n,
      importance: +(n.weight * n.confidence * (1 + n.indegree * 0.2 + n.outdegree * 0.15)).toFixed(4),
    }))
    .sort((a, b) => b.importance - a.importance)
    .slice(0, limit);
}

function neighbors(graph, nodeId, direction = 'out') {
  if (!graph?.edges) return [];
  const dir = direction === 'in' ? 'target' : 'source';
  const other = direction === 'in' ? 'source' : 'target';
  return graph.edges
    .filter((e) => e[dir] === nodeId)
    .map((e) => ({ edge: e, node: graph.nodesById.get(e[other]) }))
    .filter((x) => x.node);
}

module.exports = {
  EDGE_TYPES,
  buildGraph,
  topNodesByImportance,
  neighbors,
};

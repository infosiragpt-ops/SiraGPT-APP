/**
 * graphrag/community-detection — partition an entity graph into
 * hierarchical communities.
 *
 * Edge et al. 2024 (GraphRAG) §3 Methods: after extracting entities
 * and relationships from documents, "we partition the graph into a
 * hierarchy of communities of closely related entities ... using a
 * Leiden algorithm". Each community becomes a unit for LLM summary
 * generation; community summaries then answer global sensemaking
 * queries via map-reduce.
 *
 * Leiden is a state-of-the-art algorithm for modular community
 * detection but it requires a C++ binary or a native library. To
 * keep this pure-JS + zero-deps, we implement LABEL PROPAGATION —
 * a fast, well-studied alternative that produces comparable
 * (though not identical) partitions on typical graphs. When a
 * caller needs Leiden-exact output they can swap in a graph library;
 * the community shape we emit is library-agnostic.
 *
 * Algorithm (async label propagation):
 *   1. Each node starts in its own community.
 *   2. Repeatedly visit nodes in random order; each node adopts the
 *      MOST COMMON label among its neighbours. Ties broken randomly.
 *   3. Stop when no labels change OR after maxIters (default 20).
 *
 * Plus HIERARCHY: after a first pass, we contract each community to
 * a super-node and run label propagation again on the contracted
 * graph. This gives a 2-level hierarchy:
 *   - leaf communities (small, topically tight)
 *   - super-communities (groups of leaf communities)
 *
 * Paper uses entity-graph edges from triple extraction. We accept
 * any undirected graph as `{ nodes: [...], edges: [{a, b, weight?}] }`.
 * The existing triple-graph.js can build this: entities are nodes,
 * shared head/tail relationships between triples are edges.
 */

const DEFAULT_MAX_ITERS = 20;

function makeRng(seed) {
  let state = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildAdjacency(nodes, edges) {
  const adj = new Map();
  for (const n of nodes) adj.set(n, []);
  for (const { a, b, weight = 1 } of edges) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push({ n: b, w: weight });
    adj.get(b).push({ n: a, w: weight });
  }
  return adj;
}

/**
 * One pass of async label propagation. Returns a map nodeId → label
 * and whether any label changed on the last iteration.
 */
function labelPropagate({ nodes, adj, maxIters, rng, initialLabels }) {
  const labels = new Map();
  if (initialLabels) {
    for (const n of nodes) labels.set(n, initialLabels.get(n) ?? n);
  } else {
    for (const n of nodes) labels.set(n, n);
  }

  for (let iter = 0; iter < maxIters; iter++) {
    let changed = false;
    const order = shuffle(nodes, rng);
    for (const node of order) {
      const neighbours = adj.get(node) || [];
      if (neighbours.length === 0) continue;

      // Sum edge weights per neighbour-label.
      const counts = new Map();
      for (const { n: neighbour, w } of neighbours) {
        const lbl = labels.get(neighbour);
        counts.set(lbl, (counts.get(lbl) || 0) + w);
      }
      // Pick the label with max count; random tie-break.
      let best = null;
      let bestCount = -Infinity;
      const candidates = [];
      for (const [lbl, cnt] of counts) {
        if (cnt > bestCount) {
          bestCount = cnt; best = lbl; candidates.length = 0; candidates.push(lbl);
        } else if (cnt === bestCount) {
          candidates.push(lbl);
        }
      }
      if (candidates.length > 1) best = candidates[Math.floor(rng() * candidates.length)];
      if (best !== labels.get(node)) {
        labels.set(node, best);
        changed = true;
      }
    }
    if (!changed) return { labels, iterations: iter + 1, converged: true };
  }
  return { labels, iterations: maxIters, converged: false };
}

/**
 * Bin nodes by their label → community map.
 */
function labelsToCommunities(labels) {
  const byLabel = new Map();
  for (const [node, lbl] of labels) {
    if (!byLabel.has(lbl)) byLabel.set(lbl, []);
    byLabel.get(lbl).push(node);
  }
  // Re-key with sequential community ids for stable output.
  const communities = [];
  let id = 0;
  for (const [, members] of byLabel) {
    communities.push({ id: `c${id++}`, members });
  }
  // Sort by size descending so biggest communities get lowest id — easier
  // for humans to scan a top-N list.
  communities.sort((a, b) => b.members.length - a.members.length);
  communities.forEach((c, i) => { c.id = `c${i}`; });
  return communities;
}

/**
 * Run a single level of community detection.
 *
 * @param {object} args
 * @param {Array<string>} args.nodes
 * @param {Array<{a, b, weight?}>} args.edges
 * @param {number} [args.maxIters=20]
 * @param {number} [args.seed=42]
 *
 * @returns {{ communities: [{id, members[]}], iterations, converged }}
 */
function detect({ nodes, edges, maxIters = DEFAULT_MAX_ITERS, seed = 42 }) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { communities: [], iterations: 0, converged: true };
  }
  const adj = buildAdjacency(nodes, edges || []);
  const rng = makeRng(seed);
  const { labels, iterations, converged } = labelPropagate({ nodes, adj, maxIters, rng });
  return {
    communities: labelsToCommunities(labels),
    iterations,
    converged,
  };
}

/**
 * Hierarchical detection: one leaf-level pass, then contract and run
 * again. Returns both levels so callers can summarise at each.
 *
 * @returns {{
 *   leaf: { communities, iterations, converged },
 *   super: { communities, iterations, converged } | null,
 *   assignments: { [nodeId]: { leaf, super } },
 * }}
 */
function detectHierarchical({ nodes, edges, maxIters = DEFAULT_MAX_ITERS, seed = 42 }) {
  const leaf = detect({ nodes, edges, maxIters, seed });
  if (leaf.communities.length <= 1) {
    const assignments = {};
    for (const n of nodes) assignments[n] = { leaf: leaf.communities[0]?.id || null, super: null };
    return { leaf, super: null, assignments };
  }

  // Build super-graph: one super-node per leaf community.
  const nodeToLeaf = new Map();
  for (const c of leaf.communities) for (const n of c.members) nodeToLeaf.set(n, c.id);

  const superNodes = leaf.communities.map(c => c.id);
  const edgeWeights = new Map(); // `cA|cB` → summed weight
  for (const { a, b, weight = 1 } of (edges || [])) {
    const ca = nodeToLeaf.get(a);
    const cb = nodeToLeaf.get(b);
    if (!ca || !cb || ca === cb) continue; // only INTER-community edges
    const [lo, hi] = ca < cb ? [ca, cb] : [cb, ca];
    const key = `${lo}|${hi}`;
    edgeWeights.set(key, (edgeWeights.get(key) || 0) + weight);
  }
  const superEdges = [];
  for (const [key, w] of edgeWeights) {
    const [a, b] = key.split('|');
    superEdges.push({ a, b, weight: w });
  }

  // Re-seed so super-level is deterministic too.
  const sup = detect({ nodes: superNodes, edges: superEdges, maxIters, seed: seed + 1 });

  // Super community per leaf community.
  const leafToSuper = new Map();
  for (const sc of sup.communities) for (const leafId of sc.members) leafToSuper.set(leafId, sc.id);

  const assignments = {};
  for (const n of nodes) {
    const leafId = nodeToLeaf.get(n) || null;
    assignments[n] = {
      leaf: leafId,
      super: leafId ? leafToSuper.get(leafId) || null : null,
    };
  }
  return { leaf, super: sup, assignments };
}

module.exports = {
  detect,
  detectHierarchical,
  buildAdjacency,
  labelPropagate,
  labelsToCommunities,
  makeRng,
  DEFAULT_MAX_ITERS,
};

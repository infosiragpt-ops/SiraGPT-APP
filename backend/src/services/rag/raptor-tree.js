/**
 * raptor-tree — RAPTOR (Sarthi et al., arXiv:2401.18059),
 * "Recursive Abstractive Processing for Tree-Organized Retrieval",
 * cited in Gao et al. §IV.B (Structural Indexing).
 *
 * Idea: flat chunk retrieval forces a trade-off between recall of
 * specific details (small chunks) and availability of high-level
 * context (big chunks). RAPTOR sidesteps it: build a TREE where
 *
 *   L0 = original leaf chunks
 *   L1 = clusters of L0 chunks, each summarised by the LLM
 *   L2 = clusters of L1 summaries, each summarised again
 *   ...until a single root summary.
 *
 * Retrieval modes:
 *   - "tree-traversal" walks top-down: retrieve k at root, then
 *      descend into the children of the best summaries, gathering
 *      leaves. Coarse-to-fine matching.
 *   - "flat" adds every node (summaries + leaves) into one big
 *      retrieval pool. Simpler, often wins on short-context questions.
 *
 * Clustering is intentionally lightweight here: we use a simple
 * cosine-similarity agglomerative clusterer with a fixed size target,
 * NOT the GMM/UMAP combo from the paper. The paper explicitly says
 * "any reasonable clustering" works; the tree structure itself is the
 * contribution. Zero-dependency = easier to ship + test.
 *
 * This module BUILDS the tree offline — embeddings + summaries in one
 * pass — and exposes a traversal function. Persistence is the caller's
 * problem (the tree serialises to JSON trivially).
 */

const crypto = require('crypto');

function stableId(prefix, text) {
  const h = crypto.createHash('sha1').update(`${prefix}|${text.slice(0, 200)}`).digest('hex');
  return `${prefix}-${h.slice(0, 12)}`;
}

function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

const SUMMARY_SYSTEM = `You are a senior editor writing a FOCUSED SUMMARY of a cluster of related passages.

Output format — STRICT JSON:
{ "summary": "<150-250 word summary>", "topic": "<one-line topic label>" }

Rules:
- The summary must PRESERVE specific facts, numbers, and entity names from the passages. Do not paraphrase into generalities.
- Capture the topic the passages share, NOT a lowest-common-denominator description.
- If the passages contradict, surface the contradiction ("one passage says X; another says Y").
- Topic is a short label suitable as a tree node caption (e.g. "Q2 2024 revenue breakdown").`;

function parseJSON(text) {
  if (typeof text !== 'string') return {};
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return {}; }
}

// ─── clustering (simple greedy cosine agglomeration) ────────────────────

/**
 * Group items by pairwise cosine similarity into clusters of target size.
 * Not as good as UMAP+GMM but deterministic, zero-dep, and adequate for
 * our tree-building purposes.
 *
 * Algorithm:
 *   1. Compute centroid = mean of all embeddings.
 *   2. Sort items by similarity to centroid (descending).
 *   3. Greedy: pick the most-central unassigned item as seed; gather
 *      its nearest (targetClusterSize - 1) unassigned neighbours by
 *      pairwise similarity. Repeat until all assigned.
 */
function clusterByCosine(items, targetClusterSize = 4) {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (items.length <= targetClusterSize) return [items];

  const dim = items[0].embedding.length;
  const centroid = new Array(dim).fill(0);
  for (const it of items) for (let i = 0; i < dim; i++) centroid[i] += it.embedding[i];
  for (let i = 0; i < dim; i++) centroid[i] /= items.length;

  const withSim = items.map(it => ({ item: it, simToCentroid: cosineSim(it.embedding, centroid) }));
  withSim.sort((a, b) => b.simToCentroid - a.simToCentroid);

  const assigned = new Set();
  const clusters = [];
  for (const seed of withSim) {
    if (assigned.has(seed.item.id)) continue;
    const cluster = [seed.item];
    assigned.add(seed.item.id);
    const candidates = withSim
      .filter(x => !assigned.has(x.item.id))
      .map(x => ({ item: x.item, sim: cosineSim(x.item.embedding, seed.item.embedding) }))
      .sort((a, b) => b.sim - a.sim);
    for (const c of candidates) {
      if (cluster.length >= targetClusterSize) break;
      cluster.push(c.item);
      assigned.add(c.item.id);
    }
    clusters.push(cluster);
  }
  return clusters;
}

// ─── tree build ──────────────────────────────────────────────────────────

/**
 * Build a RAPTOR tree.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {(texts:string[]) => Promise<number[][]>} args.embed
 * @param {Array<{id?:string, source?:string, text:string, metadata?:object}>} args.leaves
 * @param {number} [args.clusterSize=4]
 * @param {number} [args.maxLevels=4]
 * @param {string} [args.model='gpt-4o-mini']
 *
 * @returns {Promise<{
 *   nodes: Array<{id, level, text, summary?:string, topic?:string, children:string[], embedding:number[]}>,
 *   roots: string[],
 *   levels: number,
 * }>}
 */
async function buildTree({
  openai, embed, leaves,
  clusterSize = 4, maxLevels = 4,
  model = 'gpt-4o-mini',
}) {
  if (typeof embed !== 'function') throw new Error('raptor: embed(fn) required');
  if (!Array.isArray(leaves) || leaves.length === 0) {
    return { nodes: [], roots: [], levels: 0 };
  }
  if (!openai) throw new Error('raptor: openai required for cluster summarisation');

  // L0: normalise leaves; embed their text.
  const leafTexts = leaves.map(l => String(l.text || ''));
  const leafEmbeds = await embed(leafTexts);
  if (!Array.isArray(leafEmbeds) || leafEmbeds.length !== leaves.length) {
    throw new Error('raptor: embed(fn) must return one vector per leaf');
  }

  const nodes = [];
  const byId = new Map();

  const leafNodes = leaves.map((l, i) => {
    const id = l.id || stableId('leaf', leafTexts[i]);
    const node = {
      id,
      level: 0,
      text: leafTexts[i],
      children: [],
      embedding: leafEmbeds[i],
      source: l.source,
      metadata: { ...(l.metadata || {}), role: 'leaf' },
    };
    byId.set(id, node);
    nodes.push(node);
    return node;
  });

  let current = leafNodes;
  let level = 0;
  // Early exit: if there are fewer leaves than cluster size, there's
  // nothing to summarise — just leave the level-0 nodes as roots.
  if (leafNodes.length <= clusterSize) {
    return { nodes, roots: leafNodes.map(n => n.id), levels: 1 };
  }
  while (current.length > 1 && level < maxLevels) {
    level++;
    const clusters = clusterByCosine(current, clusterSize);
    // If nothing clusters (everyone is alone), stop — further levels
    // would just pass-through.
    if (clusters.every(c => c.length === 1)) break;

    const levelNodes = [];
    for (const cluster of clusters) {
      if (cluster.length === 1) {
        levelNodes.push(cluster[0]);
        continue;
      }
      // Summarise.
      const userMsg = cluster
        .map((c, i) => `[${i + 1}] ${c.text.slice(0, 800)}`)
        .join('\n\n');
      let summary = '';
      let topic = '';
      try {
        const resp = await openai.chat.completions.create({
          model, temperature: 0, max_tokens: 400,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SUMMARY_SYSTEM },
            { role: 'user',   content: userMsg },
          ],
        });
        const parsed = parseJSON(resp.choices?.[0]?.message?.content || '{}');
        summary = typeof parsed.summary === 'string' ? parsed.summary : '';
        topic = typeof parsed.topic === 'string' ? parsed.topic : '';
      } catch (err) {
        // Fail-soft: use the concatenation as a degraded summary so
        // the tree still builds.
        summary = cluster.map(c => c.text.slice(0, 200)).join(' … ');
        topic = '(summary unavailable)';
      }
      // Embed the summary.
      const [summaryEmbedding] = await embed([summary]);
      const summaryNode = {
        id: stableId(`l${level}`, summary),
        level,
        text: summary,
        summary,
        topic,
        children: cluster.map(c => c.id),
        embedding: summaryEmbedding || new Array(current[0].embedding.length).fill(0),
        metadata: { role: 'summary', childCount: cluster.length, topic },
      };
      byId.set(summaryNode.id, summaryNode);
      nodes.push(summaryNode);
      levelNodes.push(summaryNode);
    }
    current = levelNodes;
  }

  return {
    nodes,
    roots: current.map(n => n.id),
    levels: level + 1,
  };
}

// ─── retrieval (tree + flat modes) ───────────────────────────────────────

function topKBy(items, k, scoreFn) {
  const scored = items.map(it => ({ item: it, score: scoreFn(it) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/**
 * Flat RAPTOR retrieval — score every node in the tree, return top-K.
 * Works as a strict superset of chunk retrieval because summaries can
 * hit on abstract queries that leaves would miss.
 */
function retrieveFlat({ tree, queryEmbedding, k = 8, levels = null }) {
  if (!tree || !Array.isArray(tree.nodes)) return [];
  const pool = levels
    ? tree.nodes.filter(n => levels.includes(n.level))
    : tree.nodes;
  return topKBy(pool, k, n => cosineSim(n.embedding, queryEmbedding))
    .map(x => ({ ...x.item, score: x.score }));
}

/**
 * Tree-traversal retrieval — walk top-down, k at each level.
 * Coarse-to-fine.
 */
function retrieveTreeTraversal({ tree, queryEmbedding, kPerLevel = 2, returnLeaves = true }) {
  if (!tree || !Array.isArray(tree.nodes) || tree.roots.length === 0) return [];
  const byId = new Map(tree.nodes.map(n => [n.id, n]));
  let frontier = tree.roots.map(id => byId.get(id)).filter(Boolean);
  const visited = new Set();
  const leaves = [];

  while (frontier.length > 0) {
    const scored = topKBy(frontier, kPerLevel, n => cosineSim(n.embedding, queryEmbedding));
    const next = [];
    for (const { item, score } of scored) {
      if (visited.has(item.id)) continue;
      visited.add(item.id);
      if (item.level === 0) {
        if (returnLeaves) leaves.push({ ...item, score });
      } else {
        for (const childId of item.children) {
          const child = byId.get(childId);
          if (child && !visited.has(child.id)) next.push(child);
        }
        if (!returnLeaves) leaves.push({ ...item, score });
      }
    }
    frontier = next;
  }
  leaves.sort((a, b) => b.score - a.score);
  return leaves;
}

module.exports = {
  buildTree,
  clusterByCosine,
  retrieveFlat,
  retrieveTreeTraversal,
  cosineSim,
  SUMMARY_SYSTEM,
};

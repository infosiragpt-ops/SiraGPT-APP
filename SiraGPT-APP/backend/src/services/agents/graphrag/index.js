/**
 * graphrag — full pipeline orchestrator.
 *
 * Composes the pieces built in this round into the end-to-end
 * GraphRAG system described in Edge et al. 2024 §3:
 *
 *   OFFLINE (indexing):
 *     1. Source documents → chunks + entities + relationships
 *        (leverages existing rag-service.ingest + triple-extractor)
 *     2. Entity graph → hierarchical communities
 *        (community-detection.detectHierarchical)
 *     3. Community summaries (community-summaries.summariseAll)
 *     4. Store by (userId, collection)
 *
 *   ONLINE (query):
 *     5. For a sensemaking query, map-reduce over community summaries
 *        (map-reduce-qa.answer).
 *
 * This module exposes the high-level build/query primitives; the
 * individual modules can still be used standalone when callers want
 * finer control.
 *
 * Storage: the index (hierarchy + summaries) is stored in-memory per
 * (userId, collection), same pattern as the rest of the stack. When
 * USE_PG_STORE=1 the user can persist via the existing rag-store
 * migration; the index objects are plain JSON so serialisation is
 * trivial.
 */

const communityDetection = require('./community-detection');
const communitySummaries = require('./community-summaries');
const mapReduceQA = require('./map-reduce-qa');

// In-memory index: storeKey → { hierarchy, summaries, builtAt }
const store = new Map();

function storeKey(userId, collection) {
  return `${userId || 'anon'}:${collection || 'default'}`;
}

/**
 * Build a GraphRAG index over a user's collection.
 *
 * The caller supplies the graph — nodes are entity ids, edges connect
 * entities that share a triple. Typically this comes from our
 * triple-graph.js internals, but any graph with the right shape works.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.userId
 * @param {string} args.collection
 * @param {Array<string>} args.entities
 * @param {Array<{a, b, weight?}>} args.edges
 * @param {function} args.getRelations   — (entityId) => triples[]
 * @param {number} [args.seed]
 * @param {string} [args.model]
 *
 * @returns {Promise<{ leaf, super, summaries, stats }>}
 */
async function buildIndex({ openai, userId, collection, entities, edges, getRelations, seed = 42, model }) {
  if (!openai) throw new Error('graphrag.buildIndex: openai required');
  if (!Array.isArray(entities) || entities.length === 0) {
    return { leaf: [], super: [], summaries: { leaf: [], super: [], byId: {} }, stats: { n_entities: 0, n_edges: 0 } };
  }

  // 1. Community detection
  const hierarchy = communityDetection.detectHierarchical({
    nodes: entities, edges: edges || [], seed,
  });

  // 2. LLM summaries over the hierarchy
  const summaries = await communitySummaries.summariseAll({
    openai, hierarchy, getRelations, model,
  });

  const index = {
    hierarchy,
    summaries,
    builtAt: Date.now(),
    stats: {
      n_entities: entities.length,
      n_edges: (edges || []).length,
      n_leaf_communities: hierarchy.leaf.communities.length,
      n_super_communities: hierarchy.super?.communities?.length || 0,
      n_summaries: summaries.leaf.length + summaries.super.length,
    },
  };
  store.set(storeKey(userId, collection), index);
  return index;
}

/**
 * Retrieve the previously-built index.
 */
function getIndex(userId, collection) {
  return store.get(storeKey(userId, collection)) || null;
}

function clearIndex(userId, collection) {
  return store.delete(storeKey(userId, collection));
}

/**
 * Answer a sensemaking query against the built index.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.userId
 * @param {string} args.collection
 * @param {string} args.query
 * @param {'leaf'|'super'} [args.level='leaf']
 * @param {number} [args.minHelpfulness=40]
 * @param {number} [args.mapMax=20]
 * @param {string} [args.model]
 *
 * @returns {Promise<answer object>} — see map-reduce-qa.answer
 */
async function query({ openai, userId, collection, query: q, level = 'leaf', minHelpfulness, mapMax, model }) {
  const idx = getIndex(userId, collection);
  if (!idx) {
    return {
      query: q,
      answer: '(no GraphRAG index built — call buildIndex first)',
      themes: [],
      contributing_communities: [],
      partials: [],
      stats: { n_communities: 0, n_helpful: 0, avg_helpfulness: 0, reduce_succeeded: false, index_missing: true },
    };
  }
  const summaries = level === 'super' && idx.summaries.super.length > 0
    ? idx.summaries.super
    : idx.summaries.leaf;

  return mapReduceQA.answer({
    openai, query: q, summaries,
    minHelpfulness, mapMax, model,
  });
}

/**
 * Convenience: one-shot build-then-query, for callers who don't want
 * to persist the index. Useful for ad-hoc sensemaking queries over a
 * small corpus the user just uploaded.
 */
async function buildAndQuery({ openai, entities, edges, getRelations, query: q, level, seed, minHelpfulness, mapMax, model }) {
  // Build without storing (temp index).
  const hierarchy = communityDetection.detectHierarchical({
    nodes: entities, edges: edges || [], seed,
  });
  const summaries = await communitySummaries.summariseAll({
    openai, hierarchy, getRelations, model,
  });
  const pool = level === 'super' && summaries.super.length > 0
    ? summaries.super
    : summaries.leaf;
  return mapReduceQA.answer({
    openai, query: q, summaries: pool,
    minHelpfulness, mapMax, model,
  });
}

/**
 * Bridge to the existing triple-graph.js index. Pulls entities and
 * edges from there so callers don't have to rebuild.
 *
 * Edges connect two entities when they co-occur in at least one
 * triple (i.e. the triple's subject AND object are both in the graph's
 * entity set). Weight = number of co-occurring triples.
 */
function buildGraphFromTripleStore(tripleGraph, userId, collection) {
  const stats = tripleGraph.stats(userId, collection);
  if (stats.triples === 0) return { entities: [], edges: [] };

  // Iterate by entity: triple-graph's byEntity is private, but we can
  // reconstruct via getNeighbours if we first gather entity names from
  // the list of triples. However, the cleanest way is to accept a
  // userId/collection and walk every source. For simplicity here we
  // use a dump helper if available.
  if (typeof tripleGraph._dumpEntities !== 'function') {
    return { entities: [], edges: [], _warning: 'triple-graph does not expose _dumpEntities; caller must build graph manually' };
  }
  const { entities, edges } = tripleGraph._dumpEntities(userId, collection);
  return { entities, edges };
}

module.exports = {
  buildIndex,
  getIndex,
  clearIndex,
  query,
  buildAndQuery,
  buildGraphFromTripleStore,
  // re-exports for direct use
  communityDetection,
  communitySummaries,
  mapReduceQA,
};

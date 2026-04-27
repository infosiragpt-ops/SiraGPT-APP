/**
 * rag_retrieve — hybrid retrieval over the user's RAG collection.
 *
 * Delegates to backend/src/services/rag-service so any scoring/ranking
 * improvements there automatically apply to the agent. The skill is a
 * thin adapter, not a re-implementation.
 *
 * ctx requirements:
 *   ctx.userId     — needed to scope the collection to the requester.
 *   ctx.collection — collection name; falls back to "default".
 */

const rag = require('../../services/rag-service');

const DEFAULT_K = 4;
const MAX_K = 10;

async function execute({ query, k = DEFAULT_K }, ctx) {
  if (!ctx?.userId) throw new Error('rag_retrieve: ctx.userId is required');
  if (!query || typeof query !== 'string') return { hits: [], error: 'missing query' };
  const take = Math.max(1, Math.min(Number(k) || DEFAULT_K, MAX_K));

  const result = await rag.retrieveWithTrace(ctx.userId, ctx.collection || 'default', query, take, {
    useExpansion: true,
    useHybrid: true,
    useMMR: true,
    mmrLambda: 0.72,
  });
  return result;
}

module.exports = { execute };

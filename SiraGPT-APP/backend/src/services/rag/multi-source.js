/**
 * multi-source — parallel retrieval across multiple sources with
 * weighted reciprocal-rank fusion, from Gao et al. §IV.A (hybrid
 * retrieval sources).
 *
 * Most real systems retrieve from more than one place: a private
 * vector store, a graph-RAG index, a web search API, a legacy
 * full-text search. Each has different score scales and different
 * quality on different queries. Naive union isn't enough — a top-1
 * web result shouldn't be buried under a low-confidence graph hit.
 *
 * This module fuses N named source pools with:
 *   - per-source WEIGHTS (user-tunable; default 1.0 each)
 *   - reciprocal-rank fusion: score(doc) = sum over sources of
 *     weight_s / (rrfK + rank_s(doc))
 *   - deduplication via (source, first-80-chars) key — same content
 *     from two sources is a single entry with combined scores
 *
 * The caller provides the retrievers as async functions; we fan out
 * in parallel, track per-source latency + size, and return the fused
 * top-K plus a debug trace per source.
 */

const DEFAULT_RRF_K = 60;

function dedupeKey(p) {
  return `${p.source || ''}|${(p.text || '').slice(0, 80)}`;
}

/**
 * Fuse named source results using weighted RRF.
 *
 * @param {object} args
 * @param {Record<string, Array>} args.perSource   — { sourceName: [passages] }
 * @param {Record<string, number>} [args.weights]  — { sourceName: weight }; default 1 each
 * @param {number} [args.k=10]
 * @param {number} [args.rrfK=60]
 * @returns {{ fused: Array, contributions: Record<string, number> }}
 */
function fuseWeighted({ perSource, weights = {}, k = 10, rrfK = DEFAULT_RRF_K }) {
  if (!perSource || typeof perSource !== 'object') return { fused: [], contributions: {} };
  const acc = new Map();
  const contributions = {};
  for (const [source, results] of Object.entries(perSource)) {
    contributions[source] = Array.isArray(results) ? results.length : 0;
    if (!Array.isArray(results)) continue;
    const w = typeof weights[source] === 'number' ? weights[source] : 1.0;
    for (let i = 0; i < results.length; i++) {
      const p = results[i];
      const key = dedupeKey(p);
      const score = w / (rrfK + (i + 1));
      const prev = acc.get(key);
      if (prev) {
        prev.score += score;
        prev.sources.add(source);
      } else {
        acc.set(key, {
          ...p,
          score,
          sources: new Set([source]),
        });
      }
    }
  }
  const fused = [...acc.values()]
    .map(x => ({ ...x, sources: [...x.sources] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return { fused, contributions };
}

/**
 * Run N retrievers concurrently, fuse their outputs.
 *
 * @param {object} args
 * @param {string} args.query
 * @param {Record<string, (query:string, k:number) => Promise<Array>>} args.retrievers
 * @param {Record<string, number>} [args.weights]
 * @param {number} [args.k=10]        — final top-K
 * @param {number} [args.kPerSource=10]
 * @param {number} [args.rrfK=60]
 * @param {number} [args.timeoutMs]   — per-source soft timeout; slow sources get empty results
 * @returns {Promise<{
 *   fused: Array,
 *   contributions: Record<string, {count:number, durationMs:number, error?:string}>,
 *   weights: Record<string, number>,
 * }>}
 */
async function fanOutAndFuse({
  query,
  retrievers,
  weights = {},
  k = 10,
  kPerSource = 10,
  rrfK = DEFAULT_RRF_K,
  timeoutMs = 10_000,
}) {
  if (!retrievers || typeof retrievers !== 'object' || Object.keys(retrievers).length === 0) {
    return { fused: [], contributions: {}, weights: {} };
  }

  const entries = Object.entries(retrievers);
  const results = await Promise.all(entries.map(async ([source, fn]) => {
    const start = Date.now();
    try {
      const withTimeout = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
        Promise.resolve(fn(query, kPerSource))
          .then(v => { clearTimeout(timer); resolve(v); })
          .catch(e => { clearTimeout(timer); reject(e); });
      });
      const out = await withTimeout;
      return {
        source,
        results: Array.isArray(out) ? out : [],
        durationMs: Date.now() - start,
        error: null,
      };
    } catch (err) {
      return {
        source,
        results: [],
        durationMs: Date.now() - start,
        error: err.message || String(err),
      };
    }
  }));

  const perSource = {};
  const contributions = {};
  const resolvedWeights = {};
  for (const r of results) {
    perSource[r.source] = r.results;
    contributions[r.source] = {
      count: r.results.length,
      durationMs: r.durationMs,
      ...(r.error ? { error: r.error } : {}),
    };
    resolvedWeights[r.source] = typeof weights[r.source] === 'number' ? weights[r.source] : 1.0;
  }
  const { fused } = fuseWeighted({ perSource, weights: resolvedWeights, k, rrfK });
  return { fused, contributions, weights: resolvedWeights };
}

module.exports = {
  fuseWeighted,
  fanOutAndFuse,
  DEFAULT_RRF_K,
};

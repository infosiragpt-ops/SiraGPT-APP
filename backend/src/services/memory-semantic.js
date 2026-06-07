'use strict';

/**
 * memory-semantic — semantic (meaning-based) recall re-ranking.
 *
 * The lexical recall in active-memory only matches shared words ("prefiero",
 * "react"). This layer understands MEANING: it embeds the user's message and
 * the candidate facts with the real embedding model and blends cosine
 * similarity into the score, so "¿qué uso para programar?" can surface
 * "El usuario prefiere TypeScript" even with zero shared keywords.
 *
 * Design:
 *  - On-the-fly: embeds [query, ...candidateFacts] in ONE batch call at recall
 *    time. Nothing is persisted, so there's no vector bloat in the memory store
 *    and no embedding-dimension drift to manage.
 *  - Fail-open: when no embedding key is configured (rag.embed throws) or any
 *    error occurs, it returns the candidates unchanged (lexical order). So CI
 *    and no-key deployments behave exactly as before — no regression, no flake.
 *  - Pure & injectable: `embed` and `cosineFn` are parameters, so semantic
 *    ranking is unit-testable deterministically without an API key.
 */

const ragService = require('./rag-service');
const { cosine: cosineDefault } = require('./rag/vector-ops');

const DEFAULT_WEIGHT = Number(process.env.SIRAGPT_MEMORY_SEMANTIC_WEIGHT || 0.5);

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

/**
 * Re-rank lexical candidates by blending in semantic cosine similarity.
 * @param {string} query the user's message
 * @param {Array} items candidate memory entries (each with .fact and optional .score)
 * @param {object} [opts]
 * @param {function} [opts.embed] async (texts:string[]) => vectors[] (Float32Array|number[])
 * @param {function} [opts.cosineFn] (a,b) => number in [-1,1]
 * @param {number}   [opts.weight] blend weight for semantic vs lexical (0..1)
 * @param {number}   [opts.limit] cap the returned list
 * @returns {Promise<Array>} items (re-ranked when semantic succeeds, each may gain a `semantic` field)
 */
async function semanticRerank(query, items, opts = {}) {
  const list = Array.isArray(items) ? items.filter((m) => m && typeof m.fact === 'string') : [];
  if (list.length === 0) return list;
  const q = String(query || '').trim();
  if (!q) return typeof opts.limit === 'number' ? list.slice(0, opts.limit) : list;

  const embed = typeof opts.embed === 'function' ? opts.embed : ragService.embed;
  const cosineFn = typeof opts.cosineFn === 'function' ? opts.cosineFn : cosineDefault;
  const weight = clamp01(typeof opts.weight === 'number' ? opts.weight : DEFAULT_WEIGHT);

  let vecs;
  try {
    vecs = await embed([q, ...list.map((m) => m.fact)]);
  } catch {
    // No embedding key / transient error → keep lexical order untouched.
    return typeof opts.limit === 'number' ? list.slice(0, opts.limit) : list;
  }
  if (!Array.isArray(vecs) || vecs.length !== list.length + 1 || !vecs[0]) {
    return typeof opts.limit === 'number' ? list.slice(0, opts.limit) : list;
  }

  const qv = vecs[0];
  const ranked = list.map((item, i) => {
    let sim = null;
    const fv = vecs[i + 1];
    if (fv) {
      try {
        const c = cosineFn(qv, fv);
        if (Number.isFinite(c)) sim = c;
      } catch { sim = null; }
    }
    const base = typeof item.score === 'number' ? item.score : 0;
    // cosine ∈ [-1,1] → [0,1]; blend with the lexical score.
    const blended = sim !== null ? base * (1 - weight) + clamp01((sim + 1) / 2) * weight : base;
    return {
      ...item,
      semantic: sim !== null ? Number(sim.toFixed(3)) : null,
      score: Number(blended.toFixed(4)),
    };
  });

  ranked.sort((a, b) => b.score - a.score);
  return typeof opts.limit === 'number' ? ranked.slice(0, opts.limit) : ranked;
}

/** True when a real embedding backend is configured (best-effort probe). */
function isSemanticAvailable() {
  try {
    return Boolean(process.env.OPENAI_API_KEY && String(process.env.OPENAI_API_KEY).trim());
  } catch {
    return false;
  }
}

module.exports = { semanticRerank, isSemanticAvailable, DEFAULT_WEIGHT };

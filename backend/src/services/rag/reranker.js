"use strict";

/**
 * reranker — cross-encoder reranking via @xenova/transformers.
 *
 * Bi-encoder (sentence-transformers / OpenAI ada) embedding retrieval
 * trades precision for speed: query and chunk are encoded
 * independently, so the model never sees them together. A cross-
 * encoder takes [query, chunk] as a single sequence, attends across
 * both, and scores relevance. Much slower per pair, but precision
 * is dramatically higher — the standard recipe is "top-100 by
 * cosine, then cross-encoder rerank to top-10".
 *
 * We use @xenova/transformers with `Xenova/ms-marco-MiniLM-L-6-v2`,
 * a 22M-param distilled model trained on MS MARCO passage ranking.
 * Runs on CPU in WASM/ONNX, no GPU required.
 *
 * Design:
 *   - Lazy-load the package and the model. The first call pays the
 *     download + warmup; subsequent calls reuse a cached pipeline.
 *   - Opt-in via `SIRA_RERANK_ENABLED`. Default off until measured
 *     improvement on the goldenset justifies the latency cost.
 *   - When the package is missing or the model fails to load, we
 *     return `null` from `getRerankerFn()` and the caller falls
 *     back to the embedding-only ranking. Retrieval must never
 *     break because reranking failed.
 *   - The returned function has the shape expected by
 *     hybrid-retrieval.js: `(query, hits) → hits with .score`.
 */

const DEFAULT_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
const DEFAULT_BATCH = 16;
const DEFAULT_MAX_LENGTH = 512;
const DEFAULT_POOL_SIZE = 100;

let _pipelinePromise = null;
let _loadedModel = null;
let _loadError = null;

function isEnabled(env = process.env) {
  const v = String(env.SIRA_RERANK_ENABLED || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function getPoolSize(env = process.env) {
  const raw = parseInt(env.SIRA_RERANK_POOL || "", 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_POOL_SIZE;
}

function getModelName(env = process.env) {
  return env.SIRA_RERANK_MODEL || DEFAULT_MODEL;
}

/**
 * Lazily load the @xenova/transformers cross-encoder pipeline.
 * Returns null if the package is unavailable or the model fails
 * to download.
 */
async function loadPipeline({ model = DEFAULT_MODEL } = {}) {
  if (_loadError) return null;
  if (_pipelinePromise && _loadedModel === model) return _pipelinePromise;
  _loadedModel = model;
  _pipelinePromise = (async () => {
    let transformers;
    try {
      // eslint-disable-next-line global-require, import/no-unresolved
      transformers = await import("@xenova/transformers");
    } catch (err) {
      _loadError = err;
      return null;
    }
    try {
      // text-classification pipeline returns a logit-derived score
      // when passed a [query, chunk] sentence pair.
      const pipe = await transformers.pipeline("text-classification", model, {
        quantized: true,
      });
      return pipe;
    } catch (err) {
      _loadError = err;
      return null;
    }
  })();
  return _pipelinePromise;
}

/**
 * Build a reranker function bound to the loaded model.
 *
 * Returns `null` when reranking is disabled or unavailable, so the
 * caller can branch with a single truthiness check.
 *
 * @param {object} [opts]
 * @param {string} [opts.model]
 * @param {number} [opts.batch]
 * @param {boolean} [opts.force]   bypass env flag (for tests)
 * @param {Function} [opts.scoreFn]  inject a deterministic scorer for tests
 *                                   shape: async (query, texts[]) => number[]
 */
async function getRerankerFn({
  model = getModelName(),
  batch = DEFAULT_BATCH,
  force = false,
  scoreFn = null,
} = {}) {
  if (!force && !isEnabled()) return null;

  let scorer;
  if (typeof scoreFn === "function") {
    scorer = scoreFn;
  } else {
    const pipe = await loadPipeline({ model });
    if (!pipe) return null;
    scorer = async (query, texts) => {
      // Cross-encoder pairs: pass both sides as a single object.
      const pairs = texts.map(t => ({ text: query, text_pair: truncate(t, DEFAULT_MAX_LENGTH * 4) }));
      const results = await pipe(pairs, { topk: 1 });
      // pipe returns either a single object or an array depending on
      // input shape; normalize to per-pair scores. Cross-encoder
      // logits are unbounded; we expose them raw and let downstream
      // sort. (RRF doesn't care about absolute magnitude.)
      const arr = Array.isArray(results) ? results : [results];
      return arr.map(r => {
        const item = Array.isArray(r) ? r[0] : r;
        const s = item && typeof item.score === "number" ? item.score : 0;
        return s;
      });
    };
  }

  return async (query, hits) => {
    if (!Array.isArray(hits) || hits.length === 0) return hits || [];
    const out = [];
    for (let i = 0; i < hits.length; i += batch) {
      const slice = hits.slice(i, i + batch);
      const texts = slice.map(h => String(h.text || ""));
      let scores;
      try {
        scores = await scorer(query, texts);
      } catch (err) {
        // Per-batch failure shouldn't kill the whole rerank — fall
        // back to neutral scores for this batch so the embedding
        // order is preserved.
        scores = new Array(slice.length).fill(0);
      }
      for (let j = 0; j < slice.length; j++) {
        out.push({ id: slice[j].id, score: typeof scores[j] === "number" ? scores[j] : 0 });
      }
    }
    return out;
  };
}

function truncate(s, maxChars) {
  const str = String(s || "");
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars);
}

/** Reset cached state — used by tests to force a clean reload. */
function _resetForTests() {
  _pipelinePromise = null;
  _loadedModel = null;
  _loadError = null;
}

module.exports = {
  getRerankerFn,
  loadPipeline,
  isEnabled,
  getPoolSize,
  getModelName,
  _resetForTests,
  DEFAULT_MODEL,
  DEFAULT_POOL_SIZE,
};

/**
 * orchestrator — WebGLM 3-phase pipeline.
 *   1. decomposeQuery → 3-5 bilingual sub-queries
 *   2. parallelRetrieve → Promise.allSettled over (source × sub-query)
 *                         with dedupe by DOI first, normalised title second
 *   3. rerankResults → LLM-scored composite, fall-back to heuristic
 *
 * Every dependency (LLM callable, retriever) is injectable so tests
 * run fully deterministic and offline.
 */

const { DEFAULT_ACADEMIC_SOURCES, DEFAULT_WEIGHTS } = require("./types");
const { decomposeQuery } = require("./queryDecomposer");
const { rerankResults } = require("./llmReranker");
const { retrieveFromProvider } = require("./providers");

function normaliseTitle(s) {
  if (typeof s !== "string") return "";
  return s
    .toLowerCase()
    .replace(/[\p{P}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeRecord(keep, drop) {
  if (!keep.abstract && drop.abstract) keep.abstract = drop.abstract;
  if (!keep.pdfUrl && drop.pdfUrl) keep.pdfUrl = drop.pdfUrl;
  if (!keep.doi && drop.doi) keep.doi = drop.doi;
  if (drop.citationCount && drop.citationCount > (keep.citationCount ?? 0)) {
    keep.citationCount = drop.citationCount;
  }
  if (drop.openAccess && !keep.openAccess) keep.openAccess = true;
}

/**
 * Dedupe by DOI when available (authoritative); fall back to normalised
 * title ONLY when the incoming paper has no DOI. Two distinct DOIs with
 * the same title are legitimate separate records (editions, translations,
 * proceedings vs journal variants) — collapsing them loses information.
 */
function dedupeResults(results) {
  const byDoi = new Map();
  const byTitle = new Map(); // tracks DOI-less records only
  const order = [];
  for (const r of results) {
    const dkey = r.doi ? `doi:${r.doi.toLowerCase()}` : null;
    const tkey = r.title ? `t:${normaliseTitle(r.title)}` : null;
    if (dkey && byDoi.has(dkey)) {
      mergeRecord(byDoi.get(dkey), r);
      continue;
    }
    if (!dkey && tkey && byTitle.has(tkey)) {
      mergeRecord(byTitle.get(tkey), r);
      continue;
    }
    if (dkey) byDoi.set(dkey, r);
    else if (tkey) byTitle.set(tkey, r);
    order.push(r);
  }
  return order;
}

async function parallelRetrieve({ subqueries, sources, maxPerSource, timeoutMs, mailto, retrieve }) {
  const tasks = [];
  for (const source of sources) {
    for (const sq of subqueries) {
      tasks.push(
        (async () => {
          const t0 = Date.now();
          try {
            const hits = await retrieve({
              source,
              query: sq.text,
              maxResults: maxPerSource,
              timeoutMs,
              mailto,
            });
            return { source, hits: Array.isArray(hits) ? hits : [], durationMs: Date.now() - t0 };
          } catch (err) {
            return {
              source,
              hits: [],
              durationMs: Date.now() - t0,
              error: (err && err.message) || String(err),
            };
          }
        })(),
      );
    }
  }
  const settled = await Promise.allSettled(tasks);
  const perSource = new Map();
  const pooled = [];
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    const { source, hits, durationMs, error } = s.value;
    const agg = perSource.get(source) || { ok: true, count: 0, durationMs: 0 };
    agg.count += hits.length;
    agg.durationMs = Math.max(agg.durationMs, durationMs);
    if (error && !agg.error) {
      agg.error = error;
      agg.ok = false;
    }
    perSource.set(source, agg);
    pooled.push(...hits);
  }
  const traces = sources.map((source) => {
    const agg = perSource.get(source) || { ok: false, count: 0, durationMs: 0, error: "no results" };
    return {
      source,
      ok: agg.ok && agg.count > 0,
      count: agg.count,
      durationMs: agg.durationMs,
      error: agg.error,
    };
  });
  return { results: dedupeResults(pooled), traces };
}

/**
 * @param {object} options
 * @param {string} options.query
 * @param {import("./types").SearchBrainSource[]} [options.sources]
 * @param {number} [options.maxResults]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.mailto]
 * @param {"es"|"en"|"auto"} [options.language]
 * @param {boolean} [options.rerank]
 * @param {Partial<import("./types").SearchBrainWeights>} [options.weights]
 * @param {object} [options.deps] — { callLLM, retrieve } for tests
 * @returns {Promise<import("./types").SearchBrainResponse>}
 */
async function runSearchBrain(options) {
  const deps = options.deps || {};
  const now = deps.now || (() => Date.now());
  const t0 = now();
  const sources = (options.sources && options.sources.length > 0 ? options.sources : [...DEFAULT_ACADEMIC_SOURCES]);
  const maxResults = Math.min(Math.max(options.maxResults || 10, 1), 50);
  const timeoutMs = options.timeoutMs || 8000;
  const retrieve = deps.retrieve || retrieveFromProvider;

  // Phase 1 — decompose
  const p1 = now();
  const decomposed = await decomposeQuery({
    query: options.query,
    language: options.language,
    callLLM: deps.callLLM,
  });
  const decompositionMs = now() - p1;

  // Phase 2 — parallel retrieve
  const p2 = now();
  const subqueries = decomposed.length > 0 ? decomposed : [{ text: options.query, language: "en" }];
  const { results: deduped, traces } = await parallelRetrieve({
    subqueries,
    sources,
    maxPerSource: Math.max(10, Math.ceil(maxResults / Math.max(1, sources.length) + 5)),
    timeoutMs,
    mailto: options.mailto,
    retrieve,
  });
  const retrievalMs = now() - p2;

  // Phase 3 — rerank
  const p3 = now();
  let ranked = deduped;
  let reranked = false;
  if (options.rerank !== false && deps.callLLM) {
    const res = await rerankResults({
      query: options.query,
      results: deduped,
      weights: options.weights,
      callLLM: deps.callLLM,
    });
    ranked = res.results;
    reranked = res.reranked;
  } else {
    ranked = [...deduped].sort((a, b) => {
      const pa = a.providerRank ?? Number.MAX_SAFE_INTEGER;
      const pb = b.providerRank ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      return (b.citationCount ?? 0) - (a.citationCount ?? 0);
    });
  }
  const rerankingMs = now() - p3;

  return {
    query: options.query,
    decomposed,
    results: ranked.slice(0, maxResults),
    providers: traces,
    reranked,
    weights: { ...DEFAULT_WEIGHTS, ...(options.weights || {}) },
    timings: { decompositionMs, retrievalMs, rerankingMs, totalMs: now() - t0 },
  };
}

module.exports = {
  runSearchBrain,
  dedupeResults,
  normaliseTitle,
  INTERNAL: { parallelRetrieve, mergeRecord },
};

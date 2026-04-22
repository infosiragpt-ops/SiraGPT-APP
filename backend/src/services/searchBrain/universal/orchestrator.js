/**
 * UniversalSearchBrain orchestrator — 4-phase pipeline.
 *
 *   1. classify  → detect category intents (regex; LLM tie-break optional)
 *   2. decompose → rewrite the query into 1-3 focused sub-queries
 *                  (phase 2a: identity, i.e. 1 sub-query = the query)
 *   3. retrieve  → Promise.allSettled over (provider × sub-query)
 *   4. rerank    → heuristic ranking by category priority + recency
 *                  (phase 2a; LLM rerank lands in phase 2c when we've
 *                  got meaningful volume to rank)
 *
 * The orchestrator is *category-agnostic*: it reads the registry and
 * trusts every registered provider to return UnifiedResult[]. New
 * providers appear automatically in retrieval once they register().
 */

const { DEFAULT_REGION } = require("./types");
const { classifyIntent, rankIntentsWithLLM } = require("./intentClassifier");
const registry = require("./providerRegistry");

function dedupeById(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    if (!r || !r.id) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/**
 * Heuristic rank: results from the matched-intent category come first,
 * ties broken by `datePublished` desc. Preserves retrieval order
 * within each bucket (providers returned them in an order they liked).
 */
function heuristicRank(results, intents) {
  const priority = new Map(intents.map((c, i) => [c, i]));
  return [...results].sort((a, b) => {
    const pa = priority.has(a.category) ? priority.get(a.category) : Number.MAX_SAFE_INTEGER;
    const pb = priority.has(b.category) ? priority.get(b.category) : Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    const da = a.datePublished ? Date.parse(a.datePublished) : 0;
    const db = b.datePublished ? Date.parse(b.datePublished) : 0;
    return db - da;
  });
}

async function runProvider({ provider, query, opts, timeoutMs, now }) {
  const t0 = now();
  try {
    const hits = await provider.search(query, { ...opts, timeoutMs });
    return {
      providerId: provider.id,
      category: provider.category,
      ok: true,
      count: Array.isArray(hits) ? hits.length : 0,
      durationMs: now() - t0,
      hits: Array.isArray(hits) ? hits : [],
    };
  } catch (err) {
    return {
      providerId: provider.id,
      category: provider.category,
      ok: false,
      count: 0,
      durationMs: now() - t0,
      error: (err && err.message) || String(err),
      hits: [],
    };
  }
}

/**
 * @param {object} args
 * @param {string} args.query
 * @param {import("./types").Category[]} [args.categories]   — force these categories; otherwise classify
 * @param {import("./types").Region} [args.region]           — default DEFAULT_REGION
 * @param {string} [args.language]
 * @param {Record<string, string>} [args.keys]               — provider keys from user settings
 * @param {"local" | "cloud"} [args.mode]                    — "local" = only no-key providers
 * @param {string} [args.userEmail]
 * @param {number} [args.maxResults]
 * @param {number} [args.timeoutMs]
 * @param {boolean} [args.rerank]                            — phase 2a: ignored (heuristic only)
 * @param {object} [args.deps]                               — { now, callLLM, registry } (test seams)
 * @returns {Promise<import("./types").UniversalSearchResponse>}
 */
async function runUniversalSearch(args) {
  const deps = args.deps || {};
  const now = deps.now || (() => Date.now());
  const reg = deps.registry || registry;
  const t0 = now();

  const region = args.region || DEFAULT_REGION;
  const maxResults = Math.min(Math.max(args.maxResults || 15, 1), 50);
  const timeoutMs = args.timeoutMs || 8000;
  const mode = args.mode === "cloud" ? "cloud" : "local";

  // Phase 1 — classify
  const p1 = now();
  let intents = Array.isArray(args.categories) && args.categories.length > 0
    ? [...args.categories]
    : classifyIntent(args.query);
  if (intents.length > 2 && deps.callLLM) {
    intents = await rankIntentsWithLLM({ query: args.query, candidates: intents, callLLM: deps.callLLM });
  }
  const classificationMs = now() - p1;

  // Phase 2 — decompose (phase 2a = identity)
  const p2 = now();
  const subqueries = [args.query];
  const decompositionMs = now() - p2;

  // Phase 3 — retrieve
  const p3 = now();
  const providers = [];
  for (const category of intents) {
    const matches = reg.list({ category, region, keysOnly: mode === "cloud" ? undefined : false });
    providers.push(...matches);
  }
  // de-duplicate providers (same id across multiple category filters)
  const uniqueProviders = [];
  const seenProviderIds = new Set();
  for (const p of providers) {
    if (seenProviderIds.has(p.id)) continue;
    seenProviderIds.add(p.id);
    uniqueProviders.push(p);
  }

  const baseOpts = {
    region,
    language: args.language,
    keys: args.keys || {},
    userEmail: args.userEmail,
    maxResults: Math.max(5, Math.ceil(maxResults / Math.max(1, uniqueProviders.length)) + 3),
    raw: args.raw,
  };

  const tasks = [];
  for (const provider of uniqueProviders) {
    for (const sq of subqueries) {
      tasks.push(runProvider({ provider, query: sq, opts: baseOpts, timeoutMs, now }));
    }
  }
  const settled = await Promise.allSettled(tasks);

  const traces = [];
  const pooled = [];
  const byProvider = new Map();
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    const v = s.value;
    const prior = byProvider.get(v.providerId);
    if (prior) {
      prior.count += v.count;
      prior.durationMs = Math.max(prior.durationMs, v.durationMs);
      if (!v.ok && prior.ok) {
        prior.ok = false;
        prior.error = v.error;
      }
    } else {
      byProvider.set(v.providerId, {
        providerId: v.providerId,
        category: v.category,
        ok: v.ok,
        count: v.count,
        durationMs: v.durationMs,
        error: v.error,
      });
    }
    pooled.push(...v.hits);
  }
  for (const trace of byProvider.values()) traces.push(trace);
  const retrievalMs = now() - p3;

  // Phase 4 — rerank (heuristic only in phase 2a)
  const p4 = now();
  const deduped = dedupeById(pooled);
  const ranked = heuristicRank(deduped, intents).slice(0, maxResults);
  const rerankingMs = now() - p4;

  return {
    query: args.query,
    intents,
    region,
    results: ranked,
    providers: traces,
    reranked: false,
    timings: {
      classificationMs,
      decompositionMs,
      retrievalMs,
      rerankingMs,
      totalMs: now() - t0,
    },
  };
}

module.exports = {
  runUniversalSearch,
  INTERNAL: { dedupeById, heuristicRank, runProvider },
};

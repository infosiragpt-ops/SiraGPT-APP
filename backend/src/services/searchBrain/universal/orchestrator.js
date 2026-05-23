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
const cache = require("./cache");

function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 140);
}

function dedupeById(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    if (!r || !r.id) continue;
    const doi = r.metadata && r.metadata.doi ? `doi:${String(r.metadata.doi).toLowerCase()}` : "";
    const url = r.url ? `url:${String(r.url).replace(/[?#].*$/, "").toLowerCase()}` : "";
    const title = normalizeTitle(r.title);
    const titleKey = title ? `title:${title}` : "";
    const keys = [doi, url, r.id ? `id:${r.id}` : "", titleKey].filter(Boolean);
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    out.push(r);
  }
  return out;
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function credibilityScore(url) {
  const domain = domainFromUrl(url);
  if (!domain) return 0.45;
  if (/(^|\.)gov$|\.gov\.|who\.int$|nih\.gov$|cdc\.gov$|sec\.gov$/.test(domain)) return 0.95;
  if (/\.edu$|\.ac\.[a-z]{2}$|pubmed\.ncbi\.nlm\.nih\.gov$|arxiv\.org$|crossref\.org$|openalex\.org$|semanticscholar\.org$|doaj\.org$/.test(domain)) return 0.9;
  if (/reuters\.com$|apnews\.com$|bbc\.(com|co\.uk)$|theguardian\.com$|nytimes\.com$|nature\.com$|science\.org$|plos\.org$/.test(domain)) return 0.82;
  if (/wikipedia\.org$|wikidata\.org$|worldbank\.org$|clinicaltrials\.gov$|rxnav\.nlm\.nih\.gov$/.test(domain)) return 0.76;
  if (/reddit\.com$|4chan\.org$|twitter\.com$|x\.com$|tiktok\.com$|instagram\.com$/.test(domain)) return 0.35;
  if (domain.endsWith(".org")) return 0.62;
  if (domain.endsWith(".com") || domain.endsWith(".net")) return 0.5;
  return 0.45;
}

function recencyScore(datePublished, category) {
  if (!datePublished) return 0;
  const t = Date.parse(datePublished);
  if (!Number.isFinite(t)) return 0;
  const ageDays = Math.max(0, (Date.now() - t) / 86400000);
  const windows = {
    finance: 14,
    weather: 3,
    news: 45,
    jobs: 90,
    shopping: 180,
    social: 30,
    academic: 3650,
  };
  const windowDays = windows[category] || 730;
  return Math.max(0, 1 - ageDays / windowDays);
}

function providerBaseScore(providerId) {
  const trusted = {
    openalex: 0.92,
    crossref: 0.9,
    "semantic-scholar": 0.86,
    pubmed: 0.9,
    doaj: 0.82,
    arxiv: 0.8,
    europepmc: 0.86,
    scielo: 0.78,
    datacite: 0.82,
    opencitations: 0.76,
    unpaywall: 0.74,
    gdelt: 0.72,
    "google-news-rss": 0.7,
    "sec-edgar": 0.86,
    worldbank: 0.84,
    coingecko: 0.78,
    frankfurter: 0.78,
    openmeteo: 0.82,
    nominatim: 0.76,
    mercadolibre: 0.68,
    remoteok: 0.62,
    remotive: 0.62,
  };
  return trusted[providerId] || 0.55;
}

function scoreResult(result, intents, index) {
  const categoryRank = intents.indexOf(result.category);
  const intentScore = categoryRank >= 0 ? 40 - categoryRank * 4 : 8;
  const providerScore = providerBaseScore(result.sourceProvider) * 18;
  const domainScore = credibilityScore(result.url) * 14;
  const recency = recencyScore(result.datePublished, result.category) * 10;
  const metadata = result.metadata || {};
  const doiScore = metadata.doi ? 6 : 0;
  const oaScore = metadata.openAccess || metadata.isOa || metadata.pdfUrl ? 4 : 0;
  const citationCount = Number(metadata.citationCount || metadata.citedByCount || 0);
  const citationScore = citationCount > 0 ? Math.min(8, Math.log10(citationCount + 1) * 2.5) : 0;
  const freshnessPenalty = index * 0.015;
  return Math.max(0, intentScore + providerScore + domainScore + recency + doiScore + oaScore + citationScore - freshnessPenalty);
}

/**
 * Heuristic rank: results from the matched-intent category come first,
 * ties broken by `datePublished` desc. Preserves retrieval order
 * within each bucket (providers returned them in an order they liked).
 */
function heuristicRank(results, intents) {
  return results
    .map((r, index) => ({
      ...r,
      metadata: {
        ...(r.metadata || {}),
        searchBrainScore: Number(scoreResult(r, intents, index).toFixed(3)),
        credibilityScore: Number(credibilityScore(r.url).toFixed(3)),
      },
    }))
    .sort((a, b) => (b.metadata.searchBrainScore || 0) - (a.metadata.searchBrainScore || 0));
}

async function runProvider({ provider, query, opts, timeoutMs, now }) {
  const t0 = now();
  try {
    const work = provider.search(query, { ...opts, timeoutMs });
    const hits = await Promise.race([
      work,
      new Promise((resolve) => setTimeout(() => resolve([]), timeoutMs)),
    ]);
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

  // Phase 1 — classify
  const p1 = now();
  let intents = Array.isArray(args.categories) && args.categories.length > 0
    ? [...args.categories]
    : classifyIntent(args.query);
  if (intents.length > 2 && deps.callLLM) {
    intents = await rankIntentsWithLLM({ query: args.query, candidates: intents, callLLM: deps.callLLM });
  }
  const classificationMs = now() - p1;

  const cacheKey = { query: args.query, categories: intents, region, provider: "*" };
  const cacheEnabled = args.cache !== false && !deps.registry;
  if (cacheEnabled) {
    const cached = await cache.getCached(cacheKey);
    if (cached) {
      return {
        query: args.query,
        intents,
        region,
        results: cached.results.slice(0, maxResults),
        providers: cached.metadata.providers || [],
        failedProviders: cached.metadata.failedProviders || [],
        totalCandidates: cached.metadata.totalCandidates || cached.results.length,
        dedupedCandidates: cached.metadata.dedupedCandidates || cached.results.length,
        reranked: false,
        cacheHit: true,
        timings: {
          classificationMs,
          decompositionMs: 0,
          retrievalMs: 0,
          rerankingMs: 0,
          totalMs: now() - t0,
        },
      };
    }
  }

  // Phase 2 — decompose (phase 2a = identity)
  const p2 = now();
  const subqueries = [args.query];
  const decompositionMs = now() - p2;

  // Phase 3 — retrieve
  const p3 = now();
  const providers = [];
  for (const category of intents) {
    const matches = reg.list({ category, region, keys: args.keys || {} });
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
  const failedProviders = [];
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
  for (const trace of byProvider.values()) {
    traces.push(trace);
    if (!trace.ok || trace.error) failedProviders.push(trace);
  }
  const retrievalMs = now() - p3;

  // Phase 4 — rerank (heuristic only in phase 2a)
  const p4 = now();
  const totalCandidates = pooled.length;
  const deduped = dedupeById(pooled);
  const dedupedCandidates = deduped.length;
  const ranked = heuristicRank(deduped, intents).slice(0, maxResults);
  const rerankingMs = now() - p4;

  if (cacheEnabled && ranked.length > 0) {
    await cache.setCached(cacheKey, ranked, {
      providers: traces,
      failedProviders,
      totalCandidates,
      dedupedCandidates,
      at: new Date().toISOString(),
    });
  }

  return {
    query: args.query,
    intents,
    region,
    results: ranked,
    providers: traces,
    failedProviders,
    totalCandidates,
    dedupedCandidates,
    reranked: false,
    cacheHit: false,
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
  INTERNAL: { credibilityScore, dedupeById, heuristicRank, normalizeTitle, runProvider, scoreResult },
};

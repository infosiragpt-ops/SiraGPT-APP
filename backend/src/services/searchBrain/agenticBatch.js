/**
 * agenticBatch — round-robin academic search orchestrator that
 * collects up to N sources by pulling B at a time from each provider,
 * yielding events as it goes so the UI can render an "agentic" search
 * progress indicator instead of a single JSON dump at the end.
 *
 * Why an async generator (and not just a callback): the SSE route
 * wants to `for await` the events and forward each as a `data:` frame.
 * That maps 1:1 onto a generator and avoids the inversion of control
 * a callback pattern would force on the route.
 *
 * Pipeline:
 *   start                           → emit { start } with config
 *   for round in 1..maxRounds:
 *     for provider in providers:
 *       fetch batchSize results at offset
 *       dedupe against the running pool
 *       emit { batch, batchN, provider, count, totalCollected, sources }
 *       advance offset; if zero results, mark provider exhausted
 *     stop early if total ≥ target OR every provider exhausted
 *   collection_done                 → snapshot of the run
 *   ranking_start                   → "selecting top K"
 *   for batch in pool grouped 10s:  → reranker yields rerankScore
 *   selected                        → top-K final list
 *   summary                         → markdown report ready for chat
 *   done                            → final stats
 *
 * Failure handling: each provider call is wrapped — a 500 from one
 * provider only surfaces as { batch_error, provider, error } and
 * the loop carries on. Two consecutive failures from the same
 * provider mark it exhausted to bound the run.
 */

const { retrieveFromProvider, REGISTRY } = require("./providers");
const { rerankResults } = require("./llmReranker");
const { callLLM } = require("./llmClient");

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_TARGET = 500;
const DEFAULT_TOP_K = 25;
// Default academic pool for the agentic batcher. Scopus sits first
// when a SCOPUS_API_KEY is present (so its relevance-sorted results
// seed the top of the ranked pool); the provider soft-skips to []
// when no key is configured, and the rest of the pool carries the
// run.
const DEFAULT_PROVIDERS = ["scopus", "openalex", "scielo", "semantic", "crossref", "pubmed", "doaj"];
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_PROVIDER_ERRORS = 2;
const HARD_ROUND_CAP = 60; // safety: never spin more rounds than this

function dedupKey(item) {
  if (item.doi) return `doi:${String(item.doi).toLowerCase()}`;
  if (item.url) return `url:${String(item.url).toLowerCase()}`;
  return `t:${String(item.title || "").trim().toLowerCase()}`;
}

function compactSource(item) {
  // The SSE payload goes over the wire on every batch — keep it lean
  // by stripping the raw provider blob (often tens of KB).
  return {
    source: item.source,
    title: item.title,
    authors: Array.isArray(item.authors) ? item.authors.slice(0, 5) : [],
    year: item.year,
    journal: item.journal,
    volume: item.volume,
    issue: item.issue,
    pages: item.pages,
    doi: item.doi,
    url: item.url,
    pdfUrl: item.pdfUrl,
    abstract: typeof item.abstract === "string"
      ? item.abstract.slice(0, 320) + (item.abstract.length > 320 ? "…" : "")
      : undefined,
    citationCount: item.citationCount,
    openAccess: item.openAccess,
    rerankScore: item.rerankScore,
  };
}

function normaliseDoi(doi) {
  return String(doi || "").trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
}

function doiUrl(doi) {
  const clean = normaliseDoi(doi);
  return clean ? `https://doi.org/${clean}` : "";
}

function ensureSentence(text) {
  const s = String(text || "").trim();
  if (!s) return "";
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

function formatAuthors(authors) {
  const list = Array.isArray(authors) ? authors.map(a => String(a || "").trim()).filter(Boolean) : [];
  if (list.length === 0) return "Autor desconocido";
  if (list.length > 6) return `${list.slice(0, 6).join(", ")}, et al.`;
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")}, & ${list[list.length - 1]}`;
}

function formatVenue(source) {
  const journal = String(source.journal || "").trim();
  if (!journal) return "";
  let out = `*${journal}*`;
  if (source.volume) {
    out += `, ${source.volume}`;
    if (source.issue) out += `(${source.issue})`;
  } else if (source.issue) {
    out += `, (${source.issue})`;
  }
  if (source.pages) out += `, ${source.pages}`;
  return ensureSentence(out);
}

function formatArticleCitation(source, index) {
  const authors = formatAuthors(source.authors);
  const year = source.year ? `(${source.year}).` : "(s. f.).";
  const title = ensureSentence(source.title || "Sin título");
  const venue = formatVenue(source);
  const link = source.doi ? doiUrl(source.doi) : (source.url || source.pdfUrl || "");
  const metadata = [authors, year, title, venue].filter(Boolean).join(" ");
  return `${index + 1}. ${metadata}${link ? `\n${link}` : ""}`;
}

function buildSummaryMarkdown({ query, totalCollected, dedupedCount, top, providerStats }) {
  const lines = [];
  const providersUsed = Object.entries(providerStats || {})
    .filter(([, stats]) => stats && stats.contributed > 0)
    .map(([provider]) => provider);
  lines.push("## Artículos encontrados");
  lines.push("");
  top.forEach((s, i) => {
    lines.push(formatArticleCitation(s, i));
    lines.push("");
  });
  lines.push("---");
  lines.push(`*Consulta: "${query}". Se recopilaron ${totalCollected} fuentes, ${dedupedCount} únicas, y se seleccionaron ${top.length}.` +
    (providersUsed.length ? ` Proveedores con resultados: ${providersUsed.join(", ")}.` : "") + "*");
  return lines.join("\n");
}

/**
 * @typedef {object} AgenticBatchOptions
 * @property {string} query
 * @property {number} [target=500]
 * @property {number} [batchSize=10]
 * @property {number} [topK=25]
 * @property {string[]} [providers]
 * @property {number} [timeoutMs]
 * @property {string} [mailto]
 * @property {string} [language]
 * @property {AbortSignal} [signal]
 * @property {object} [deps]                — { retrieve, rerank, callLLM, sleep } (test seams)
 */

/**
 * Sleep helper that honours an AbortSignal so a client disconnect
 * cancels mid-pause instead of waiting out the throttle.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => { clearTimeout(t); reject(new Error("aborted")); };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Runs the agentic batched search and yields events as they happen.
 *
 * @param {AgenticBatchOptions} opts
 */
async function* runAgenticBatch(opts) {
  const target = Math.min(Math.max(Number(opts.target) || DEFAULT_TARGET, 10), 1000);
  const batchSize = Math.min(Math.max(Number(opts.batchSize) || DEFAULT_BATCH_SIZE, 5), 50);
  const topK = Math.min(Math.max(Number(opts.topK) || DEFAULT_TOP_K, 1), 100);
  const requestedProviders = Array.isArray(opts.providers) && opts.providers.length > 0
    ? opts.providers.filter((p) => p in REGISTRY)
    : DEFAULT_PROVIDERS.filter((p) => p in REGISTRY);
  const providers = requestedProviders.length > 0 ? requestedProviders : DEFAULT_PROVIDERS;
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const mailto = opts.mailto;
  const language = opts.language;
  const signal = opts.signal;
  const deps = opts.deps || {};
  const retrieve = deps.retrieve || retrieveFromProvider;
  const rerank = deps.rerank || rerankResults;
  const llm = deps.callLLM || callLLM;
  const _sleep = deps.sleep || sleep;
  const query = String(opts.query || "").trim();

  if (!query) {
    yield { type: "error", message: "query is required" };
    return;
  }

  const startedAt = Date.now();
  yield {
    type: "start",
    query,
    target,
    batchSize,
    topK,
    providers,
    startedAt,
  };

  // Per-provider state.
  const offsets = Object.fromEntries(providers.map((p) => [p, 0]));
  const errors = Object.fromEntries(providers.map((p) => [p, 0]));
  const contributed = Object.fromEntries(providers.map((p) => [p, 0]));
  const exhausted = new Set();

  const seen = new Set();
  const collected = [];
  let batchN = 0;
  let totalRequested = 0;

  outer: for (let round = 0; round < HARD_ROUND_CAP; round++) {
    if (signal?.aborted) {
      yield { type: "aborted", reason: "client_disconnect", round };
      return;
    }
    if (collected.length >= target) break outer;
    if (exhausted.size >= providers.length) break outer;

    for (const provider of providers) {
      if (signal?.aborted) {
        yield { type: "aborted", reason: "client_disconnect", provider, round };
        return;
      }
      if (exhausted.has(provider)) continue;
      if (collected.length >= target) break outer;

      const offset = offsets[provider];
      totalRequested++;

      let batch = [];
      let providerError = null;
      try {
        batch = await retrieve({
          source: provider,
          query,
          maxResults: batchSize,
          offset,
          mailto,
          timeoutMs,
          language,
        });
      } catch (err) {
        providerError = err && err.message ? err.message : String(err);
      }

      if (providerError) {
        errors[provider]++;
        yield {
          type: "batch_error",
          batchN: batchN + 1,
          provider,
          error: providerError,
          totalCollected: collected.length,
        };
        if (errors[provider] >= MAX_PROVIDER_ERRORS) {
          exhausted.add(provider);
          yield { type: "provider_done", provider, contributed: contributed[provider], reason: "errors" };
        }
        continue;
      }

      if (!Array.isArray(batch) || batch.length === 0) {
        exhausted.add(provider);
        yield { type: "provider_done", provider, contributed: contributed[provider], reason: "no_more_results" };
        continue;
      }

      offsets[provider] += batch.length;

      const fresh = [];
      for (const item of batch) {
        if (!item || typeof item !== "object") continue;
        const key = dedupKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push(item);
        collected.push(item);
        if (collected.length >= target) break;
      }
      contributed[provider] += fresh.length;
      batchN++;

      yield {
        type: "batch",
        batchN,
        round: round + 1,
        provider,
        requested: batchSize,
        received: batch.length,
        unique: fresh.length,
        duplicates: batch.length - fresh.length,
        totalCollected: collected.length,
        target,
        sources: fresh.map(compactSource),
      };

      if (fresh.length === 0) {
        exhausted.add(provider);
        yield { type: "provider_done", provider, contributed: contributed[provider], reason: "no_new_results" };
        continue;
      }

      if (batch.length < batchSize) {
        exhausted.add(provider);
        yield { type: "provider_done", provider, contributed: contributed[provider], reason: "page_short" };
      }

      // Tiny breather between calls so a 6-provider sweep can't burn
      // through 60 requests/sec when every provider is fast. Honours
      // the same AbortSignal as the rest of the loop.
      try { await _sleep(120, signal); } catch { /* aborted */ return; }
    }
  }

  const collectionDoneAt = Date.now();
  yield {
    type: "collection_done",
    totalCollected: collected.length,
    deduped: seen.size,
    requestedCalls: totalRequested,
    providerStats: providers.reduce((acc, p) => {
      acc[p] = {
        contributed: contributed[p],
        errors: errors[p],
        exhausted: exhausted.has(p),
        offset: offsets[p],
      };
      return acc;
    }, {}),
    elapsedMs: collectionDoneAt - startedAt,
  };

  if (collected.length === 0) {
    yield { type: "summary", markdown: `## ⚠️ Sin resultados\n\nNo se recuperaron fuentes para "${query}".` };
    yield { type: "done", stats: { totalCollected: 0, dedupedCount: 0, selectedCount: 0 } };
    return;
  }

  yield {
    type: "ranking_start",
    message: `Reranking ${collected.length} fuentes con LLM y seleccionando las mejores ${topK}…`,
    pool: collected.length,
    topK,
  };

  let ranked = collected;
  let rerankerWasUsed = false;
  try {
    const out = await rerank({
      query,
      results: collected,
      callLLM: llm,
      batchSize: 10,
    });
    ranked = Array.isArray(out?.results) ? out.results : collected;
    rerankerWasUsed = Boolean(out?.reranked);
  } catch (err) {
    yield { type: "rerank_error", error: err && err.message ? err.message : String(err) };
  }

  const top = ranked.slice(0, topK).map(compactSource);
  yield {
    type: "selected",
    topK: top.length,
    rerankerWasUsed,
    sources: top,
  };

  const providerStats = providers.reduce((acc, p) => {
    acc[p] = {
      contributed: contributed[p],
      errors: errors[p],
      exhausted: exhausted.has(p),
    };
    return acc;
  }, {});

  const markdown = buildSummaryMarkdown({
    query,
    totalCollected: collected.length,
    dedupedCount: seen.size,
    top,
    providerStats,
  });
  yield { type: "summary", markdown };

  yield {
    type: "done",
    stats: {
      totalCollected: collected.length,
      dedupedCount: seen.size,
      selectedCount: top.length,
      elapsedMs: Date.now() - startedAt,
      rerankerWasUsed,
    },
  };
}

module.exports = {
  runAgenticBatch,
  buildSummaryMarkdown,
  DEFAULT_PROVIDERS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_TARGET,
  DEFAULT_TOP_K,
  INTERNAL: { dedupKey, compactSource, sleep },
};

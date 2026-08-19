'use strict';

/**
 * prompt-cache-metrics — sliding-window collector for prompt-cache
 * usage. Tracks hits, misses, cache_creation tokens, cache_read tokens,
 * and savings vs. uncached cost per (model, tenant) so /metrics and
 * Grafana dashboards can answer "is prompt caching pulling its weight"
 * without scraping provider invoices.
 *
 * The collector is intentionally over-the-wire-agnostic: callers
 * report() the per-call usage they already get back from the SDK
 * (Anthropic, OpenAI, etc.) and we bucket it. No HTTP, no provider
 * coupling, deterministic.
 *
 * Public API:
 *   const m = createPromptCacheMetrics({
 *     windowMs,                         // default 60 * 60_000 (1h)
 *     pricing,                          // { [model]: { uncachedPerMTok, cachedPerMTok, creationPerMTok } }
 *     now,                              // clock injector
 *   })
 *   m.report({ model, tenantId, hits, misses, cacheRead, cacheCreation,
 *              promptTokens, completionTokens })
 *   m.snapshot({ model?, tenantId? })   → aggregate stats
 *   m.hitRate({ model?, tenantId? })    → 0..1
 *   m.estimatedSavingsUsd({ model?, tenantId? }) → number
 *   m.reset()                           → wipes counters
 *
 * Bucket granularity: 1 minute. GC walks expired buckets on every
 * report(); O(buckets) per call which is fine for any realistic
 * windowMs.
 */

const BUCKET_MS = 60_000;
const DEFAULT_WINDOW_MS = 60 * 60_000;

function createPromptCacheMetrics(opts = {}) {
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs > 0
    ? Math.floor(opts.windowMs)
    : DEFAULT_WINDOW_MS;
  const pricing = (opts.pricing && typeof opts.pricing === 'object') ? opts.pricing : {};
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  /** @type {Map<string, Map<number, object>>} key = `${model}::${tenantId}`, inner = bucket → totals */
  const series = new Map();

  function bucketKey(t) { return Math.floor(t / BUCKET_MS) * BUCKET_MS; }

  function gc(t) {
    const cutoff = t - windowMs;
    for (const [k, buckets] of series) {
      for (const b of [...buckets.keys()]) {
        if (b < cutoff) buckets.delete(b);
      }
      if (buckets.size === 0) series.delete(k);
    }
  }

  function key(model, tenantId) {
    return `${model || 'unknown'}::${tenantId || 'global'}`;
  }

  function emptyTotals() {
    return {
      hits: 0,
      misses: 0,
      cacheRead: 0,
      cacheCreation: 0,
      promptTokens: 0,
      completionTokens: 0,
      calls: 0,
    };
  }

  function addInto(target, src) {
    target.hits += src.hits;
    target.misses += src.misses;
    target.cacheRead += src.cacheRead;
    target.cacheCreation += src.cacheCreation;
    target.promptTokens += src.promptTokens;
    target.completionTokens += src.completionTokens;
    target.calls += src.calls;
  }

  function report({ model, tenantId = null, hits = 0, misses = 0, cacheRead = 0, cacheCreation = 0, promptTokens = 0, completionTokens = 0 } = {}) {
    if (!model || typeof model !== 'string') return;
    const t = now();
    const k = key(model, tenantId);
    const inner = series.get(k) || new Map();
    series.set(k, inner);
    const bk = bucketKey(t);
    const b = inner.get(bk) || emptyTotals();
    b.hits += Math.max(0, Number(hits) || 0);
    b.misses += Math.max(0, Number(misses) || 0);
    b.cacheRead += Math.max(0, Number(cacheRead) || 0);
    b.cacheCreation += Math.max(0, Number(cacheCreation) || 0);
    b.promptTokens += Math.max(0, Number(promptTokens) || 0);
    b.completionTokens += Math.max(0, Number(completionTokens) || 0);
    b.calls += 1;
    inner.set(bk, b);
    gc(t);
  }

  function aggregate(filter = {}) {
    const t = now();
    gc(t);
    const out = emptyTotals();
    let scoped = 0;
    for (const [k, inner] of series) {
      const [model, tenantId] = k.split('::');
      if (filter.model && filter.model !== model) continue;
      if (filter.tenantId && filter.tenantId !== tenantId) continue;
      scoped += 1;
      for (const b of inner.values()) addInto(out, b);
    }
    return { ...out, series: scoped };
  }

  function snapshot(filter = {}) {
    const totals = aggregate(filter);
    return {
      windowMs,
      ...totals,
      hitRate: hitRateOf(totals),
      estimatedSavingsUsd: savingsOf(totals, filter.model || null),
    };
  }

  function hitRateOf(totals) {
    const denom = totals.hits + totals.misses;
    return denom > 0 ? totals.hits / denom : 0;
  }

  function savingsOf(totals, modelHint) {
    // If pricing not provided for the model, savings is 0 — we never
    // invent prices.
    const price = pricing[modelHint] || null;
    if (!price) return 0;
    const uncachedPerMTok = Number(price.uncachedPerMTok) || 0;
    const cachedPerMTok = Number(price.cachedPerMTok) || 0;
    // savings = cacheRead tokens * (uncached - cached) per million
    const savings = (totals.cacheRead / 1_000_000) * (uncachedPerMTok - cachedPerMTok);
    return Math.max(0, savings);
  }

  function hitRate(filter = {}) { return hitRateOf(aggregate(filter)); }
  function estimatedSavingsUsd(filter = {}) { return savingsOf(aggregate(filter), filter.model || null); }
  function reset() { series.clear(); }

  return { report, snapshot, hitRate, estimatedSavingsUsd, reset };
}

module.exports = {
  createPromptCacheMetrics,
  BUCKET_MS,
  DEFAULT_WINDOW_MS,
};

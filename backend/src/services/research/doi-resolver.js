'use strict';

const { doiStatus, normaliseDoi } = require('./source-integrity');

const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const NOT_FOUND_TTL_MS = 60 * 60_000;
const DEFAULT_MAX_CACHE_ENTRIES = 2_000;
const DEFAULT_MAX_PAPERS = 15;
const DEFAULT_CONCURRENCY = 4;

const resolutionCache = new Map();

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function cacheGet(key, now = Date.now()) {
  const entry = resolutionCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    resolutionCache.delete(key);
    return null;
  }
  // Refresh insertion order so the bounded cache behaves like a small LRU.
  resolutionCache.delete(key);
  resolutionCache.set(key, entry);
  return { ...entry.value, cacheHit: true };
}

function cacheSet(key, value, ttlMs, maxEntries = DEFAULT_MAX_CACHE_ENTRIES) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
  resolutionCache.delete(key);
  resolutionCache.set(key, { value: { ...value, cacheHit: false }, expiresAt: Date.now() + ttlMs });
  while (resolutionCache.size > Math.max(1, maxEntries)) {
    resolutionCache.delete(resolutionCache.keys().next().value);
  }
}

function baseResult(doi, status, extra = {}) {
  return {
    doi,
    status,
    httpStatus: null,
    canonicalUrl: null,
    checkedAt: nowIso(),
    cacheHit: false,
    ...extra,
  };
}

async function resolveDoi(value, opts = {}) {
  const doi = normaliseDoi(value);
  const syntax = doiStatus(doi);
  if (syntax === 'missing') return baseResult('', 'missing');
  if (syntax !== 'format_valid') return baseResult(doi, 'invalid');

  const key = doi.toLowerCase();
  const cached = cacheGet(key);
  if (cached) return cached;

  const fetchImpl = opts.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') return baseResult(doi, 'unavailable', { reason: 'fetch_unavailable' });

  const timeoutMs = Number.isFinite(opts.timeoutMs)
    ? Math.max(100, opts.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const externalSignal = opts.signal;
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) controller.abort(externalSignal.reason);
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('doi_resolution_timeout')), timeoutMs);

  let result;
  try {
    const encodedDoi = doi.split('/').map((part) => encodeURIComponent(part)).join('/');
    const response = await fetchImpl(`https://doi.org/${encodedDoi}`, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5',
        'User-Agent': 'SiraGPT-Research/1.0 (+https://siragpt.com)',
      },
    });
    const httpStatus = Number(response?.status) || null;
    const canonicalUrl = response?.url || response?.headers?.get?.('location') || null;
    if (response?.ok) {
      result = baseResult(doi, 'resolved', { httpStatus, canonicalUrl });
    } else if (httpStatus === 404 || httpStatus === 410) {
      result = baseResult(doi, 'not_found', { httpStatus, canonicalUrl });
    } else {
      result = baseResult(doi, 'unavailable', { httpStatus, canonicalUrl, reason: `http_${httpStatus || 'unknown'}` });
    }
  } catch (error) {
    const abortedExternally = Boolean(externalSignal?.aborted);
    result = baseResult(doi, abortedExternally ? 'aborted' : (controller.signal.aborted ? 'timeout' : 'unavailable'), {
      reason: error?.message || String(error),
    });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }

  if (result.status === 'resolved') {
    cacheSet(key, result, opts.ttlMs ?? DEFAULT_TTL_MS, opts.maxCacheEntries);
  } else if (result.status === 'not_found') {
    cacheSet(key, result, opts.notFoundTtlMs ?? NOT_FOUND_TTL_MS, opts.maxCacheEntries);
  }
  return result;
}

function editorialStatusFor(paper, resolution) {
  const integrity = String(paper?.integrityStatus || 'unknown');
  if (['retracted', 'withdrawn', 'expression_of_concern', 'corrected'].includes(integrity)) return integrity;
  if (resolution.status === 'not_found') return 'doi_not_found';
  // A resolving DOI proves the identifier destination exists, not that the
  // article passed editorial review or remains free of later notices.
  return 'not_indicated';
}

async function resolvePaperDois(papers, opts = {}) {
  if (!Array.isArray(papers) || papers.length === 0) return [];
  const maxPapers = Number.isFinite(opts.maxPapers)
    ? Math.max(0, Math.min(opts.maxPapers, papers.length))
    : Math.min(DEFAULT_MAX_PAPERS, papers.length);
  const concurrency = Number.isFinite(opts.concurrency)
    ? Math.max(1, Math.min(opts.concurrency, 10))
    : DEFAULT_CONCURRENCY;
  const output = papers.map((paper) => ({ ...paper }));
  const queue = output
    .map((paper, index) => ({ paper, index }))
    .filter(({ paper }) => doiStatus(paper.doi) === 'format_valid')
    .slice(0, maxPapers);
  let next = 0;

  async function worker() {
    while (next < queue.length) {
      const current = queue[next++];
      const resolution = await resolveDoi(current.paper.doi, opts);
      output[current.index] = {
        ...current.paper,
        doiResolutionStatus: resolution.status,
        doiResolvedUrl: resolution.canonicalUrl,
        doiResolutionHttpStatus: resolution.httpStatus,
        doiCheckedAt: resolution.checkedAt,
        doiResolutionCacheHit: resolution.cacheHit,
        editorialStatus: editorialStatusFor(current.paper, resolution),
      };
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
  return output;
}

function clearDoiResolutionCache() {
  resolutionCache.clear();
}

module.exports = {
  resolveDoi,
  resolvePaperDois,
  clearDoiResolutionCache,
  _internal: {
    cacheGet,
    cacheSet,
    editorialStatusFor,
    resolutionCache,
  },
};

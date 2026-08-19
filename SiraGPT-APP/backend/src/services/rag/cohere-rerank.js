'use strict';

/**
 * cohere-rerank — cross-encoder reranking via Cohere Rerank 3.5.
 *
 * Why cross-encoder vs the existing llm-reranker:
 *   The current `llm-reranker.js` calls a generative LLM with the
 *   query + each candidate and asks for a relevance score. Quality is
 *   good but the latency budget is 4–6 s per query and the cost is
 *   ~$0.01–0.03 per call (production telemetry). Cross-encoders are
 *   purpose-built rankers: Cohere Rerank 3.5 returns ~50 candidates
 *   in ~600 ms with comparable nDCG@10 and ~10× lower cost. The
 *   self-hosted alternative is BGE-reranker-v2-m3 at p95 ~145 ms
 *   (https://www.zeroentropy.dev/articles/should-you-use-llms-for-reranking-a-deep-dive-into-pointwise-listwise-and-cross-encoders).
 *
 * Why HTTP not SDK:
 *   Cohere ships a Node SDK but it's another runtime dependency, and
 *   the rerank endpoint is a single POST. Going direct via fetch
 *   keeps the surface tiny, makes test stubbing trivial (inject a
 *   fake fetch), and avoids version drift between SDK and API.
 *
 * Public API:
 *   rerank({ query, documents, topN, model, options })
 *     → Array<{ index, score, document }>
 *
 *   isAvailable(env) → boolean
 *
 *   buildRequest(args) → { url, init }
 *     pure helper, useful in tests + future retry/backoff wrappers
 *
 *   normalizeResults(rawResults, documents) → Array<{ index, score, document }>
 *     pure helper for parsing Cohere's response into the registry shape
 *
 * Failure modes (typed Error.code):
 *   cohere_rerank_disabled         no COHERE_API_KEY in env
 *   cohere_rerank_bad_args         missing query / documents
 *   cohere_rerank_http_failed      non-2xx response
 *   cohere_rerank_invalid_response upstream returned an unexpected shape
 */

const DEFAULT_MODEL = process.env.COHERE_RERANK_MODEL || 'rerank-v3.5';
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.COHERE_RERANK_TIMEOUT_MS, 10) || 15_000;
const DEFAULT_API_BASE = process.env.COHERE_API_BASE || 'https://api.cohere.com';
const RERANK_PATH = '/v2/rerank';
const MAX_DOC_CHARS = 8_000; // per-document hard cap; Cohere truncates anyway, but be explicit

function isAvailable(env = process.env) {
  return Boolean((env.COHERE_API_KEY || '').trim());
}

function clampString(s, max) {
  const text = String(s || '');
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * Build the HTTP request envelope. Pure — no env reads, no fetch.
 *
 * @param {object} args
 * @param {string} args.apiKey
 * @param {string} args.query
 * @param {string[]|Array<{text:string}>} args.documents
 * @param {number} [args.topN]
 * @param {string} [args.model]
 * @param {string} [args.apiBase]
 * @returns {{ url: string, init: RequestInit }}
 */
function buildRequest({ apiKey, query, documents, topN, model = DEFAULT_MODEL, apiBase = DEFAULT_API_BASE } = {}) {
  if (!apiKey) {
    const err = new Error('cohere-rerank: apiKey is required');
    err.code = 'cohere_rerank_disabled';
    throw err;
  }
  if (typeof query !== 'string' || query.trim().length === 0) {
    const err = new Error('cohere-rerank: query is required');
    err.code = 'cohere_rerank_bad_args';
    throw err;
  }
  if (!Array.isArray(documents) || documents.length === 0) {
    const err = new Error('cohere-rerank: documents[] is required');
    err.code = 'cohere_rerank_bad_args';
    throw err;
  }

  const docs = documents.map((d) => {
    if (typeof d === 'string') return clampString(d, MAX_DOC_CHARS);
    if (d && typeof d.text === 'string') return clampString(d.text, MAX_DOC_CHARS);
    return '';
  }).filter((s) => s.length > 0);
  if (docs.length === 0) {
    const err = new Error('cohere-rerank: documents[] contained no usable text');
    err.code = 'cohere_rerank_bad_args';
    throw err;
  }

  const body = {
    model,
    query,
    documents: docs,
  };
  if (Number.isInteger(topN) && topN > 0) body.top_n = Math.min(topN, docs.length);

  return {
    url: `${apiBase.replace(/\/+$/, '')}${RERANK_PATH}`,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    },
  };
}

/**
 * Parse Cohere's `/v2/rerank` response into the registry's shape.
 *
 * Cohere returns `{ results: [{ index, relevance_score }, ...] }`
 * already sorted desc by score. We attach the original document
 * string back so the caller can render results without keeping the
 * input array around.
 *
 * Defensive parsing:
 *   - Drops items with non-integer index or out-of-range index
 *   - Drops items with non-numeric relevance_score
 *   - Returns an empty array (not null) for malformed payloads
 */
function normalizeResults(rawResults, documents) {
  if (!Array.isArray(rawResults)) return [];
  const docs = Array.isArray(documents) ? documents : [];
  const out = [];
  for (const r of rawResults) {
    if (!r || typeof r !== 'object') continue;
    const index = Number.isInteger(r.index) ? r.index : -1;
    const score = typeof r.relevance_score === 'number' ? r.relevance_score : NaN;
    if (index < 0 || index >= docs.length) continue;
    if (!Number.isFinite(score)) continue;
    const doc = docs[index];
    out.push({
      index,
      score,
      document: typeof doc === 'string' ? doc : (doc && typeof doc.text === 'string' ? doc.text : ''),
    });
  }
  return out;
}

/**
 * Rerank `documents` against `query` using Cohere Rerank.
 *
 * @param {object} args
 * @param {string} args.query
 * @param {string[]|Array<{text:string}>} args.documents
 * @param {number} [args.topN]
 * @param {string} [args.model]
 * @param {object} [args.options]
 * @param {Function} [args.options.fetchImpl]   defaults to globalThis.fetch
 * @param {AbortSignal} [args.options.signal]
 * @param {number} [args.options.timeoutMs]
 * @param {string} [args.options.apiKey]        defaults to env COHERE_API_KEY
 * @param {string} [args.options.apiBase]
 *
 * @returns {Promise<Array<{ index:number, score:number, document:string }>>}
 */
async function rerank({ query, documents, topN, model = DEFAULT_MODEL, options = {} } = {}) {
  const apiKey = options.apiKey || process.env.COHERE_API_KEY;
  if (!apiKey) {
    const err = new Error('cohere-rerank disabled: set COHERE_API_KEY');
    err.code = 'cohere_rerank_disabled';
    throw err;
  }
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    const err = new Error('cohere-rerank: no fetch implementation available');
    err.code = 'cohere_rerank_disabled';
    throw err;
  }

  const { url, init } = buildRequest({ apiKey, query, documents, topN, model, apiBase: options.apiBase });

  // Timeout via AbortController; honour external signal too.
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('cohere-rerank timeout')), timeoutMs);
  // Keep a reference to the external-signal listener so it can be detached
  // in `finally`. With `{ once: true }` it auto-removes only if it fires; on
  // the normal path it would otherwise linger on a caller-supplied — and
  // possibly reused — signal, leaking one dead listener per call.
  let onExternalAbort = null;
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason || 'external abort');
    else {
      onExternalAbort = () => controller.abort(options.signal.reason || 'external abort');
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    const wrapped = new Error(`cohere-rerank network error: ${err && err.message}`);
    wrapped.code = 'cohere_rerank_http_failed';
    wrapped.cause = err;
    throw wrapped;
  } finally {
    clearTimeout(timer);
    if (onExternalAbort && options.signal) {
      options.signal.removeEventListener('abort', onExternalAbort);
    }
  }

  if (!response || !response.ok) {
    const status = response?.status ?? 0;
    let bodyText = '';
    try { bodyText = await response.text(); } catch { /* swallow */ }
    const err = new Error(`cohere-rerank HTTP ${status}: ${bodyText.slice(0, 300)}`);
    err.code = 'cohere_rerank_http_failed';
    err.status = status;
    throw err;
  }

  let parsed;
  try {
    parsed = await response.json();
  } catch (err) {
    const wrapped = new Error('cohere-rerank: response was not valid JSON');
    wrapped.code = 'cohere_rerank_invalid_response';
    wrapped.cause = err;
    throw wrapped;
  }

  return normalizeResults(parsed?.results, documents);
}

module.exports = {
  rerank,
  isAvailable,
  buildRequest,
  normalizeResults,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  MAX_DOC_CHARS,
};

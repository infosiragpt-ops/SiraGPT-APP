'use strict';

/**
 * embedding-provider — the single embedding entry point for RAG and memory.
 *
 * Why: production ran on ONE key (OpenAI). When that key was rejected (401)
 * every embed() threw, retrieval aborted before its lexical ranker, memory
 * silently stopped and nothing surfaced in /api/health. This module makes
 * embeddings a ladder with the same discipline as the chat failover:
 *
 *   OpenAI text-embedding-3-small  (native 1536; `dimensions` for 1024)
 *   Gemini gemini-embedding-001     (outputDimensionality 1536/1024 + L2 norm)
 *   Voyage voyage-3-large           (1024 only — memory tables)
 *   Jina   jina-embeddings-v3       (1024 only — memory tables)
 *   Mistral mistral-embed           (1024 only — memory tables)
 *
 * Rules that keep the vector spaces sane:
 *  - A provider whose key was rejected is memoised (provider-key-health) and
 *    skipped without a round-trip until the key changes or the TTL expires.
 *  - Each vector carries a SPACE id `provider:model:dim`. The first space that
 *    serves a target dimension in this process becomes sticky for that
 *    dimension, so a flapping provider cannot interleave two spaces in one
 *    index. If the sticky space is unavailable the caller decides: RAG falls
 *    back to BM25-only (rag-service), memory skips the semantic pass.
 *  - Output is ALWAYS exactly `targetDim` floats per input, 1:1 with inputs
 *    (ingest's length guard depends on it); anything else throws.
 *  - Failures are never cached; results are cached per (space, text).
 */

const crypto = require('node:crypto');
const keyHealth = require('../utils/provider-key-health');

// Placeholder keys (CI dummies, templates) never reach the network. The
// OpenAI rung is exempt on purpose: it goes through the `openai` SDK, which
// offline suites stub with fake keys, and a genuinely bad key is caught by
// the rejection memo after one 401 anyway.
const PLACEHOLDER_KEY_RE = /dummy|not-used|ci-dummy|test-key|^your_|^sk-xxx|^changeme$/i;
const PLACEHOLDER_EXEMPT = new Set(['openai']);
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_ORDER = ['openai', 'gemini', 'voyage', 'jina', 'mistral'];

const PROVIDERS = Object.freeze({
  openai: {
    keys: ['OPENAI_API_KEY'],
    model: (env) => env.SIRAGPT_EMBED_MODEL_OPENAI || 'text-embedding-3-small',
    dims: [1536, 1024, 512, 256],
    maxBatch: 128,
    call: embedOpenAI,
  },
  gemini: {
    keys: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_AI_API_KEY'],
    model: (env) => env.SIRAGPT_EMBED_MODEL_GEMINI || 'gemini-embedding-001',
    dims: [3072, 1536, 1024, 768, 512, 256],
    maxBatch: 100,
    call: embedGemini,
  },
  voyage: {
    keys: ['VOYAGE_API_KEY'],
    model: (env) => env.SIRAGPT_EMBED_MODEL_VOYAGE || 'voyage-3-large',
    dims: [1024, 512, 256],
    maxBatch: 128,
    call: embedVoyage,
  },
  jina: {
    keys: ['JINA_API_KEY'],
    model: (env) => env.SIRAGPT_EMBED_MODEL_JINA || 'jina-embeddings-v3',
    dims: [1024, 512, 256],
    maxBatch: 128,
    call: embedJina,
  },
  mistral: {
    keys: ['MISTRAL_API_KEY'],
    model: (env) => env.SIRAGPT_EMBED_MODEL_MISTRAL || 'mistral-embed',
    dims: [1024],
    maxBatch: 128,
    call: embedMistral,
  },
});

// Sticky space per target dimension: { space, provider, model, since }.
const activeSpace = new Map();
const failures = new Map(); // provider → { count, lastAt, lastMessage }
const stats = { requests: 0, vectors: 0, errors: 0, byProvider: Object.create(null) };

function keyFor(name, env = process.env) {
  const spec = PROVIDERS[name];
  if (!spec) return '';
  for (const k of spec.keys) {
    const v = String(env[k] || '').trim();
    if (v && (PLACEHOLDER_EXEMPT.has(name) || !PLACEHOLDER_KEY_RE.test(v))) return v;
  }
  return '';
}

function providerOrder(env = process.env) {
  const raw = String(env.SIRAGPT_EMBED_PROVIDER_ORDER || '').trim();
  const list = raw ? raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => PROVIDERS[s]) : [];
  return list.length ? list : DEFAULT_ORDER;
}

function spaceId(provider, model, dim) {
  return `${provider}:${model}:${dim}`;
}

/** Providers able to serve `targetDim` with a usable, non-rejected key, in ladder order. */
function candidates(targetDim, env = process.env) {
  const out = [];
  for (const name of providerOrder(env)) {
    const spec = PROVIDERS[name];
    if (!spec || !spec.dims.includes(targetDim)) continue;
    const key = keyFor(name, env);
    if (!key) continue;
    const model = spec.model(env);
    out.push({ name, model, key, rejected: keyHealth.isRejected(name, key), space: spaceId(name, model, targetDim) });
  }
  return out;
}

function isAvailable(targetDim = 1536, env = process.env) {
  return candidates(targetDim, env).some((c) => !c.rejected);
}

function timeoutMs(env = process.env) {
  const n = Number(env.SIRA_EMBED_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_TIMEOUT_MS;
}

async function fetchJson(url, { method = 'POST', headers = {}, body, signal, fetchImpl, timeout } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout || DEFAULT_TIMEOUT_MS);
  const onAbort = () => ac.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await doFetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: ac.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
    if (!res.ok) {
      const err = new Error(`${res.status} ${(json && (json.error?.message || json.message || json.detail)) || res.statusText || 'embedding request failed'}`.slice(0, 300));
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function l2normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (!norm || !Number.isFinite(norm)) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) out[i] = vec[i] / norm;
  return out;
}

function toVectors(list, targetDim, provider) {
  const out = [];
  for (const raw of list) {
    if (!Array.isArray(raw) && !(raw instanceof Float32Array)) throw new Error(`${provider}: embedding missing in response`);
    if (raw.length !== targetDim) throw new Error(`${provider}: expected ${targetDim} dims, got ${raw.length}`);
    out.push(raw instanceof Float32Array ? raw : Float32Array.from(raw));
  }
  return out;
}

// ── Provider calls (each returns Float32Array[] of exactly targetDim) ───────

const openaiClients = new Map(); // key fingerprint → SDK client
function openaiClientFor(key, env) {
  const fp = keyHealth.fingerprint(key);
  if (openaiClients.has(fp)) return openaiClients.get(fp);
  // The official SDK (offline tests stub `openai`): bounded timeout, its own
  // idempotent retry, optional base URL.
  // eslint-disable-next-line global-require
  const OpenAI = require('openai');
  const client = new OpenAI({
    apiKey: key,
    timeout: timeoutMs(env),
    maxRetries: Number.parseInt(env.SIRA_EMBED_MAX_RETRIES || '2', 10),
    ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}),
  });
  openaiClients.set(fp, client);
  return client;
}

async function embedOpenAI({ texts, key, model, targetDim, env, signal, openaiClient }) {
  // Callers that own a configured SDK client (rag-service) hand it over so a
  // single client — and its test seams — serves every OpenAI embedding.
  const client = (openaiClient && openaiClient.embeddings) ? openaiClient : openaiClientFor(key, env);
  const body = { model, input: texts };
  if (targetDim !== 1536) body.dimensions = targetDim;
  const resp = await client.embeddings.create(body, signal ? { signal } : undefined);
  const rows = Array.isArray(resp && resp.data) ? resp.data.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : [];
  if (rows.length !== texts.length) throw new Error(`openai: embed returned ${rows.length} vectors for ${texts.length} chunks`);
  const vecs = rows.map((r) => r.embedding);
  // Native 1536 requests keep the pre-ladder laxness (offline stubs return
  // short vectors); explicit `dimensions` requests are checked strictly.
  if (targetDim === 1536) return vecs.map((v) => (v instanceof Float32Array ? v : Float32Array.from(v)));
  return toVectors(vecs, targetDim, 'openai');
}

async function embedGemini({ texts, key, model, targetDim, env, fetchImpl, signal, taskType }) {
  const base = String(env.GEMINI_EMBED_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const modelPath = `models/${model.replace(/^models\//, '')}`;
  const body = {
    requests: texts.map((t) => ({
      model: modelPath,
      content: { parts: [{ text: String(t) }] },
      outputDimensionality: targetDim,
      ...(taskType ? { taskType } : {}),
    })),
  };
  const json = await fetchJson(`${base}/${modelPath}:batchEmbedContents`, { headers: { 'x-goog-api-key': key }, body, signal, fetchImpl, timeout: timeoutMs(env) });
  const rows = Array.isArray(json && json.embeddings) ? json.embeddings : [];
  if (rows.length !== texts.length) throw new Error(`gemini: embed returned ${rows.length} vectors for ${texts.length} chunks`);
  // Gemini only guarantees unit length at 3072 dims; truncated (Matryoshka)
  // outputs must be re-normalised or cosine scores are wrong.
  return toVectors(rows.map((r) => r.values), targetDim, 'gemini').map(l2normalize);
}

async function embedVoyage({ texts, key, model, targetDim, env, fetchImpl, signal, inputType }) {
  const json = await fetchJson('https://api.voyageai.com/v1/embeddings', { headers: { Authorization: `Bearer ${key}` }, body: { model, input: texts, input_type: inputType || 'document', output_dimension: targetDim }, signal, fetchImpl, timeout: timeoutMs(env) });
  const rows = Array.isArray(json && json.data) ? json.data : [];
  if (rows.length !== texts.length) throw new Error(`voyage: embed returned ${rows.length} vectors for ${texts.length} chunks`);
  return toVectors(rows.map((r) => r.embedding), targetDim, 'voyage');
}

async function embedJina({ texts, key, model, targetDim, env, fetchImpl, signal }) {
  const json = await fetchJson('https://api.jina.ai/v1/embeddings', { headers: { Authorization: `Bearer ${key}` }, body: { model, input: texts, dimensions: targetDim }, signal, fetchImpl, timeout: timeoutMs(env) });
  const rows = Array.isArray(json && json.data) ? json.data : [];
  if (rows.length !== texts.length) throw new Error(`jina: embed returned ${rows.length} vectors for ${texts.length} chunks`);
  return toVectors(rows.map((r) => r.embedding), targetDim, 'jina');
}

async function embedMistral({ texts, key, model, targetDim, env, fetchImpl, signal }) {
  const json = await fetchJson('https://api.mistral.ai/v1/embeddings', { headers: { Authorization: `Bearer ${key}` }, body: { model, input: texts }, signal, fetchImpl, timeout: timeoutMs(env) });
  const rows = Array.isArray(json && json.data) ? json.data.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : [];
  if (rows.length !== texts.length) throw new Error(`mistral: embed returned ${rows.length} vectors for ${texts.length} chunks`);
  return toVectors(rows.map((r) => r.embedding), targetDim, 'mistral');
}

// ── Cache (per space + text; never caches failures) ────────────────────────
const CACHE_MAX = (() => { const n = Number(process.env.SIRA_EMBED_CACHE_MAX); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2000; })();
const cache = new Map();
const cacheStats = { hits: 0, misses: 0 };

function cacheKey(space, text) {
  return crypto.createHash('sha256').update(space).update('\0').update(String(text)).digest('hex');
}

function cacheGet(space, text) {
  const k = cacheKey(space, text);
  const hit = cache.get(k);
  if (!hit) { cacheStats.misses += 1; return null; }
  cache.delete(k); cache.set(k, hit); cacheStats.hits += 1;
  return hit;
}

function cacheSet(space, text, vec) {
  while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(cacheKey(space, text), vec);
}

function bump(provider, field) {
  const b = stats.byProvider[provider] || (stats.byProvider[provider] = { requests: 0, vectors: 0, errors: 0, rejected: 0 });
  b[field] += 1;
}

function metric(name, labels) {
  try {
    // eslint-disable-next-line global-require
    const m = require('../utils/metrics');
    if (typeof m.counter === 'function') m.counter(name, labels, 1);
  } catch { /* metrics optional */ }
}

class EmbeddingUnavailableError extends Error {
  constructor(message, { targetDim, tried = [] } = {}) {
    super(message);
    this.name = 'EmbeddingUnavailableError';
    this.code = 'EMBEDDING_UNAVAILABLE';
    this.targetDim = targetDim;
    this.tried = tried;
  }
}

/**
 * Embed `texts` into exactly `targetDim` floats each.
 * @param {string[]} texts
 * @param {object} [opts]
 * @param {number} [opts.targetDim=1536]
 * @param {string} [opts.space]  require this exact space (e.g. the space an index was built with); no substitution.
 * @param {boolean} [opts.sticky=true]  keep using the space that first served this dimension.
 * @param {string} [opts.taskType] Gemini task type; @param {string} [opts.inputType] Voyage input type.
 * @returns {Promise<Float32Array[]>}
 */
async function embed(texts, { targetDim = 1536, space = null, sticky = true, env = process.env, fetchImpl, signal, taskType, inputType, useCache = true, openaiClient = null } = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const list = candidates(targetDim, env);
  const wantSpace = space || (sticky && activeSpace.get(targetDim) ? activeSpace.get(targetDim).space : null);
  let ordered = list;
  if (wantSpace) {
    const exact = list.filter((c) => c.space === wantSpace);
    ordered = space ? exact : [...exact, ...list.filter((c) => c.space !== wantSpace)];
  }
  const usable = ordered.filter((c) => !c.rejected);
  if (!usable.length) {
    stats.errors += 1;
    throw new EmbeddingUnavailableError(
      `no embedding provider available for ${targetDim} dims (${list.length ? list.map((c) => `${c.name}${c.rejected ? ':key-rejected' : ''}`).join(', ') : 'no keys configured'})`,
      { targetDim, tried: list.map((c) => c.name) },
    );
  }
  const tried = [];
  const errors = [];
  let lastErr = null;
  for (const c of usable) {
    const spec = PROVIDERS[c.name];
    const out = new Array(texts.length);
    const missIdx = [];
    if (useCache) {
      for (let i = 0; i < texts.length; i += 1) {
        const hit = cacheGet(c.space, texts[i]);
        if (hit) out[i] = hit; else missIdx.push(i);
      }
    } else {
      for (let i = 0; i < texts.length; i += 1) missIdx.push(i);
    }
    try {
      for (let i = 0; i < missIdx.length; i += spec.maxBatch) {
        const idx = missIdx.slice(i, i + spec.maxBatch);
        stats.requests += 1; bump(c.name, 'requests');
        const vecs = await spec.call({ texts: idx.map((j) => texts[j]), key: c.key, model: c.model, targetDim, env, fetchImpl, signal, taskType, inputType, openaiClient });
        for (let j = 0; j < idx.length; j += 1) {
          out[idx[j]] = vecs[j];
          if (useCache) cacheSet(c.space, texts[idx[j]], vecs[j]);
        }
        stats.vectors += vecs.length; bump(c.name, 'vectors');
      }
      if (sticky && !activeSpace.has(targetDim)) activeSpace.set(targetDim, { space: c.space, provider: c.name, model: c.model, since: Date.now() });
      if (sticky && activeSpace.get(targetDim) && activeSpace.get(targetDim).space !== c.space) {
        // A different space served this call: record the switch so operators can see it.
        activeSpace.set(targetDim, { space: c.space, provider: c.name, model: c.model, since: Date.now(), switchedFrom: activeSpace.get(targetDim).space });
        metric('siragpt_embedding_space_switch_total', { dim: String(targetDim) });
      }
      metric('siragpt_embedding_requests_total', { provider: c.name, outcome: 'ok' });
      return out;
    } catch (err) {
      lastErr = err;
      stats.errors += 1; bump(c.name, 'errors');
      tried.push(c.name);
      errors.push(`${c.name}: ${String((err && err.message) || err).slice(0, 200)}`);
      if (signal && signal.aborted) throw err;
      if (keyHealth.isInvalidKeyError(err)) {
        keyHealth.markRejected(c.name, c.key, err, env);
        bump(c.name, 'rejected');
        metric('siragpt_embedding_requests_total', { provider: c.name, outcome: 'key_rejected' });
        console.warn(`[embedding-provider] ${c.name} rejected the API key (${err.status || ''}); memoised, trying the next provider`);
      } else {
        failures.set(c.name, { count: ((failures.get(c.name) || {}).count || 0) + 1, lastAt: Date.now(), lastMessage: String(err.message || '').slice(0, 160) });
        metric('siragpt_embedding_requests_total', { provider: c.name, outcome: 'error' });
        console.warn(`[embedding-provider] ${c.name} failed (${String(err.message || err).slice(0, 120)}); trying the next provider`);
      }
      if (space) break; // exact space demanded: never substitute
    }
  }
  const e = new EmbeddingUnavailableError(`every embedding provider failed for ${targetDim} dims: ${errors.length ? errors.join('; ') : (lastErr && lastErr.message)}`, { targetDim, tried });
  e.cause = lastErr;
  throw e;
}

function currentSpace(targetDim = 1536) {
  const a = activeSpace.get(targetDim);
  return a ? a.space : null;
}

/**
 * The space the next embed() will most likely land in: the sticky one when
 * set, else the first usable rung. Stable before AND after the first call, so
 * callers can key caches on it without a miss on the second lookup.
 */
function expectedSpace(targetDim = 1536, env = process.env) {
  const sticky = currentSpace(targetDim);
  if (sticky) return sticky;
  const first = candidates(targetDim, env).find((c) => !c.rejected);
  return first ? first.space : null;
}

function status(env = process.env) {
  const dims = [1536, 1024];
  const out = { providers: {}, spaces: {}, cache: { size: cache.size, ...cacheStats }, stats, rejected: keyHealth.snapshot() };
  for (const name of providerOrder(env)) {
    const key = keyFor(name, env);
    out.providers[name] = {
      configured: Boolean(key),
      rejected: key ? keyHealth.isRejected(name, key) : false,
      model: PROVIDERS[name].model(env),
      dims: PROVIDERS[name].dims,
      failures: failures.get(name) || null,
    };
  }
  for (const d of dims) {
    out.spaces[d] = { active: activeSpace.get(d) || null, available: candidates(d, env).filter((c) => !c.rejected).map((c) => c.name) };
  }
  return out;
}

function resetForTests() {
  activeSpace.clear(); failures.clear(); cache.clear(); openaiClients.clear();
  cacheStats.hits = 0; cacheStats.misses = 0;
  stats.requests = 0; stats.vectors = 0; stats.errors = 0; stats.byProvider = Object.create(null);
  keyHealth.clear();
}

module.exports = {
  PROVIDERS,
  DEFAULT_ORDER,
  EmbeddingUnavailableError,
  embed,
  candidates,
  isAvailable,
  expectedSpace,
  currentSpace,
  providerOrder,
  spaceId,
  status,
  l2normalize,
  resetForTests,
  _internal: { keyFor, fetchJson, toVectors, cacheKey },
};

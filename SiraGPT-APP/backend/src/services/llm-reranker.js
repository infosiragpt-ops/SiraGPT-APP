/**
 * llm-reranker — listwise cross-encoder reranking via an LLM judge.
 *
 * Cosine similarity is cheap and recall-friendly but it's a bag-of-meaning
 * score: two chunks can look equally similar to the query vector while
 * one actually answers the question and the other just shares vocabulary.
 * A reranker runs a *second*, more expensive scoring pass over the top-N
 * candidates from retrieval and reorders them.
 *
 * Design:
 *   - Listwise: all candidates go in one prompt so the model can compare.
 *     Cheaper and more consistent than scoring pairs one-by-one.
 *   - JSON-mode response with `rankings: [{passage_number, score}]`.
 *   - Unranked candidates fall back to `unrankedFallbackScore` so they
 *     stay in the tail rather than vanishing.
 *   - In-process cache keyed by (query + candidate-ids hash) with TTL,
 *     so repeated turns in the same chat don't pay the rerank cost twice.
 *   - Hard skip when candidates.length < minChunksToRerank (no point
 *     reranking 2 items, just let cosine order them).
 *
 * Pattern reference: Iliagpt.io server/rag/reranking/LLMReranker.ts,
 * simplified to the core listwise path (no RetrievedChunk typing, no
 * feedback learning, no batch splitting — add back if we see queries
 * that overflow the model's context).
 */

const crypto = require('crypto');

const DEFAULT_CONFIG = {
  model: process.env.RAG_RERANK_MODEL || 'gpt-4o-mini',
  maxChunksPerBatch: 20,
  minChunksToRerank: 3,
  unrankedFallbackScore: 0.1,
  cacheTtlMs: 10 * 60 * 1000,
  temperature: 0.1,
  snippetMax: 400,
};

const CACHE_MAX = 200;
const CACHE_MAX_AGE_MS = DEFAULT_CONFIG.cacheTtlMs;

// quick-lru@7 is ESM-only; the backend is CommonJS, so we lazy-load via
// dynamic import the first time the cache is touched. Subsequent calls
// reuse the same instance. quick-lru gives us a hard maxSize (200) plus
// per-entry maxAge (10 minutes) so the cache no longer needs the manual
// two-phase eviction sweep that used to live here.
let _cachePromise = null;
function getCacheInstance() {
  if (!_cachePromise) {
    _cachePromise = import('quick-lru').then(({ default: QuickLRU }) =>
      new QuickLRU({ maxSize: CACHE_MAX, maxAge: CACHE_MAX_AGE_MS })
    );
  }
  return _cachePromise;
}

function cacheKey(query, ids) {
  const payload = `${query}:${[...ids].sort().join(',')}`;
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 20);
}

async function getCached(key) {
  const cache = await getCacheInstance();
  const scores = cache.get(key);
  return scores ?? null;
}

async function setCache(key, scores) {
  const cache = await getCacheInstance();
  cache.set(key, scores);
}

function buildPrompt(query, candidates, snippetMax) {
  const passages = candidates
    .map((c, i) => {
      const text = (c.text || '').slice(0, snippetMax).replace(/\n+/g, ' ');
      return `[${i + 1}] ${text}`;
    })
    .join('\n\n');

  return `You rank text passages by relevance to a user query.

QUERY: ${query}

PASSAGES:
${passages}

Return STRICT JSON:
{"rankings":[{"passage_number":<1..N>,"score":<0.0-1.0>}]}

Rules:
- Include EVERY passage exactly once.
- 1.0 = perfectly answers the query, 0.0 = irrelevant.
- Return valid JSON only, no prose.`;
}

/**
 * Parse the JSON response and return a Map<passageIndex0Based, score>.
 * Defensive: the model sometimes wraps the JSON in markdown fences or
 * adds a leading sentence; we grab the outer-most `{...}` and try that.
 */
function parseResponse(raw, count) {
  const scores = new Map();
  if (!raw) return scores;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*"rankings"[\s\S]*\}/);
    if (!match) return scores;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return scores;
    }
  }

  const rankings = Array.isArray(parsed?.rankings) ? parsed.rankings : [];
  for (const r of rankings) {
    const n = Number(r?.passage_number);
    const s = Number(r?.score);
    if (!Number.isInteger(n) || n < 1 || n > count) continue;
    if (!Number.isFinite(s)) continue;
    scores.set(n - 1, Math.max(0, Math.min(1, s)));
  }
  return scores;
}

/**
 * Rerank a list of candidate chunks for a query.
 *
 * @param {object} openai — OpenAI client (the same `getOpenAI()` instance
 *   used elsewhere works). If null, we skip gracefully and return input
 *   sorted by original score — reranking must never hard-fail retrieval.
 * @param {string} query
 * @param {Array<{text: string, score: number, ...}>} candidates
 * @param {object} [opts] — partial override of DEFAULT_CONFIG + `k` for
 *   how many to return. Unknown fields ignored.
 * @returns {Promise<Array>} reranked candidates, most relevant first.
 */
async function rerank(openai, query, candidates, opts = {}) {
  const config = { ...DEFAULT_CONFIG, ...opts };
  const { k = candidates.length } = opts;

  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  if (candidates.length < config.minChunksToRerank) {
    return [...candidates].sort((a, b) => b.score - a.score).slice(0, k);
  }
  if (!openai) {
    return [...candidates].sort((a, b) => b.score - a.score).slice(0, k);
  }

  // Only the top-maxChunksPerBatch candidates go to the LLM (token cost
  // cap). The tail is preserved — we append it behind the reranked head
  // with unrankedFallbackScore. Previously the tail was silently dropped,
  // so a caller passing 30 candidates with maxChunksPerBatch=20 lost 10.
  const pool = candidates.slice(0, config.maxChunksPerBatch);
  const tail = candidates.slice(config.maxChunksPerBatch);
  const ids = pool.map((_, i) => String(i));
  const key = cacheKey(query, ids);

  let scores = await getCached(key);
  if (!scores) {
    try {
      const resp = await openai.chat.completions.create({
        model: config.model,
        temperature: config.temperature,
        max_tokens: 800,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a concise relevance ranker. Output JSON only.' },
          { role: 'user', content: buildPrompt(query, pool, config.snippetMax) },
        ],
      });
      const raw = resp.choices?.[0]?.message?.content || '';
      scores = parseResponse(raw, pool.length);
      await setCache(key, scores);
    } catch (err) {
      // Never let a reranker error break retrieval — fall back to cosine order.
      console.warn('[llm-reranker] call failed, falling back to original order:', err.message);
      return [...candidates].sort((a, b) => b.score - a.score).slice(0, k);
    }
  }

  const reranked = pool
    .map((c, i) => ({ ...c, rerankScore: scores.get(i) ?? config.unrankedFallbackScore }))
    .sort((a, b) => b.rerankScore - a.rerankScore);

  // Append the untouched tail (below maxChunksPerBatch) behind the reranked
  // head, preserving original relative order. Give each a fallback score so
  // mixed-pool downstream callers see a consistent shape.
  const tailAnnotated = tail.map(c => ({ ...c, rerankScore: config.unrankedFallbackScore }));
  return reranked.concat(tailAnnotated).slice(0, k);
}

async function clearCache() {
  const cache = await getCacheInstance();
  cache.clear();
}

async function cacheSize() {
  const cache = await getCacheInstance();
  return cache.size;
}

module.exports = {
  rerank,
  clearCache,
  cacheSize,
  DEFAULT_CONFIG,
  CACHE_MAX,
  // exported for tests
  buildPrompt,
  parseResponse,
  cacheKey,
};

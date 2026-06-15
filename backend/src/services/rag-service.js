/**
 * rag-service — retrieval-augmented generation primitives.
 *
 * Storage is delegated to rag-store.js: in-memory by default, or
 * pgvector-backed when USE_PG_STORE=1 and the migration is applied.
 * Retrieval still scores chunks in-process by cosine similarity and
 * returns the top-K; the persistence cutover is about durability and
 * multi-instance correctness, not a rewrite of ranking semantics.
 *
 * The service exposes three primitives:
 *   - chunk(text, {size, overlap}) — token-approximate splitter
 *   - embed(texts)                  — OpenAI text-embedding-3-small
 *   - ingest(userId, collection, docs[])  — embed + store
 *   - retrieve(userId, collection, query, k) — top-K cosine hits
 *   - clear(userId, collection)
 *
 * Why a pluggable shape (and not pgvector logic inline): callers should
 * not care whether chunks live in RAM or Postgres. Keeping the API
 * surface narrow (ingest / retrieve / clear) lets the durability layer
 * evolve without rewriting routes, agents, or chat flows.
 */

// `openai` is lazy-required inside getOpenAI() so callers that never touch
// embeddings (e.g. orchestration boot) don't pull in the SDK at module load.
let OpenAI = null;
function loadOpenAI() {
  if (OpenAI) return OpenAI;
  // eslint-disable-next-line global-require
  const mod = require('openai');
  OpenAI = mod.OpenAI || mod.default || mod;
  return OpenAI;
}

const { mmrRerank } = require('./mmr');
const { expandQuery } = require('./query-expansion');
const llmReranker = require('./llm-reranker');
const bm25 = require('./bm25');
const codeChunker = require('./code-chunker');
const tripleGraph = require('./triple-graph');
const tripleExtractor = require('./triple-extractor');
const { diverseTripleBeamSearch, flattenBeamsBFS } = require('./diverse-beam-search');
const gistMemory = require('./gist-memory');
const { runWithLock } = require('./agents/mutex');
const ragStore = require('./rag-store');

const EMBED_MODEL = 'text-embedding-3-small';   // 1536-dim, cheap, good
const EMBED_DIM = 1536;
const DEFAULT_CHUNK_SIZE = 1200;                 // approx tokens (~4 chars each)
const DEFAULT_CHUNK_OVERLAP = 200;
const MAX_COLLECTION_CHUNKS = Number.parseInt(process.env.SIRAGPT_RAG_MAX_CHUNKS || '10000', 10); // safety cap per (user, collection)

// When query expansion is enabled we run *two* embeddings (original + expanded)
// and take the max-similarity across both as each chunk's relevance. The
// over-fetch multiplier ensures we pull enough candidates before reranking
// so the downstream reranker/MMR has real choice, not just the top-K again.
const OVERFETCH_MULTIPLIER = 3;
const OVERFETCH_FLOOR = 12;
const OVERFETCH_CEILING = 40;
const RETRIEVAL_TRACE_SCHEMA_VERSION = 'sira.rag_retrieval_trace.v1';
const RETRIEVAL_HIT_DIAGNOSTICS_SCHEMA_VERSION = 'sira.rag_hit_diagnostics.v1';

function storeKey(userId, collection) {
  return `${userId || 'anon'}:${collection || 'default'}`;
}

/**
 * Token-approximate chunker: splits on paragraph / sentence
 * boundaries, then re-joins into windows of roughly `size` characters
 * (≈ tokens × 4) with `overlap` characters of trailing context.
 *
 * Not character-perfect — it intentionally prefers semantic boundaries
 * so a chunk doesn't cut mid-sentence when a paragraph happens to fit.
 */
function chunk(text, { size = DEFAULT_CHUNK_SIZE * 4, overlap = DEFAULT_CHUNK_OVERLAP * 4 } = {}) {
  if (!text || typeof text !== 'string') return [];
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length === 0) return [];
  if (normalized.length <= size) return [normalized];

  // Split on paragraph breaks, then on sentence breaks, to get atomic
  // pieces we can greedily glue into windows.
  const atoms = normalized
    .split(/\n{2,}/)
    .flatMap(p => p.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ])/))
    .map(s => s.trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';
  for (const atom of atoms) {
    if ((current + ' ' + atom).length > size && current.length > 0) {
      chunks.push(current.trim());
      // Start the next window with the trailing `overlap` chars of
      // the previous — keeps context across boundaries.
      current = current.length > overlap ? current.slice(-overlap) + ' ' + atom : atom;
    } else {
      current = current.length === 0 ? atom : current + ' ' + atom;
    }
  }
  if (current.trim().length > 0) chunks.push(current.trim());

  // Safety: if a single atom is larger than `size` (e.g. a wall of text
  // with no punctuation), hard-split it so embeddings don't choke.
  return chunks.flatMap(c => {
    if (c.length <= size * 1.3) return [c];
    const pieces = [];
    for (let i = 0; i < c.length; i += size - overlap) {
      pieces.push(c.slice(i, i + size));
    }
    return pieces;
  });
}

let openaiClient = null;
// embed() is on both the document-ingest and query-retrieval hot paths. The
// OpenAI SDK defaults to a 10-MINUTE request timeout, so a single hung call
// could stall RAG for that long. Bound it (SIRA_EMBED_TIMEOUT_MS, default 30s)
// and keep the SDK's built-in idempotent retry (embeddings are idempotent).
function _embedClientOptions() {
  return {
    apiKey: process.env.OPENAI_API_KEY,
    timeout: Number.parseInt(process.env.SIRA_EMBED_TIMEOUT_MS || '30000', 10),
    maxRetries: Number.parseInt(process.env.SIRA_EMBED_MAX_RETRIES || '2', 10),
  };
}
function getOpenAI() {
  if (openaiClient) return openaiClient;
  if (!process.env.OPENAI_API_KEY) return null;
  const OpenAIClient = loadOpenAI();
  openaiClient = new OpenAIClient(_embedClientOptions());
  return openaiClient;
}

/**
 * Embed an array of strings. Returns parallel array of Float32 vectors.
 * Batches large inputs so we stay under OpenAI's per-request limit.
 *
 * Under SIRA_RELIABILITY_WIRINGS=1, concurrent identical embed() calls
 * are coalesced via single-flight so a popular chunk hitting N callers
 * simultaneously (during ingest spikes or RAG retrieval bursts) only
 * makes ONE upstream embeddings request. Default OFF — production
 * behavior is identical to pre-flag main.
 */
async function _embedRaw(texts) {
  const openai = getOpenAI();
  if (!openai) throw new Error('OPENAI_API_KEY not configured — RAG embed() unavailable');

  const BATCH = 96; // well under OpenAI's 2048-input ceiling
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const resp = await openai.embeddings.create({ model: EMBED_MODEL, input: slice });
    for (const d of resp.data) {
      // Float32Array is ~4× smaller than a JS number[] — matters when
      // a user ingests hundreds of chunks into memory.
      out.push(Float32Array.from(d.embedding));
    }
  }
  return out;
}

async function embed(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  if (process.env.SIRA_RELIABILITY_WIRINGS === '1' || process.env.SIRA_RELIABILITY_WIRINGS === 'true') {
    try {
      const { getSingleFlight } = require('../cache/single-flight');
      const { argsHash } = require('./agents/speculative-executor');
      const key = `embed:${argsHash(texts)}`;
      return await getSingleFlight().do(key, () => _embedRaw(texts));
    } catch {
      return _embedRaw(texts);
    }
  }
  return _embedRaw(texts);
}

/**
 * Cosine similarity between two Float32 vectors. Assumes same length —
 * OpenAI embeddings always are, so we skip the defensive check.
 */
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) {
    const av = a[i], bv = b[i];
    dot += av * bv;
    na  += av * av;
    nb  += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Ingest documents into a (user, collection) namespace. Each doc is
 * `{ text, source?, title? }`; it's chunked, embedded, and appended.
 * Returns `{ chunksAdded, totalChunks }`.
 */
async function ingest(userId, collection, docs, opts = {}) {
  if (!Array.isArray(docs) || docs.length === 0) return { chunksAdded: 0, totalChunks: 0 };

  // Contextual Retrieval (Anthropic, Sept 2024). When opts.useContextualChunking
  // is true AND opts.anthropic is provided, each chunk is enriched with a
  // 50–100-token context block generated against the FULL document via
  // Claude Haiku with prompt caching. The enriched string is what we
  // embed AND store under `text`, so both cosine retrieval and the
  // downstream LLM benefit from the contextual prefix. Failed chunks
  // fall back to their original text — the per-chunk failures[] from
  // contextualizeChunks is surfaced on the return envelope for telemetry.
  const useContextual = !!opts.useContextualChunking && opts.anthropic;
  const contextualFailures = [];
  const contextualUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  // Chunking and embedding are pure / API-bounded — no shared state, safe
  // outside the lock. We only hold the lock across the read-modify-write
  // of `store` itself, where a concurrent ingester could otherwise see
  // a stale `existing` and clobber each other.
  const allChunks = [];
  for (const d of docs) {
    if (!d || typeof d.text !== 'string') continue;
    const pieces = chunk(d.text, opts);
    if (pieces.length === 0) continue;

    if (useContextual) {
      const contextual = require('./rag/contextual-chunking');
      const ctxResult = await contextual.contextualizeChunks({
        document: d.text,
        chunks: pieces,
        anthropic: opts.anthropic,
        options: opts.contextualOptions || {},
      });
      for (const f of ctxResult.failures) contextualFailures.push(f);
      contextualUsage.input_tokens += ctxResult.usage.input_tokens;
      contextualUsage.output_tokens += ctxResult.usage.output_tokens;
      contextualUsage.cache_read_input_tokens += ctxResult.usage.cache_read_input_tokens;
      contextualUsage.cache_creation_input_tokens += ctxResult.usage.cache_creation_input_tokens;
      for (let i = 0; i < pieces.length; i++) {
        const enriched = ctxResult.contextualized[i] || pieces[i];
        allChunks.push({ text: enriched, source: d.source || null, title: d.title || null });
      }
    } else {
      for (const p of pieces) {
        allChunks.push({ text: p, source: d.source || null, title: d.title || null });
      }
    }
  }
  if (allChunks.length === 0) return { chunksAdded: 0, totalChunks: 0 };

  const vectors = await embed(allChunks.map(c => c.text));
  // Guard: embed() must return exactly one vector per chunk. A partial response
  // would leave later chunks with `embedding: undefined`, which corrupts every
  // future retrieval (cosine over undefined). Fail loudly so the caller marks
  // indexing as failed / retries instead of silently storing broken chunks.
  if (!Array.isArray(vectors) || vectors.length !== allChunks.length) {
    throw new Error(`rag embed returned ${Array.isArray(vectors) ? vectors.length : 'a non-array'} vectors for ${allChunks.length} chunk(s)`);
  }
  const key = storeKey(userId, collection);

  return runWithLock(`rag:${key}`, async () => {
    await ragStore.appendChunks(
      userId,
      collection,
      allChunks.map((c, i) => ({ ...c, embedding: vectors[i] })),
    );
    const { totalChunks } = await evictAndCleanOrphans(userId, collection);
    const result = { chunksAdded: allChunks.length, totalChunks };
    if (useContextual) {
      result.contextualized = true;
      result.contextualFailures = contextualFailures;
      result.contextualUsage = contextualUsage;
    }
    return result;
  });
}

/**
 * Oldest-wins eviction with triple-graph cleanup.
 *
 * When a collection exceeds MAX_COLLECTION_CHUNKS we drop the oldest
 * chunks. Those chunks may have contributed source identifiers that
 * the triple graph indexed; if no surviving chunk carries the same
 * source, the graph's triples for that source become orphans —
 * retrieval still returns them, but passageLink then fails to find a
 * backing chunk. This helper does the eviction AND scrubs the graph
 * for any source that no longer has a chunk in the collection.
 *
 * Returns `{ removed, removedSources, totalChunks }`.
 */
async function evictAndCleanOrphans(userId, collection) {
  const trimmed = await ragStore.trim(userId, collection, MAX_COLLECTION_CHUNKS);
  if (trimmed.removedSources.length > 0) {
    // Lazy-require to avoid the circular dep reversing on us.
    const tg = require('./triple-graph');
    for (const src of trimmed.removedSources) {
      tg.clearSource(userId, collection, src);
    }
  }
  const stats = await ragStore.stats(userId, collection);
  return { ...trimmed, totalChunks: stats.chunks };
}

/**
 * Retrieve the top-K most similar chunks for a query.
 * Returns `[{ text, source, title, score }]` sorted descending by score.
 *
 * Options (all opt-in, defaults match legacy cosine-only behaviour):
 *   - useExpansion: boolean — embed the original query AND a keyword-
 *     expanded variant, take max cosine across both. Boosts recall on
 *     conversational queries.
 *   - useMMR: boolean — reshuffle top results for diversity (λ=0.7).
 *     Use when the caller needs breadth, e.g. "everything about X".
 *   - mmrLambda: number — override λ (0..1). 1 = pure relevance,
 *     0 = pure diversity.
 *   - rerank: boolean — run the LLM reranker on the over-fetched pool
 *     before returning top-K. Most expensive, biggest quality lift.
 *   - rerankOpenAI: OpenAI client instance — required if `rerank` is
 *     true. We don't wire the internal client because callers may want
 *     to reuse their own instance / key.
 *   - overfetchK: number — how many to retrieve before reranking.
 *     Default: max(k * 3, 12), capped at 40.
 */
async function retrieve(userId, collection, query, k = 5, opts = {}) {
  if (!query || typeof query !== 'string') return [];
  const startedAt = Date.now();
  const key = storeKey(userId, collection);
  const entries = await ragStore.getAll(userId, collection);
  if (!entries || entries.length === 0) return [];

  const {
    useExpansion = false,
    useMMR = false,
    mmrLambda = 0.7,
    rerank = false,
    rerankOpenAI = null,
    // Cohere Rerank 3.5 cross-encoder (added 2026-05). Drop-in
    // replacement for the LLM reranker: ~10× cheaper, 4-6× lower
    // latency, comparable nDCG@10 — see services/rag/cohere-rerank.js
    // header. Activated by setting useCohereRerank=true; requires
    // COHERE_API_KEY in env. Composable with `rerank` (LLM judge
    // first, cross-encoder second) but most callers should pick one.
    useCohereRerank = false,
    cohereRerankModel,        // override services/rag/cohere-rerank DEFAULT_MODEL
    overfetchK,
    useHybrid = false,
    rrfK = 60,
    hybridWeights = { semantic: 1.0, bm25: 1.0 },
    // GEAR / SyncGE (Shen et al., ACL 2025) ─────────────────────────
    // When useGraph is true, we:
    //   1. base-retrieve (hybrid or cosine) → C'_q
    //   2. LLM reads top-N passages to extract proximal triples T'_q
    //   3. triple-graph.linkTriple() maps each T'_q → initial stored triple
    //   4. Diverse Triple Beam Search expands the graph
    //   5. flatten + map triples → source passages → C̃_q
    //   6. RRF(C̃_q, C'_q) → final C_q
    // The caller must have ingested triples into triple-graph ahead of
    // time (see ingestTriples / /api/rag/ingest-triples). If the graph
    // is empty for this namespace we silently skip and return the base
    // retrieval.
    useGraph = false,
    graphOpenAI = null,    // OpenAI client used for proximal extraction
    graphBeamSize = 4,
    graphLength = 3,
    graphGamma = 2,
    graphProximalN = 5,    // how many base-retrieved passages feed the LLM read step
    sessionId = null,      // optional: enables gist memory across turns
    includeDiagnostics = false,
    __traceCollector = null,
  } = opts;

  // Overfetch a pool to feed downstream MMR/reranker/RRF with real choice.
  // When all post-processing is off, we still cap the pool at k to match
  // the old behaviour byte-for-byte.
  const needsPool = useMMR || rerank || useCohereRerank || useHybrid;
  const poolSize = needsPool
    ? (overfetchK || Math.max(k * OVERFETCH_MULTIPLIER, OVERFETCH_FLOOR))
    : k;
  const cappedPool = Math.min(poolSize, OVERFETCH_CEILING, entries.length);

  // Embed the query once, and optionally the keyword-expanded variant
  // once more. Max-similarity fusion keeps it a single cosine pass per
  // chunk — we don't blend scores, we take the winner.
  const toEmbed = [query];
  let expansionKeywords = [];
  if (useExpansion) {
    const { expanded, keywords } = expandQuery(query);
    expansionKeywords = keywords;
    if (keywords.length > 0 && expanded !== query) toEmbed.push(expanded);
  }
  const queryVecs = await embed(toEmbed);

  const scored = entries.map((e, idx) => {
    let best = -Infinity;
    for (const qv of queryVecs) {
      const s = cosine(qv, e.embedding);
      if (s > best) best = s;
    }
    return {
      _idx: idx,
      text: e.text,
      source: e.source,
      title: e.title,
      score: best,
      vectorScore: best,
      textScore: 0,
      fusionScore: best,
      retrievalMode: 'semantic',
    };
  });
  scored.sort((a, b) => b.score - a.score);
  scored.forEach((s, rank) => {
    s.semanticRank = rank + 1;
  });

  let pool;

  if (useHybrid) {
    // Build a BM25 ranking over ALL entries (not just the semantic pool),
    // then fuse both rankings via Reciprocal Rank Fusion:
    //   RRF(d) = Σ_rankers  w / (rrfK + rank_ranker(d))
    // RRF is score-agnostic: it only cares about each ranker's position,
    // so we don't need to normalise BM25 raw scores against cosine.
    // Previously: `entries.map(e => ({ text: e.text, _idx: entries.indexOf(e) }))`
    // which is O(n²) per retrieve. Carry the index positionally instead.
    const bmIndex = bm25.buildIndex(entries.map((e, idx) => ({ text: e.text, _idx: idx })));
    const bmHits = bm25.searchIndex(bmIndex, query, { k: entries.length });

    const fused = new Map(); // _idx → { scored-like, fusedScore }
    const wSem = hybridWeights.semantic ?? 1.0;
    const wBm = hybridWeights.bm25 ?? 1.0;

    // Rank from semantic (scored is already sorted desc by cosine).
    scored.forEach((s, rank) => {
      fused.set(s._idx, {
        ...s,
        score: s.score,
        semanticRank: rank + 1,
        textRank: null,
        vectorScore: s.vectorScore,
        textScore: 0,
        fusedScore: wSem / (rrfK + (rank + 1)),
        fusionScore: wSem / (rrfK + (rank + 1)),
        retrievalMode: 'hybrid_rrf',
      });
    });
    // Add BM25 ranks.
    bmHits.forEach((h, rank) => {
      const idx = h.doc._idx;
      const existing = fused.get(idx);
      const contrib = wBm / (rrfK + (rank + 1));
      if (existing) {
        existing.textRank = rank + 1;
        existing.textScore = h.score;
        existing.fusedScore += contrib;
        existing.fusionScore = existing.fusedScore;
      } else {
        const entry = entries[idx];
        fused.set(idx, {
          _idx: idx,
          text: entry.text,
          source: entry.source,
          title: entry.title,
          score: 0,
          semanticRank: null,
          textRank: rank + 1,
          vectorScore: 0,
          textScore: h.score,
          fusedScore: contrib,
          fusionScore: contrib,
          retrievalMode: 'hybrid_rrf',
        });
      }
    });

    pool = [...fused.values()]
      .sort((a, b) => b.fusedScore - a.fusedScore)
      .slice(0, Math.max(1, cappedPool))
      // Surface the fusion score as `score` so downstream MMR/reranker
      // see a unified metric.
      .map(e => ({ ...e, score: e.fusedScore, fusionScore: e.fusedScore }));
  } else {
    pool = scored.slice(0, Math.max(1, cappedPool));
  }

  if (rerank) {
    // Reranker may drop candidates below its cutoff — we still honour k.
    pool = await llmReranker.rerank(rerankOpenAI, query, pool, { k: pool.length });
  }

  if (useCohereRerank && pool.length > 1) {
    // Cohere Rerank 3.5 cross-encoder pass. Documents are pulled from
    // the chunk.text field; on success we reorder the pool by Cohere's
    // relevance_score and write that score into chunk.rerankScore so
    // downstream MMR / diagnostics can still see it. On failure we
    // swallow the error — a degraded ranker is better than a 5xx for
    // the whole retrieve call.
    try {
      const cohereRerank = require('./rag/cohere-rerank');
      const ranked = await cohereRerank.rerank({
        query,
        documents: pool.map((p) => p.text || ''),
        topN: pool.length,
        model: cohereRerankModel,
      });
      if (Array.isArray(ranked) && ranked.length > 0) {
        const byIndex = new Map(ranked.map((r) => [r.index, r]));
        // Stable rebuild: preserve any pool entries not mentioned by
        // Cohere (defensive — shouldn't happen since topN === pool.length)
        // by placing them at the end in original order.
        const next = [];
        for (const r of ranked) {
          const original = pool[r.index];
          if (!original) continue;
          next.push({ ...original, rerankScore: r.score, cohereScore: r.score });
        }
        for (let i = 0; i < pool.length; i++) {
          if (!byIndex.has(i)) next.push(pool[i]);
        }
        pool = next;
      }
    } catch (err) {
      // Surface in diagnostics if requested; otherwise log once.
      if (typeof console.warn === 'function') {
        console.warn('[rag-service] cohere rerank failed, falling back to prior ranking:', err && err.message);
      }
    }
  }

  if (useGraph) {
    // SyncGE / GEAR single-step retrieval (Shen et al., ACL 2025, §4).
    // Only runs when the triple graph for this namespace is non-empty;
    // otherwise this is a no-op and the base pool passes through.
    const graphStats = tripleGraph.stats(userId, collection);
    if (graphStats.triples > 0) {
      try {
        const graphPassages = await expandWithGraph({
          userId, collection, query, basePool: pool, entries,
          openai: graphOpenAI || getOpenAI(),
          proximalN: graphProximalN, beamSize: graphBeamSize,
          length: graphLength, gamma: graphGamma,
          sessionId, rrfK,
        });
        if (graphPassages.length > 0) {
          // Fuse the base pool and the graph-derived pool via RRF.
          pool = fuseByRRF(pool, graphPassages, { rrfK, k: pool.length });
        }
      } catch (err) {
        // Graph expansion must never break base retrieval.
        console.warn('[rag] SyncGE expansion failed, returning base pool:', err.message);
      }
    }
  }

  if (useMMR) {
    pool = mmrRerank(pool, { lambda: mmrLambda, k: Math.max(1, k) });
  }

  // Attribution rerank — opt-in final pass that boosts hits whose text
  // overlaps with the query's detected concepts + named entities. Cheap
  // (< 5 ms on a typical pool); gated by useAttributionRerank in opts.
  if (opts.useAttributionRerank) {
    try {
      const attrReranker = require('./attribution-rag-reranker');
      const reranked = attrReranker.rerank({
        prompt: query,
        snippets: pool,
        weight: Number.isFinite(opts.attributionRerankWeight) ? Number(opts.attributionRerankWeight) : undefined,
        max: pool.length,
      });
      // Preserve original pool item references — rerank() wraps each
      // candidate, so unwrap and keep the order.
      pool = reranked.map((r) => r.original);
    } catch (_attrErr) { /* swallow — degrades to existing order */ }
  }

  const hits = pool
    .slice(0, Math.max(1, k))
    .map(hit => formatRetrievalHit(hit, { includeDiagnostics }));

  if (__traceCollector && typeof __traceCollector === 'object') {
    Object.assign(__traceCollector, buildRetrievalTrace({
      collection,
      query,
      requestedK: k,
      returnedK: hits.length,
      totalEntries: entries.length,
      cappedPool,
      queryVariants: toEmbed.length,
      expansionKeywords,
      useExpansion,
      useHybrid,
      useMMR,
      mmrLambda,
      rerank,
      useGraph,
      graphStats: useGraph ? tripleGraph.stats(userId, collection) : null,
      rrfK,
      hybridWeights,
      latencyMs: Date.now() - startedAt,
    }));
  }

  return hits;
}

async function retrieveWithTrace(userId, collection, query, k = 5, opts = {}) {
  const trace = {};
  const hits = await retrieve(userId, collection, query, k, {
    ...opts,
    includeDiagnostics: true,
    __traceCollector: trace,
  });
  if (!trace.schema_version) {
    const current = await ragStore.stats(userId, collection).catch(() => ({ chunks: 0 }));
    Object.assign(trace, buildRetrievalTrace({
      collection,
      query,
      requestedK: k,
      returnedK: hits.length,
      totalEntries: current?.chunks || 0,
      cappedPool: 0,
      queryVariants: query ? 1 : 0,
      expansionKeywords: [],
      useExpansion: Boolean(opts.useExpansion),
      useHybrid: Boolean(opts.useHybrid),
      useMMR: Boolean(opts.useMMR),
      mmrLambda: opts.mmrLambda ?? 0.7,
      rerank: Boolean(opts.rerank),
      useGraph: Boolean(opts.useGraph),
      graphStats: null,
      rrfK: opts.rrfK ?? 60,
      hybridWeights: opts.hybridWeights || { semantic: 1, bm25: 1 },
      latencyMs: 0,
    }));
  }
  return { hits, trace };
}

function buildRetrievalTrace({
  collection,
  query,
  requestedK,
  returnedK,
  totalEntries,
  cappedPool,
  queryVariants,
  expansionKeywords,
  useExpansion,
  useHybrid,
  useMMR,
  mmrLambda,
  rerank,
  useGraph,
  graphStats,
  rrfK,
  hybridWeights,
  latencyMs,
}) {
  return {
    schema_version: RETRIEVAL_TRACE_SCHEMA_VERSION,
    collection: collection || 'default',
    query,
    mode: useHybrid ? 'hybrid_rrf' : 'semantic',
    requested_k: requestedK,
    returned_k: returnedK,
    candidates: {
      total: totalEntries,
      overfetch_pool: cappedPool,
    },
    expansion: {
      enabled: Boolean(useExpansion),
      query_variants: queryVariants,
      keywords: Array.isArray(expansionKeywords) ? expansionKeywords.slice(0, 12) : [],
    },
    scoring: {
      vector: true,
      text: Boolean(useHybrid),
      fusion: useHybrid ? 'reciprocal_rank_fusion' : 'none',
      rrf_k: rrfK,
      weights: {
        semantic: Number(hybridWeights?.semantic ?? 1),
        bm25: Number(hybridWeights?.bm25 ?? 1),
      },
    },
    postprocessors: {
      mmr: Boolean(useMMR),
      mmr_lambda: Number(mmrLambda),
      rerank: Boolean(rerank),
      graph: Boolean(useGraph),
      graph_triples: graphStats?.triples || 0,
    },
    latency_ms: Math.max(0, Number(latencyMs) || 0),
  };
}

function formatRetrievalHit(hit, { includeDiagnostics = false } = {}) {
  const {
    _idx,
    semanticRank,
    semRank,
    textRank,
    bmRank,
    fusedScore,
    vectorScore,
    textScore,
    fusionScore,
    graphRank,
    rerankScore,
    retrievalMode,
    ...rest
  } = hit || {};

  const out = {
    ...rest,
    score: roundScore(rest.score),
  };

  if (includeDiagnostics) {
    out.diagnostics = {
      schema_version: RETRIEVAL_HIT_DIAGNOSTICS_SCHEMA_VERSION,
      mode: retrievalMode || (fusedScore != null ? 'hybrid_rrf' : 'semantic'),
      vectorScore: roundScore(vectorScore ?? rest.score ?? 0),
      textScore: roundScore(textScore ?? 0),
      fusionScore: roundScore(fusionScore ?? fusedScore ?? rest.score ?? 0),
      semanticRank: semanticRank ?? semRank ?? null,
      textRank: textRank ?? bmRank ?? null,
      graphRank: graphRank ?? null,
      rerankScore: typeof rerankScore === 'number' ? roundScore(rerankScore) : null,
    };
  }

  return out;
}

function roundScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Internal helper: run the GEAR SyncGE pipeline and return an ordered
 * list of passages derived from the expanded triple sub-graph. Returns
 * `[]` if any step produces nothing usable (so the caller can fall back
 * to the base pool).
 */
async function expandWithGraph({
  userId, collection, query, basePool, entries,
  openai, proximalN, beamSize, length, gamma, sessionId,
}) {
  if (!openai) return [];

  // Step 1: LLM "read" over top-N base passages to pull proximal triples.
  // When we have gist memory for this session, pass it in so the LLM
  // produces complementary triples rather than repeats (Eq. 4 n≥2).
  const topPassages = basePool.slice(0, Math.max(1, proximalN));
  const prior = sessionId ? gistMemory.get(sessionId) : [];
  const proximal = await tripleExtractor.extractProximalTriples(openai, query, topPassages, {
    gistMemory: prior.length > 0 ? prior : null,
  });
  if (proximal.length === 0) return [];

  if (sessionId) gistMemory.append(sessionId, proximal);

  // Step 2: tripleLink — map each proximal triple to the closest stored triple.
  // Parallel to keep latency manageable; a handful of calls at most.
  const linked = await Promise.all(
    proximal.map(t => tripleGraph.linkTriple(userId, collection, t).catch(() => null))
  );
  const initialTriples = linked.filter(Boolean).map(x => x.triple);
  if (initialTriples.length === 0) return [];

  // Step 3: Diverse Triple Beam Search over the stored graph.
  // Score function = cosine(query, concatenated-triple-sentence).
  const queryVec = (await embed([query]))[0];
  const scoreCache = new Map();
  const scoreFn = async (sequence) => {
    const sentence = sequence.map(t => tripleGraph.tripleToSentence(t)).join(' ; ');
    if (scoreCache.has(sentence)) return scoreCache.get(sentence);
    const [v] = await embed([sentence]);
    const s = cosine(queryVec, v);
    scoreCache.set(sentence, s);
    return s;
  };
  const neighbourFn = (last, visitedKeys) =>
    tripleGraph.getNeighbours(userId, collection, last, { excludeKeys: visitedKeys });
  const tripleKeyFn = (t) => tripleGraph.tripleKey(t);

  const beams = await diverseTripleBeamSearch({
    initialTriples,
    neighbourFn,
    scoreFn,
    tripleKeyFn,
    b: beamSize,
    l: length,
    gamma,
  });
  if (beams.length === 0) return [];

  // Step 4: flatten BFS and map each triple back to its source chunk.
  const flatTriples = flattenBeamsBFS(beams, tripleKeyFn);

  // Build a source → first-occurrence-rank map so duplicate chunk refs
  // keep the best (earliest) rank.
  const sourceRank = new Map();
  flatTriples.forEach((t, rank) => {
    const src = t.source;
    if (!src) return;
    if (!sourceRank.has(src)) sourceRank.set(src, rank + 1);
  });
  if (sourceRank.size === 0) return [];

  // Map sources back to chunk objects. Build source → first-index map
  // once (O(E)) then look up from the rank map (O(S·log S) at worst).
  // Previously this was `entries.find(...)` + `entries.indexOf(...)` per
  // source — O(E·S) on every graph-expanded retrieve.
  const sourceToIdx = new Map();
  for (let i = 0; i < entries.length; i++) {
    const src = entries[i].source;
    if (src && !sourceToIdx.has(src)) sourceToIdx.set(src, i);
  }

  const out = [];
  for (const [src, rank] of sourceRank) {
    const idx = sourceToIdx.get(src);
    if (idx === undefined) continue;
    const entry = entries[idx];
    out.push({
      _idx: idx,
      text: entry.text,
      source: entry.source,
      title: entry.title,
      score: 1 / rank,
      graphRank: rank,
    });
  }
  return out;
}

/**
 * Reciprocal Rank Fusion of two already-ranked pools. Used to combine
 * base retrieval output with the GEAR graph-expanded list (Eq. 3 in
 * the paper). Returns a new array sorted by fused score.
 */
function fuseByRRF(poolA, poolB, { rrfK = 60, k = Infinity } = {}) {
  const fused = new Map(); // identity → accumulator
  // Identity preference:
  //   1. _idx — unambiguous when both pools came from the same entries array.
  //   2. source + full-text hash — collision-free across distinct chunks.
  //   3. full-text hash — last-resort when neither _idx nor source available.
  // The previous "first 40 chars" fallback merged distinct chunks whose
  // first 40 chars happened to match (very common in code).
  const textHash = (s) => {
    if (!s) return '0';
    // Fast non-crypto string hash (djb2 variant). Good enough for identity.
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };
  const id = (e) => {
    if (e._idx != null) return `idx:${e._idx}`;
    const t = textHash(e.text || '');
    return e.source ? `src:${e.source}|${t}` : `tx:${t}`;
  };

  const addRankings = (pool) => {
    pool.forEach((e, rank) => {
      const key = id(e);
      const contrib = 1 / (rrfK + rank + 1);
      const existing = fused.get(key);
      if (existing) existing.fusedScore += contrib;
      else fused.set(key, { ...e, fusedScore: contrib });
    });
  };
  addRankings(poolA);
  addRankings(poolB);

  return [...fused.values()]
    .sort((a, b) => b.fusedScore - a.fusedScore)
    .slice(0, k)
    .map(e => ({ ...e, score: e.fusedScore }));
}

/**
 * passageLink (GEAR §5.4 Eq. 8) — given a proximal triple from the
 * final gist memory, return the top-k passages most similar to the
 * triple's natural-language form. Uses the same retrieve() plumbing as
 * normal query retrieval (hybrid on + graph off so we don't recurse).
 */
async function passageLink(userId, collection, triple, { k = 5 } = {}) {
  if (!triple || !triple.subject || !triple.predicate || !triple.object) return [];
  const sentence = `${triple.subject} ${triple.predicate} ${triple.object}`.replace(/\s+/g, ' ').trim();
  if (!sentence) return [];
  return retrieve(userId, collection, sentence, k, {
    // Cosine-only here: triple sentences are ~3-5 tokens after BM25's
    // stop-word filter, and BM25's IDF math penalises short queries.
    // Semantic similarity over the full embedding space does a better
    // job matching a triple like "Stephen Curry plays for Warriors" to
    // a passage about Curry's team, even when the exact token "plays"
    // doesn't appear in the chunk.
    useHybrid: false,
    // No graph expansion — we're already operating on graph output,
    // recursing would blow up without new information.
    useGraph: false,
  });
}

/**
 * finalFuseGEAR (§5.4 Eq. 9) — fuse the per-iteration retrieved pools
 * C_q^(1)...C_q^(n) with the per-triple linked pools C_t1...C_t|G| via
 * Reciprocal Rank Fusion. Each pool contributes 1/(k + rank + 1) to
 * every doc it contains; duplicates across pools accumulate.
 *
 * This is the final step of the agent loop — the return value is the
 * ranked passage list that callers hand to the downstream LLM.
 */
function finalFuseGEAR({ perIterPools = [], tripleLinkedPools = [], k = 10, rrfK = 60 }) {
  const fused = new Map();
  const textHash = (s) => {
    if (!s) return '0';
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };
  const id = (e) => {
    if (e._idx != null) return `idx:${e._idx}`;
    const t = textHash(e.text || '');
    return e.source ? `src:${e.source}|${t}` : `tx:${t}`;
  };

  const add = (pool) => {
    if (!Array.isArray(pool)) return;
    pool.forEach((e, rank) => {
      const key = id(e);
      const contrib = 1 / (rrfK + rank + 1);
      const existing = fused.get(key);
      if (existing) existing.fusedScore += contrib;
      else fused.set(key, { ...e, fusedScore: contrib });
    });
  };
  for (const p of perIterPools) add(p);
  for (const p of tripleLinkedPools) add(p);

  return [...fused.values()]
    .sort((a, b) => b.fusedScore - a.fusedScore)
    .slice(0, k)
    .map(({ _idx, fusedScore, ...rest }) => ({ ...rest, score: fusedScore }));
}

/**
 * Ingest source code files with AST-lite chunking.
 *
 * Each file is `{ filename, content, language? }`. Chunks are split on
 * function/class boundaries when the language is recognised, otherwise
 * a line-sliding-window fallback kicks in. Each resulting chunk carries
 * `source` (filename), `title` (a "filename:startLine-endLine (nodeType
 * name)" label), and a `meta` blob with language/nodeType/name flags
 * that downstream callers (citation engine) can use.
 */
async function ingestCode(userId, collection, files, opts = {}) {
  if (!Array.isArray(files) || files.length === 0) return { chunksAdded: 0, totalChunks: 0 };

  const allChunks = [];
  for (const f of files) {
    if (!f || typeof f.content !== 'string') continue;
    const pieces = codeChunker.chunkCode(f.filename, f.content, { language: f.language, ...opts });
    for (const p of pieces) {
      const label = p.name
        ? `${f.filename || 'code'}:${p.startLine}-${p.endLine} (${p.nodeType} ${p.name})`
        : `${f.filename || 'code'}:${p.startLine}-${p.endLine}`;
      allChunks.push({
        text: p.text,
        source: f.filename || null,
        title: label,
        meta: {
          language: p.language,
          nodeType: p.nodeType,
          name: p.name,
          startLine: p.startLine,
          endLine: p.endLine,
          isExported: p.isExported,
          isAsync: p.isAsync,
        },
      });
    }
  }
  if (allChunks.length === 0) return { chunksAdded: 0, totalChunks: 0 };

  const vectors = await embed(allChunks.map(c => c.text));
  // Guard: embed() must return exactly one vector per chunk. A partial response
  // would leave later chunks with `embedding: undefined`, which corrupts every
  // future retrieval (cosine over undefined). Fail loudly so the caller marks
  // indexing as failed / retries instead of silently storing broken chunks.
  if (!Array.isArray(vectors) || vectors.length !== allChunks.length) {
    throw new Error(`rag embed returned ${Array.isArray(vectors) ? vectors.length : 'a non-array'} vectors for ${allChunks.length} chunk(s)`);
  }
  const key = storeKey(userId, collection);

  return runWithLock(`rag:${key}`, async () => {
    await ragStore.appendChunks(
      userId,
      collection,
      allChunks.map((c, i) => ({ ...c, embedding: vectors[i] })),
    );
    const { totalChunks } = await evictAndCleanOrphans(userId, collection);
    return { chunksAdded: allChunks.length, totalChunks };
  });
}

/**
 * Populate the triple graph for GEAR retrieval.
 *
 * For each existing chunk in `(userId, collection)` (or all chunks when
 * `sources` is not supplied), run the LLM triple extractor and write
 * the results into triple-graph.js keyed by the same namespace. Each
 * triple's `source` field points back to the chunk's source identifier
 * so retrieval can map triples → passages later.
 *
 * Returns `{ chunksScanned, triplesAdded, totalTriples }`.
 *
 * If `openai` is null we use the heuristic extractor — mostly useful for
 * tests and dev flows without API keys. Production should pass the
 * shared OpenAI client so triple quality is comparable to the paper's.
 */
async function ingestTriples(userId, collection, { openai = null, sources = null, model = 'gpt-4o-mini' } = {}) {
  const entries = await ragStore.getAll(userId, collection);
  if (entries.length === 0) return { chunksScanned: 0, triplesAdded: 0, totalTriples: 0 };

  const filter = Array.isArray(sources) && sources.length > 0 ? new Set(sources) : null;
  const targets = filter ? entries.filter(e => filter.has(e.source)) : entries;

  let triplesAdded = 0;
  for (const entry of targets) {
    const triples = openai
      ? await tripleExtractor.extractTriples(openai, entry.text, { source: entry.source, model })
      : tripleExtractor.extractTriplesHeuristic(entry.text, { source: entry.source });
    if (triples.length === 0) continue;
    const result = await tripleGraph.addTriples(userId, collection, triples, {
      embedder: openai ? null : async () => [], // skip embeddings in heuristic/no-key mode
    });
    triplesAdded += result.added;
  }

  return {
    chunksScanned: targets.length,
    triplesAdded,
    totalTriples: tripleGraph.stats(userId, collection).triples,
  };
}

/**
 * Enumerate distinct source identifiers in a collection.
 *
 * Iterates the in-memory store directly, so unlike `retrieve("list files")`
 * this is:
 *   - Deterministic — the same collection returns the same set every time.
 *   - Complete — no file ingested into the collection is missed due to
 *     semantic ranking.
 *   - Cheap — no embedding call, no LLM call.
 *
 * Returns `[{ source, title, chunks, preview, firstSeen }]` sorted by
 * source for stable output.
 */
async function listSources(userId, collection) {
  return ragStore.listSources(userId, collection);
}

/**
 * Fetch every chunk belonging to a given source, in insertion order.
 * Returns `[{ text, source, title, meta? }]` (no embedding field). The
 * order mirrors ingest order — for code this means chunks come out
 * roughly by line number because code-chunker emits them top-down.
 *
 * Returns [] when the source doesn't exist in the collection.
 */
async function getBySource(userId, collection, source) {
  if (!source) return [];
  const entries = await ragStore.getBySource(userId, collection, source);
  return entries.map(({ embedding, ...rest }) => rest);
}

async function clear(userId, collection) {
  await ragStore.clearCollection(userId, collection);
  tripleGraph.clear(userId, collection);
}

async function stats(userId, collection) {
  const current = await ragStore.stats(userId, collection);
  return {
    chunks: current?.chunks || 0,
    sources: current?.sources || 0,
    dim: current?.dim || EMBED_DIM,
  };
}

module.exports = {
  chunk,
  embed,
  ingest,
  ingestCode,
  ingestTriples,
  retrieve,
  retrieveWithTrace,
  listSources,
  getBySource,
  clear,
  stats,
  cosine,        // exported for tests
  getOpenAI,     // exported so callers can pass the shared client to rerank
  _embedClientOptions, // exported for tests
  // exported for tests / advanced callers
  fuseByRRF,
  expandWithGraph,
  passageLink,
  finalFuseGEAR,
  buildRetrievalTrace,
  formatRetrievalHit,
  EMBED_MODEL,
  EMBED_DIM,
};

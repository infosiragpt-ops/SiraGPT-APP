/**
 * rag-service — retrieval-augmented generation primitives.
 *
 * Today's implementation is deliberately in-memory: a Map keyed by
 * (userId, collection) holding an array of { text, embedding, meta }
 * chunks. Retrieval scores every chunk by cosine similarity and
 * returns the top-K. That's enough to validate the product shape and
 * to integrate RAG into the chat flow without waiting on DB migrations.
 *
 * The service exposes three primitives:
 *   - chunk(text, {size, overlap}) — token-approximate splitter
 *   - embed(texts)                  — OpenAI text-embedding-3-small
 *   - ingest(userId, collection, docs[])  — embed + store
 *   - retrieve(userId, collection, query, k) — top-K cosine hits
 *   - clear(userId, collection)
 *
 * Why a pluggable shape (and not pgvector directly): production will
 * swap the in-memory store for pgvector or Qdrant. Keeping the API
 * surface narrow (ingest / retrieve / clear) means the swap is a
 * single file change, not a rewrite of the callers.
 *
 * Concretely: swap `store` below for a thin wrapper around
 * `prisma.$executeRaw` against a `documents_embeddings` pgvector
 * table. The callers (routes + ai-service) never see the difference.
 */

const OpenAI = require('openai');

const { mmrRerank } = require('./mmr');
const { expandQuery } = require('./query-expansion');
const llmReranker = require('./llm-reranker');
const bm25 = require('./bm25');
const codeChunker = require('./code-chunker');
const tripleGraph = require('./triple-graph');
const tripleExtractor = require('./triple-extractor');
const { diverseTripleBeamSearch, flattenBeamsBFS } = require('./diverse-beam-search');
const gistMemory = require('./gist-memory');

const EMBED_MODEL = 'text-embedding-3-small';   // 1536-dim, cheap, good
const EMBED_DIM = 1536;
const DEFAULT_CHUNK_SIZE = 1200;                 // approx tokens (~4 chars each)
const DEFAULT_CHUNK_OVERLAP = 200;
const MAX_COLLECTION_CHUNKS = 2000;              // safety cap per (user, collection)

// When query expansion is enabled we run *two* embeddings (original + expanded)
// and take the max-similarity across both as each chunk's relevance. The
// over-fetch multiplier ensures we pull enough candidates before reranking
// so the downstream reranker/MMR has real choice, not just the top-K again.
const OVERFETCH_MULTIPLIER = 3;
const OVERFETCH_FLOOR = 12;
const OVERFETCH_CEILING = 40;

const store = new Map(); // key = `${userId}:${collection}` → Array<Chunk>

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
function getOpenAI() {
  if (openaiClient) return openaiClient;
  if (!process.env.OPENAI_API_KEY) return null;
  openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiClient;
}

/**
 * Embed an array of strings. Returns parallel array of Float32 vectors.
 * Batches large inputs so we stay under OpenAI's per-request limit.
 */
async function embed(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
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

  const allChunks = [];
  for (const d of docs) {
    if (!d || typeof d.text !== 'string') continue;
    const pieces = chunk(d.text, opts);
    for (const p of pieces) {
      allChunks.push({ text: p, source: d.source || null, title: d.title || null });
    }
  }
  if (allChunks.length === 0) return { chunksAdded: 0, totalChunks: 0 };

  const vectors = await embed(allChunks.map(c => c.text));
  const key = storeKey(userId, collection);
  const existing = store.get(key) || [];

  const merged = existing.concat(allChunks.map((c, i) => ({ ...c, embedding: vectors[i] })));

  // Oldest-wins eviction keeps memory bounded if someone ingests a
  // whole book into one collection.
  const trimmed = merged.length > MAX_COLLECTION_CHUNKS
    ? merged.slice(merged.length - MAX_COLLECTION_CHUNKS)
    : merged;

  store.set(key, trimmed);
  return { chunksAdded: allChunks.length, totalChunks: trimmed.length };
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
  const key = storeKey(userId, collection);
  const entries = store.get(key);
  if (!entries || entries.length === 0) return [];

  const {
    useExpansion = false,
    useMMR = false,
    mmrLambda = 0.7,
    rerank = false,
    rerankOpenAI = null,
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
  } = opts;

  // Overfetch a pool to feed downstream MMR/reranker/RRF with real choice.
  // When all post-processing is off, we still cap the pool at k to match
  // the old behaviour byte-for-byte.
  const needsPool = useMMR || rerank || useHybrid;
  const poolSize = needsPool
    ? (overfetchK || Math.max(k * OVERFETCH_MULTIPLIER, OVERFETCH_FLOOR))
    : k;
  const cappedPool = Math.min(poolSize, OVERFETCH_CEILING, entries.length);

  // Embed the query once, and optionally the keyword-expanded variant
  // once more. Max-similarity fusion keeps it a single cosine pass per
  // chunk — we don't blend scores, we take the winner.
  const toEmbed = [query];
  if (useExpansion) {
    const { expanded, keywords } = expandQuery(query);
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
    };
  });
  scored.sort((a, b) => b.score - a.score);

  let pool;

  if (useHybrid) {
    // Build a BM25 ranking over ALL entries (not just the semantic pool),
    // then fuse both rankings via Reciprocal Rank Fusion:
    //   RRF(d) = Σ_rankers  w / (rrfK + rank_ranker(d))
    // RRF is score-agnostic: it only cares about each ranker's position,
    // so we don't need to normalise BM25 raw scores against cosine.
    const bmIndex = bm25.buildIndex(entries.map(e => ({ text: e.text, _idx: entries.indexOf(e) })));
    const bmHits = bm25.searchIndex(bmIndex, query, { k: entries.length });

    const fused = new Map(); // _idx → { scored-like, fusedScore }
    const wSem = hybridWeights.semantic ?? 1.0;
    const wBm = hybridWeights.bm25 ?? 1.0;

    // Rank from semantic (scored is already sorted desc by cosine).
    scored.forEach((s, rank) => {
      fused.set(s._idx, {
        ...s,
        score: s.score,
        semRank: rank + 1,
        bmRank: null,
        fusedScore: wSem / (rrfK + (rank + 1)),
      });
    });
    // Add BM25 ranks.
    bmHits.forEach((h, rank) => {
      const idx = h.doc._idx;
      const existing = fused.get(idx);
      const contrib = wBm / (rrfK + (rank + 1));
      if (existing) {
        existing.bmRank = rank + 1;
        existing.fusedScore += contrib;
      } else {
        const entry = entries[idx];
        fused.set(idx, {
          _idx: idx,
          text: entry.text,
          source: entry.source,
          title: entry.title,
          score: 0,
          semRank: null,
          bmRank: rank + 1,
          fusedScore: contrib,
        });
      }
    });

    pool = [...fused.values()]
      .sort((a, b) => b.fusedScore - a.fusedScore)
      .slice(0, Math.max(1, cappedPool))
      // Surface the fusion score as `score` so downstream MMR/reranker
      // see a unified metric.
      .map(e => ({ ...e, score: e.fusedScore }));
  } else {
    pool = scored.slice(0, Math.max(1, cappedPool));
  }

  if (rerank) {
    // Reranker may drop candidates below its cutoff — we still honour k.
    pool = await llmReranker.rerank(rerankOpenAI, query, pool, { k: pool.length });
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

  // Strip internal-only fields before returning.
  return pool.slice(0, Math.max(1, k)).map(({ _idx, semRank, bmRank, fusedScore, ...rest }) => rest);
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

  // Map sources back to chunk objects. `entries` is the full in-memory
  // collection — we find each chunk whose `source` matches. This is O(E·S)
  // but E is already capped at MAX_COLLECTION_CHUNKS; if that ever bites,
  // cache a `source → entryIdx` map on the store.
  const out = [];
  const seen = new Set();
  for (const [src, rank] of sourceRank) {
    const entry = entries.find(e => e.source === src);
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    out.push({ _idx: entries.indexOf(entry), text: entry.text, source: entry.source, title: entry.title, score: 1 / rank, graphRank: rank });
  }
  return out;
}

/**
 * Reciprocal Rank Fusion of two already-ranked pools. Used to combine
 * base retrieval output with the GEAR graph-expanded list (Eq. 3 in
 * the paper). Returns a new array sorted by fused score.
 */
function fuseByRRF(poolA, poolB, { rrfK = 60, k = Infinity } = {}) {
  const fused = new Map(); // identity (text slice) → accumulator
  const id = (e) => e._idx != null ? `idx:${e._idx}` : `src:${e.source || ''}|${(e.text || '').slice(0, 40)}`;

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
    useHybrid: true,
    // No graph expansion here — we're already operating on graph output,
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
  const id = (e) => e._idx != null ? `idx:${e._idx}` : `src:${e.source || ''}|${(e.text || '').slice(0, 40)}`;

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
  const key = storeKey(userId, collection);
  const existing = store.get(key) || [];

  const merged = existing.concat(allChunks.map((c, i) => ({ ...c, embedding: vectors[i] })));
  const trimmed = merged.length > MAX_COLLECTION_CHUNKS
    ? merged.slice(merged.length - MAX_COLLECTION_CHUNKS)
    : merged;

  store.set(key, trimmed);
  return { chunksAdded: allChunks.length, totalChunks: trimmed.length };
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
  const key = storeKey(userId, collection);
  const entries = store.get(key) || [];
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
function listSources(userId, collection) {
  const entries = store.get(storeKey(userId, collection)) || [];
  if (entries.length === 0) return [];
  const bySource = new Map();
  for (const e of entries) {
    const src = e.source || '(no-source)';
    let rec = bySource.get(src);
    if (!rec) {
      rec = {
        source: src,
        title: e.title || null,
        chunks: 0,
        preview: (e.text || '').slice(0, 120),
      };
      bySource.set(src, rec);
    }
    rec.chunks++;
  }
  return [...bySource.values()].sort((a, b) => String(a.source).localeCompare(String(b.source)));
}

/**
 * Fetch every chunk belonging to a given source, in insertion order.
 * Returns `[{ text, source, title, meta? }]` (no embedding field). The
 * order mirrors ingest order — for code this means chunks come out
 * roughly by line number because code-chunker emits them top-down.
 *
 * Returns [] when the source doesn't exist in the collection.
 */
function getBySource(userId, collection, source) {
  if (!source) return [];
  const entries = store.get(storeKey(userId, collection)) || [];
  const out = [];
  for (const e of entries) {
    if (e.source === source) {
      const { embedding, ...rest } = e;
      out.push(rest);
    }
  }
  return out;
}

function clear(userId, collection) {
  store.delete(storeKey(userId, collection));
  tripleGraph.clear(userId, collection);
}

function stats(userId, collection) {
  const entries = store.get(storeKey(userId, collection));
  return { chunks: entries ? entries.length : 0, dim: EMBED_DIM };
}

module.exports = {
  chunk,
  embed,
  ingest,
  ingestCode,
  ingestTriples,
  retrieve,
  listSources,
  getBySource,
  clear,
  stats,
  cosine,        // exported for tests
  getOpenAI,     // exported so callers can pass the shared client to rerank
  // exported for tests / advanced callers
  fuseByRRF,
  expandWithGraph,
  passageLink,
  finalFuseGEAR,
  EMBED_MODEL,
  EMBED_DIM,
};

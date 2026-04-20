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

const EMBED_MODEL = 'text-embedding-3-small';   // 1536-dim, cheap, good
const EMBED_DIM = 1536;
const DEFAULT_CHUNK_SIZE = 1200;                 // approx tokens (~4 chars each)
const DEFAULT_CHUNK_OVERLAP = 200;
const MAX_COLLECTION_CHUNKS = 2000;              // safety cap per (user, collection)

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
 */
async function retrieve(userId, collection, query, k = 5) {
  if (!query || typeof query !== 'string') return [];
  const key = storeKey(userId, collection);
  const entries = store.get(key);
  if (!entries || entries.length === 0) return [];

  const [qVec] = await embed([query]);
  const scored = entries.map(e => ({
    text: e.text,
    source: e.source,
    title: e.title,
    score: cosine(qVec, e.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, k));
}

function clear(userId, collection) {
  store.delete(storeKey(userId, collection));
}

function stats(userId, collection) {
  const entries = store.get(storeKey(userId, collection));
  return { chunks: entries ? entries.length : 0, dim: EMBED_DIM };
}

module.exports = {
  chunk,
  embed,
  ingest,
  retrieve,
  clear,
  stats,
  cosine,   // exported for tests
  EMBED_MODEL,
  EMBED_DIM,
};

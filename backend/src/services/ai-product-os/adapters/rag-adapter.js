/**
 * rag-adapter — contract for the "RAG y conocimiento" layer.
 *
 * Designed to bind cleanly to:
 *   - LlamaIndex   (data loaders, indexing, retrievers, query engines)
 *   - LangChain    (Document/Embeddings/VectorStore primitives)
 *   - Qdrant       (vector + hybrid + filter)
 *   - pgvector     (Postgres vector extension)
 *   - Weaviate     (semantic + hybrid search)
 *
 * Public methods:
 *
 *   ingest({ collection, documents, embedder })
 *     → indexes documents (caller supplies the embedder; embeddings
 *       are opaque to the adapter).
 *
 *   query({ collection, query, queryEmbedding?, topK, filter?, mode? })
 *     → returns ranked snippets with scores. mode = "dense" | "sparse"
 *       | "hybrid" (RRF). Falls back to deterministic token overlap
 *       in the stub.
 *
 *   delete({ collection, ids })
 *
 *   listCollections()
 *
 *   collectionInfo(collection)
 *
 * Pure JS, deterministic stub uses an in-memory bucket.
 */

const VENDORS = Object.freeze(["llamaindex", "langchain", "qdrant", "pgvector", "weaviate", "stub"]);
const MODES = Object.freeze(["dense", "sparse", "hybrid"]);

function createRagAdapter({ provider = null, vendor = "stub" } = {}) {
  if (!VENDORS.includes(vendor)) throw new Error(`rag-adapter: unknown vendor "${vendor}"`);
  const impl = provider || createStubProvider();
  validateProvider(impl);

  return {
    vendor,
    provider: impl,

    async ingest({ collection, documents, embedder = null } = {}) {
      if (!collection) throw new Error("rag-adapter.ingest: collection required");
      if (!Array.isArray(documents)) throw new Error("rag-adapter.ingest: documents must be array");
      return impl.ingest({ collection, documents, embedder });
    },
    async query({ collection, query, queryEmbedding = null, topK = 5, filter = null, mode = "hybrid" } = {}) {
      if (!collection) throw new Error("rag-adapter.query: collection required");
      if (!query) throw new Error("rag-adapter.query: query required");
      if (!MODES.includes(mode)) throw new Error(`rag-adapter.query: unknown mode "${mode}"`);
      const r = await impl.query({ collection, query, queryEmbedding, topK, filter, mode });
      if (!Array.isArray(r)) throw new Error("rag-adapter.query: provider must return an array");
      return r;
    },
    async delete({ collection, ids } = {}) {
      if (!collection || !Array.isArray(ids)) throw new Error("rag-adapter.delete: collection + ids required");
      return impl.delete({ collection, ids });
    },
    listCollections() { return impl.listCollections(); },
    collectionInfo(collection) { return impl.collectionInfo(collection); },

    capabilities() {
      return {
        vendor,
        supports_hybrid: Boolean(impl.supports_hybrid),
        supports_filter: Boolean(impl.supports_filter),
        supports_metadata: Boolean(impl.supports_metadata),
        supports_streaming_ingest: Boolean(impl.supports_streaming_ingest),
      };
    },
  };
}

function createConfiguredRagAdapter(options = {}) {
  const requested = options.vendor || process.env.AGENTIC_RAG_PROVIDER || "internal";
  if (requested === "llamaindex") {
    return createRagAdapter({ vendor: "llamaindex", provider: createLlamaIndexProvider(options) });
  }
  return createRagAdapter({ vendor: "stub", provider: createStubProvider() });
}

function validateProvider(p) {
  for (const m of ["ingest", "query", "delete", "listCollections", "collectionInfo"]) {
    if (typeof p[m] !== "function") throw new Error(`rag-adapter: provider missing ${m}()`);
  }
}

function createStubProvider() {
  const collections = new Map();   // name → [{ id, text, embedding, metadata }]

  return {
    supports_hybrid: true,
    supports_filter: true,
    supports_metadata: true,
    supports_streaming_ingest: false,

    async ingest({ collection, documents }) {
      if (!collections.has(collection)) collections.set(collection, []);
      const bucket = collections.get(collection);
      let added = 0;
      for (const d of documents) {
        if (!d || typeof d !== "object" || !d.id || typeof d.text !== "string") continue;
        const existing = bucket.findIndex(x => x.id === d.id);
        const item = { id: d.id, text: d.text, embedding: d.embedding || null, metadata: d.metadata || {} };
        if (existing >= 0) bucket[existing] = item;
        else { bucket.push(item); added += 1; }
      }
      return { collection, added, total: bucket.length };
    },

    async query({ collection, query, queryEmbedding, topK, filter, mode }) {
      const bucket = collections.get(collection) || [];
      const filtered = filter ? bucket.filter(b => matchesFilter(b.metadata, filter)) : bucket;
      const useDense = mode !== "sparse" && Array.isArray(queryEmbedding);
      const useSparse = mode !== "dense";
      const scored = filtered.map(b => {
        const dense = useDense && Array.isArray(b.embedding) && b.embedding.length === queryEmbedding.length
          ? cosineSimilarity(queryEmbedding, b.embedding) : 0;
        const sparse = useSparse ? tokenOverlap(query, b.text) : 0;
        const score = mode === "hybrid"
          ? rrf(dense, sparse)
          : (mode === "dense" ? dense : sparse);
        return {
          id: b.id,
          text: b.text,
          score: round3(score),
          vectorScore: round3(dense),
          textScore: round3(sparse),
          metadata: b.metadata,
        };
      }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
      return scored.slice(0, topK);
    },

    async delete({ collection, ids }) {
      const bucket = collections.get(collection);
      if (!bucket) return { collection, deleted: 0 };
      const before = bucket.length;
      collections.set(collection, bucket.filter(b => !ids.includes(b.id)));
      return { collection, deleted: before - collections.get(collection).length };
    },

    listCollections() {
      return [...collections.keys()].map(name => ({ name, size: collections.get(name).length }));
    },

    collectionInfo(collection) {
      const bucket = collections.get(collection);
      if (!bucket) return null;
      return { name: collection, size: bucket.length, has_embeddings: bucket.some(b => Array.isArray(b.embedding)) };
    },
  };
}

function createLlamaIndexProvider() {
  const fallback = createStubProvider();
  const documentsByCollection = new Map();
  let llamaindexMod = null;

  async function getLlamaIndex() {
    if (llamaindexMod) return llamaindexMod;
    llamaindexMod = await import("llamaindex");
    return llamaindexMod;
  }

  return {
    supports_hybrid: true,
    supports_filter: true,
    supports_metadata: true,
    supports_streaming_ingest: false,
    provider_kind: "llamaindex-safe",

    async ingest({ collection, documents, embedder }) {
      const mod = await getLlamaIndex();
      const Document = mod.Document;
      if (typeof Document !== "function") throw new Error("llamaindex provider: Document export unavailable");
      const llamaDocs = documents
        .filter((d) => d && d.id && typeof d.text === "string")
        .map((d) => new Document({ text: d.text, id_: d.id, metadata: d.metadata || {} }));
      documentsByCollection.set(collection, llamaDocs);
      return fallback.ingest({ collection, documents, embedder });
    },

    async query(args) {
      // The live LlamaIndex query engine requires configured embeddings/LLM
      // and may call external APIs. Keep production safe by default: store
      // canonical LlamaIndex Document objects, then rank locally unless the
      // caller explicitly wires a live provider later.
      await getLlamaIndex();
      return fallback.query(args);
    },

    delete(args) {
      return fallback.delete(args);
    },
    listCollections() {
      return fallback.listCollections();
    },
    collectionInfo(collection) {
      const info = fallback.collectionInfo(collection);
      if (!info) return null;
      return {
        ...info,
        provider: "llamaindex",
        llamaDocumentCount: documentsByCollection.get(collection)?.length || 0,
      };
    },
  };
}

function matchesFilter(metadata, filter) {
  if (!metadata || !filter) return true;
  for (const [k, v] of Object.entries(filter)) {
    if (metadata[k] !== v) return false;
  }
  return true;
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function tokenOverlap(query, text) {
  const q = new Set(String(query).toLowerCase().split(/\W+/).filter(t => t.length >= 3));
  const t = new Set(String(text).toLowerCase().split(/\W+/).filter(s => s.length >= 3));
  let inter = 0;
  for (const x of q) if (t.has(x)) inter += 1;
  const union = q.size + t.size - inter;
  return union === 0 ? 0 : inter / union;
}

function rrf(dense, sparse) {
  // Reciprocal rank fusion approximation when the inputs are similarity
  // scores (not ranks). Weighted blend keeps the values in [0,1].
  return Math.min(1, dense * 0.6 + sparse * 0.4);
}

function round3(n) { return Math.round(n * 1000) / 1000; }

module.exports = {
  createConfiguredRagAdapter,
  createLlamaIndexProvider,
  createRagAdapter,
  createStubProvider,
  VENDORS,
  MODES,
};

/**
 * memory-layer — multi-tier memory for the AI Product OS.
 *
 * Tiers:
 *   - short_term     : current conversation turns (rolling window)
 *   - long_term      : per-user durable facts (preferences, profile)
 *   - file           : metadata + extracted text of uploaded files
 *   - semantic       : embedding-indexed snippets for retrieval
 *   - knowledge_graph: typed entity → entity edges
 *
 * The semantic tier stores embeddings opaquely. We do NOT compute
 * embeddings here (the caller injects them). When no embeddings are
 * available, semantic search falls back to a deterministic
 * BM25-lite token overlap so tests run without network.
 *
 * Storage is pluggable. The default is a process-local in-memory
 * adapter; a caller can pass a custom adapter that talks to Qdrant /
 * pgvector / Weaviate / Postgres.
 *
 * Pure JS, deterministic, zero deps.
 */

const SHORT_TERM_DEFAULT_WINDOW = 20;
const STOP = new Set([
  "the", "a", "an", "of", "to", "in", "on", "at", "for", "by", "with",
  "and", "or", "but", "as", "is", "are", "was", "were", "be", "been",
  "this", "that", "these", "those", "it", "its", "their", "from",
  "el", "la", "los", "las", "de", "del", "y", "o", "u", "que", "como",
  "para", "por", "con", "sin", "un", "una", "unos", "unas",
]);

function createInMemoryAdapter() {
  const conversations = new Map();      // userId → [turns]
  const longTerm = new Map();           // userId → Map<key, value>
  const files = new Map();              // fileId → record
  const semantic = new Map();           // collection → [{ id, text, embedding, metadata }]
  const graph = new Map();              // userId → { nodes: Map<id,node>, edges: [{from,to,kind,props}] }

  return {
    async pushTurn(userId, turn) {
      if (!conversations.has(userId)) conversations.set(userId, []);
      conversations.get(userId).push({ ...turn, ts: turn.ts || Date.now() });
    },
    async listTurns(userId, limit) {
      const arr = conversations.get(userId) || [];
      return arr.slice(-limit);
    },
    async clearTurns(userId) { conversations.delete(userId); },

    async setFact(userId, key, value) {
      if (!longTerm.has(userId)) longTerm.set(userId, new Map());
      longTerm.get(userId).set(key, value);
    },
    async getFact(userId, key) {
      const m = longTerm.get(userId);
      return m ? m.get(key) : undefined;
    },
    async listFacts(userId) {
      const m = longTerm.get(userId);
      if (!m) return [];
      return [...m.entries()].map(([key, value]) => ({ key, value }));
    },
    async forgetFact(userId, key) {
      const m = longTerm.get(userId);
      if (m) m.delete(key);
    },

    async putFile(file) {
      files.set(file.id, { ...file, ts: file.ts || Date.now() });
    },
    async getFile(id) {
      return files.get(id) ? { ...files.get(id) } : null;
    },
    async listUserFiles(userId) {
      return [...files.values()].filter(f => f.userId === userId).map(f => ({ ...f }));
    },

    async upsertSemantic(collection, item) {
      if (!semantic.has(collection)) semantic.set(collection, []);
      const bucket = semantic.get(collection);
      const existing = bucket.findIndex(x => x.id === item.id);
      if (existing >= 0) bucket[existing] = { ...item };
      else bucket.push({ ...item });
    },
    async listSemantic(collection) {
      return [...(semantic.get(collection) || [])];
    },
    async deleteSemantic(collection, id) {
      const bucket = semantic.get(collection);
      if (!bucket) return;
      semantic.set(collection, bucket.filter(x => x.id !== id));
    },

    async addGraphNode(userId, node) {
      if (!graph.has(userId)) graph.set(userId, { nodes: new Map(), edges: [] });
      graph.get(userId).nodes.set(node.id, { ...node });
    },
    async addGraphEdge(userId, edge) {
      if (!graph.has(userId)) graph.set(userId, { nodes: new Map(), edges: [] });
      graph.get(userId).edges.push({ ...edge });
    },
    async getGraph(userId) {
      const g = graph.get(userId);
      if (!g) return { nodes: [], edges: [] };
      return { nodes: [...g.nodes.values()], edges: [...g.edges] };
    },
  };
}

/**
 * Public memory facade — accepts an adapter; defaults to in-memory.
 *
 * @param {object} [adapter]
 * @returns {object} memory api
 */
function createMemory({ adapter = createInMemoryAdapter(), shortTermWindow = SHORT_TERM_DEFAULT_WINDOW } = {}) {

  // ── Short-term ───────────────────────────────────────────────────
  async function pushTurn(userId, { role, content, attachments = [] }) {
    if (!userId || !role || typeof content !== "string") {
      throw new Error("memory.pushTurn: userId, role, content required");
    }
    await adapter.pushTurn(userId, { role, content, attachments });
  }
  async function recentTurns(userId, limit = shortTermWindow) {
    return adapter.listTurns(userId, limit);
  }

  // ── Long-term ────────────────────────────────────────────────────
  async function rememberFact(userId, key, value) {
    if (!userId || !key) throw new Error("memory.rememberFact: userId, key required");
    await adapter.setFact(userId, key, value);
  }
  async function recallFact(userId, key) { return adapter.getFact(userId, key); }
  async function recallAllFacts(userId) { return adapter.listFacts(userId); }
  async function forgetFact(userId, key) { return adapter.forgetFact(userId, key); }

  // ── File memory ──────────────────────────────────────────────────
  async function rememberFile({ userId, id, name, mime, size, extractedText, url }) {
    if (!id || !userId) throw new Error("memory.rememberFile: id, userId required");
    await adapter.putFile({ userId, id, name, mime, size, extractedText, url });
  }
  async function recallFile(id) { return adapter.getFile(id); }
  async function listUserFiles(userId) { return adapter.listUserFiles(userId); }

  // ── Semantic memory ──────────────────────────────────────────────
  async function indexSnippet({ collection, id, text, embedding = null, metadata = {} }) {
    if (!collection || !id || typeof text !== "string") throw new Error("memory.indexSnippet: collection, id, text required");
    await adapter.upsertSemantic(collection, { id, text, embedding, metadata });
  }
  /**
   * Semantic search — uses the caller's embedding when present, else
   * falls back to deterministic token-overlap BM25-lite. Returns
   * top-K results with scores.
   */
  async function searchSemantic({ collection, query, queryEmbedding = null, topK = 5 }) {
    if (!collection || !query) return [];
    const bucket = await adapter.listSemantic(collection);
    if (bucket.length === 0) return [];
    const useEmbedding = Array.isArray(queryEmbedding) && queryEmbedding.length > 0
      && bucket.every(b => Array.isArray(b.embedding) && b.embedding.length === queryEmbedding.length);
    const scored = bucket.map(b => {
      const score = useEmbedding
        ? cosineSimilarity(queryEmbedding, b.embedding)
        : tokenOverlap(query, b.text);
      return { ...b, score };
    }).sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  // ── Knowledge graph ──────────────────────────────────────────────
  async function addEntity(userId, { id, kind, label, attrs = {} }) {
    if (!userId || !id || !kind) throw new Error("memory.addEntity: userId, id, kind required");
    await adapter.addGraphNode(userId, { id, kind, label, attrs });
  }
  async function addRelation(userId, { from, to, kind, props = {} }) {
    if (!userId || !from || !to || !kind) throw new Error("memory.addRelation: userId, from, to, kind required");
    await adapter.addGraphEdge(userId, { from, to, kind, props });
  }
  async function userGraph(userId) { return adapter.getGraph(userId); }

  // ── Conversational recall (short + semantic + facts blended) ─────
  async function buildContextForTurn({ userId, query, semanticCollection = "kb", topK = 4 }) {
    const recent = await recentTurns(userId, 6);
    const facts = await recallAllFacts(userId);
    const snippets = await searchSemantic({ collection: semanticCollection, query, topK });
    return {
      short_term: recent,
      long_term: facts.slice(0, 20),
      semantic: snippets.map(s => ({ id: s.id, text: s.text, score: s.score, metadata: s.metadata })),
    };
  }

  return {
    pushTurn, recentTurns,
    rememberFact, recallFact, recallAllFacts, forgetFact,
    rememberFile, recallFile, listUserFiles,
    indexSnippet, searchSemantic,
    addEntity, addRelation, userGraph,
    buildContextForTurn,
    adapter,
  };
}

// ── helpers ──────────────────────────────────────────────────────────

function tokenOverlap(query, text) {
  const q = tokenize(query);
  const t = tokenize(text);
  if (q.size === 0 || t.size === 0) return 0;
  let inter = 0;
  for (const x of q) if (t.has(x)) inter += 1;
  const union = q.size + t.size - inter;
  return union === 0 ? 0 : Math.round((inter / union) * 1000) / 1000;
}

function tokenize(text) {
  return new Set(
    String(text)
      .toLowerCase()
      .normalize("NFD").replace(/\p{Diacritic}/gu, "")
      .split(/[^a-z0-9]+/)
      .filter(t => t.length >= 3 && !STOP.has(t))
  );
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return Math.round((dot / (Math.sqrt(na) * Math.sqrt(nb))) * 1000) / 1000;
}

module.exports = {
  createMemory,
  createInMemoryAdapter,
  tokenOverlap,
  cosineSimilarity,
};

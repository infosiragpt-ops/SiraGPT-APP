/**
 * triple-graph — in-memory knowledge graph for GEAR-style retrieval.
 *
 * Stores triples `(subject, predicate, object)` linked to source chunks,
 * alongside an entity → triples inverted index that powers the
 * get_neighbours() call in the paper's Diverse Triple Beam Search
 * (Shen et al., ACL 2025). A "neighbour" of triple t is any triple in
 * the graph that shares its head (subject) or tail (object) entity.
 *
 * We also store an embedding per triple (over a canonical string form)
 * so `linkTriple(queryTriple)` can find the closest stored triple by
 * cosine — this is the `tripleLink` function in §4.1 of the paper.
 *
 * Storage is namespaced per (userId, collection) to match rag-service's
 * isolation. Triples live in-memory (Map-backed) so they share the
 * "production will swap to pgvector" roadmap noted in rag-service.js.
 *
 * Minimal API:
 *   addTriples(userId, collection, triples[])       — also stores embeddings
 *   getNeighbours(userId, collection, triple)        — entity-shared triples
 *   linkTriple(userId, collection, queryTriple)      — closest stored triple
 *   getTriplesForSource(userId, collection, sourceId) — reverse lookup
 *   stats / clear
 *
 * Triples are deduped by canonical `(subject|predicate|object)` key with
 * entities lowercased. The canonical display form (with original casing)
 * is kept on the first-inserted copy; later insertions bump confidence
 * by averaging rather than adding duplicates.
 */

const rag = require('./rag-service');

const store = new Map(); // storeKey → { triples: Map<tripleKey, Triple>, byEntity: Map<entity, Set<tripleKey>>, bySource: Map<sourceId, Set<tripleKey>> }

function storeKey(userId, collection) {
  return `${userId || 'anon'}:${collection || 'default'}`;
}

function tripleKey(t) {
  return `${(t.subject || '').toLowerCase()}|${(t.predicate || '').toLowerCase()}|${(t.object || '').toLowerCase()}`;
}

/**
 * Canonical string form used for embedding. We embed the full triple as
 * a natural-language sentence rather than concatenating raw fields,
 * because the embedding model (text-embedding-3-small) was trained on
 * prose — "Stephen Curry plays for Golden State Warriors" embeds to a
 * more useful point in space than "Stephen Curry|plays for|Golden State Warriors".
 */
function tripleToSentence(t) {
  return `${t.subject} ${t.predicate} ${t.object}`.replace(/\s+/g, ' ').trim();
}

function getNamespace(userId, collection) {
  const key = storeKey(userId, collection);
  let ns = store.get(key);
  if (!ns) {
    ns = {
      triples: new Map(),
      byEntity: new Map(),
      bySource: new Map(),
    };
    store.set(key, ns);
  }
  return ns;
}

function indexTripleInNs(ns, t) {
  const key = tripleKey(t);
  const existing = ns.triples.get(key);
  if (existing) {
    // Dedup by averaging confidence and unioning sources.
    const oldConf = existing.confidence ?? 0.8;
    const newConf = t.confidence ?? 0.8;
    existing.confidence = (oldConf + newConf) / 2;
    if (t.source && existing.source !== t.source) {
      // Convert source to a Set only when we see the second distinct source.
      existing.sources = existing.sources || new Set([existing.source]);
      existing.sources.add(t.source);
    }
    return existing;
  }
  ns.triples.set(key, { ...t });

  const subjKey = (t.subject || '').toLowerCase();
  const objKey = (t.object || '').toLowerCase();
  if (subjKey) {
    if (!ns.byEntity.has(subjKey)) ns.byEntity.set(subjKey, new Set());
    ns.byEntity.get(subjKey).add(key);
  }
  if (objKey) {
    if (!ns.byEntity.has(objKey)) ns.byEntity.set(objKey, new Set());
    ns.byEntity.get(objKey).add(key);
  }
  if (t.source) {
    if (!ns.bySource.has(t.source)) ns.bySource.set(t.source, new Set());
    ns.bySource.get(t.source).add(key);
  }
  return ns.triples.get(key);
}

/**
 * Add triples to the graph. Returns `{ added, total }`.
 *
 * If `embedder` is provided, it's called with the list of canonical
 * sentences and must return a parallel array of vectors (OpenAI-style).
 * Otherwise we fall back to rag-service.embed(). Pass `embedder: null`
 * to skip embeddings entirely (e.g. in tests that don't need linkTriple).
 */
async function addTriples(userId, collection, triples, { embedder } = {}) {
  if (!Array.isArray(triples) || triples.length === 0) return { added: 0, total: 0 };

  const ns = getNamespace(userId, collection);
  const fresh = [];
  const freshRefs = [];
  for (const raw of triples) {
    if (!raw || !raw.subject || !raw.predicate || !raw.object) continue;
    const key = tripleKey(raw);
    const already = ns.triples.has(key);
    const ref = indexTripleInNs(ns, raw);
    if (!already && !ref.embedding) {
      fresh.push(tripleToSentence(raw));
      freshRefs.push(ref);
    }
  }

  if (fresh.length > 0 && embedder !== null) {
    try {
      const vectors = embedder
        ? await embedder(fresh)
        : await rag.embed(fresh);
      for (let i = 0; i < freshRefs.length; i++) {
        freshRefs[i].embedding = vectors[i];
      }
    } catch (err) {
      // Embedding failure is non-fatal — triples are still in the graph,
      // just without linkTriple support. Graph expansion based on shared
      // entities still works.
      console.warn('[triple-graph] embedding failed, triples indexed without embeddings:', err.message);
    }
  }

  return { added: fresh.length, total: ns.triples.size };
}

function getTriple(userId, collection, t) {
  const ns = store.get(storeKey(userId, collection));
  if (!ns) return null;
  return ns.triples.get(tripleKey(t)) || null;
}

/**
 * Neighbours of a triple = every stored triple that shares its head OR
 * tail entity (§4.2 in GEAR paper: "shared head or tail entities").
 * The triple itself is excluded. Optionally exclude any keys in
 * `excludeKeys`.
 */
function getNeighbours(userId, collection, t, { excludeKeys = null } = {}) {
  const ns = store.get(storeKey(userId, collection));
  if (!ns) return [];

  const selfKey = tripleKey(t);
  const subjKey = (t.subject || '').toLowerCase();
  const objKey = (t.object || '').toLowerCase();

  const keys = new Set();
  for (const entity of [subjKey, objKey]) {
    if (!entity) continue;
    const set = ns.byEntity.get(entity);
    if (!set) continue;
    for (const k of set) {
      if (k === selfKey) continue;
      if (excludeKeys && excludeKeys.has(k)) continue;
      keys.add(k);
    }
  }

  const out = [];
  for (const k of keys) {
    const triple = ns.triples.get(k);
    if (triple) out.push(triple);
  }
  return out;
}

function cosine(a, b) {
  if (!a || !b) return 0;
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i], bv = b[i];
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * tripleLink (§4.1): given a proximal triple produced by the LLM "read"
 * step, return the most similar stored triple by cosine over embeddings.
 * Returns null if the graph is empty or no triple has an embedding.
 */
async function linkTriple(userId, collection, queryTriple, { embedder, k = 1 } = {}) {
  const ns = store.get(storeKey(userId, collection));
  if (!ns || ns.triples.size === 0) return k > 1 ? [] : null;

  const sentence = tripleToSentence(queryTriple);
  let qVec;
  try {
    const vectors = embedder ? await embedder([sentence]) : await rag.embed([sentence]);
    qVec = vectors[0];
  } catch (err) {
    console.warn('[triple-graph] linkTriple embedding failed:', err.message);
    return k > 1 ? [] : null;
  }
  if (!qVec) return k > 1 ? [] : null;

  let best = null;
  let bestScore = -Infinity;
  const topK = [];
  for (const t of ns.triples.values()) {
    if (!t.embedding) continue;
    const score = cosine(qVec, t.embedding);
    if (k > 1) {
      topK.push({ triple: t, score });
    } else if (score > bestScore) {
      bestScore = score;
      best = { triple: t, score };
    }
  }
  if (k > 1) {
    topK.sort((a, b) => b.score - a.score);
    return topK.slice(0, k);
  }
  return best;
}

function getTriplesForSource(userId, collection, sourceId) {
  const ns = store.get(storeKey(userId, collection));
  if (!ns) return [];
  const keys = ns.bySource.get(sourceId);
  if (!keys) return [];
  const out = [];
  for (const k of keys) {
    const t = ns.triples.get(k);
    if (t) out.push(t);
  }
  return out;
}

function clear(userId, collection) {
  store.delete(storeKey(userId, collection));
}

function stats(userId, collection) {
  const ns = store.get(storeKey(userId, collection));
  if (!ns) return { triples: 0, entities: 0, sources: 0 };
  return {
    triples: ns.triples.size,
    entities: ns.byEntity.size,
    sources: ns.bySource.size,
  };
}

module.exports = {
  addTriples,
  getNeighbours,
  linkTriple,
  getTriple,
  getTriplesForSource,
  clear,
  stats,
  // exported for tests
  tripleKey,
  tripleToSentence,
  cosine,
};

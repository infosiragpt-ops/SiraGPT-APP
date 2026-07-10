/**
 * rag-store — pluggable storage adapter for the RAG chunk index.
 *
 * rag-service historically used a bare Map keyed by storeKey(userId,
 * collection). That dies on process restart, doesn't work across
 * multiple backend instances, and has no read replica story.
 *
 * This module defines a NARROW, namespace-scoped API both in-memory
 * and pgvector-backed stores can implement. To swap: set the env var
 * USE_PG_STORE=1 and run the migration in prisma/migrations/*_rag_store.
 *
 * Interface:
 *   appendChunks(userId, collection, chunks[])
 *     chunks: [{ text, source, title, embedding, meta? }]
 *     Returns { inserted, total }.
 *   getAll(userId, collection)              → Array<Chunk>  (oldest-first)
 *   listSources(userId, collection)          → Array<{source, title, chunks, preview}>
 *   getBySource(userId, collection, src)      → Array<Chunk>
 *   trim(userId, collection, maxChunks)      → { removed, removedSources[] }
 *   clearCollection(userId, collection)       → { removed }
 *   stats(userId, collection)                → { chunks, sources, dim }
 *
 * The pgvector implementation depends on a table shape defined in
 * prisma/migrations/<timestamp>_rag_store/migration.sql — users must
 * run `npm run db:migrate` and set USE_PG_STORE=1 before this adapter
 * is active. Until then, the in-memory backend is the default and
 * rag-service continues to function unchanged.
 *
 * Backward-compatibility note: rag-service currently uses its own
 * internal Map directly. Migrating it to go through this adapter is
 * a separate incremental step so the 302-test baseline stays green.
 * Sections of rag-service that need persistence call into this module
 * at opt-in points (ingest flows, retrieve where useHybrid/useGraph
 * need all entries). Everything else remains on the Map during the
 * transition.
 */

const USE_PG_STORE = process.env.USE_PG_STORE === '1';
const CHUNK_TTL_MS = Number.parseInt(process.env.SIRAGPT_RAG_CHUNK_TTL_MS || '86400000', 10); // default 24h
const CHUNK_TTL_ENABLED = process.env.SIRAGPT_RAG_CHUNK_TTL !== '0' && process.env.SIRAGPT_RAG_CHUNK_TTL !== 'false';

// ─── In-memory backend (same shape as rag-service's internal Map) ──────────

const memStore = new Map(); // key → Array<Chunk>

function memKey(userId, collection) {
  return `${userId || 'anon'}:${collection || 'default'}`;
}

const memoryBackend = {
  async appendChunks(userId, collection, chunks) {
    const key = memKey(userId, collection);
    const existing = memStore.get(key) || [];
    const now = Date.now();
    const chunksWithTTL = CHUNK_TTL_ENABLED
      ? chunks.map(c => ({ ...c, _ingestedAt: now, _expiresAt: now + CHUNK_TTL_MS }))
      : chunks;
    const merged = existing.concat(chunksWithTTL);
    memStore.set(key, merged);
    return { inserted: chunks.length, total: merged.length };
  },
  async getAll(userId, collection) {
    return (memStore.get(memKey(userId, collection)) || []).map(c => ({ ...c }));
  },
  async listSources(userId, collection) {
    const entries = memStore.get(memKey(userId, collection)) || [];
    const by = new Map();
    for (const e of entries) {
      const src = e.source || '(no-source)';
      let rec = by.get(src);
      if (!rec) { rec = { source: src, title: e.title || null, chunks: 0, preview: (e.text || '').slice(0, 120) }; by.set(src, rec); }
      rec.chunks++;
    }
    return [...by.values()].sort((a, b) => String(a.source).localeCompare(String(b.source)));
  },
  async getBySource(userId, collection, src) {
    const entries = memStore.get(memKey(userId, collection)) || [];
    return entries.filter(e => e.source === src).map(c => ({ ...c }));
  },
  async trim(userId, collection, maxChunks) {
    const key = memKey(userId, collection);
    const entries = memStore.get(key) || [];
    if (entries.length <= maxChunks) return { removed: 0, removedSources: [] };
    const kept = entries.slice(entries.length - maxChunks);
    const dropped = entries.slice(0, entries.length - kept.length);
    const survivingSrc = new Set(kept.map(e => e.source).filter(Boolean));
    const removedSources = [...new Set(dropped.map(e => e.source).filter(s => s && !survivingSrc.has(s)))];
    memStore.set(key, kept);
    return { removed: dropped.length, removedSources };
  },
  async clearCollection(userId, collection) {
    const key = memKey(userId, collection);
    const n = (memStore.get(key) || []).length;
    memStore.delete(key);
    return { removed: n };
  },
  async stats(userId, collection) {
    const entries = memStore.get(memKey(userId, collection)) || [];
    const sources = new Set(entries.map(e => e.source).filter(Boolean));
    const dim = entries[0]?.embedding?.length || 0;
    return { chunks: entries.length, sources: sources.size, dim };
  },
  async evictExpired(userId, collection) {
    if (!CHUNK_TTL_ENABLED) return { removed: 0 };
    const key = memKey(userId, collection);
    const entries = memStore.get(key) || [];
    const now = Date.now();
    const kept = entries.filter(c => !c._expiresAt || c._expiresAt > now);
    const removed = entries.length - kept.length;
    memStore.set(key, kept);
    return { removed };
  },
  _reset() { memStore.clear(); },
};

// ─── pgvector backend (active when USE_PG_STORE=1) ─────────────────────────
//
// Expects a table:
//   CREATE TABLE rag_chunks (
//     id bigserial PRIMARY KEY,
//     user_id text NOT NULL,
//     collection text NOT NULL,
//     source text,
//     title text,
//     text_content text NOT NULL,
//     embedding vector(1536) NOT NULL,
//     meta jsonb,
//     created_at timestamptz NOT NULL DEFAULT now()
//   );
//   CREATE INDEX ON rag_chunks (user_id, collection, created_at);
//   CREATE INDEX ON rag_chunks (user_id, collection, source);
//   CREATE INDEX ON rag_chunks USING ivfflat (embedding vector_cosine_ops);
//
// The migration SQL file ships alongside this module.

function pgBackend() {
  let prisma;
  try {
    prisma = require('../config/database');
  } catch (err) {
    throw new Error(`USE_PG_STORE=1 but Prisma client isn't available: ${err.message}`);
  }

  // Prisma doesn't natively support the pgvector type via the schema, so
  // we use $queryRawUnsafe / $executeRawUnsafe with parameterised vectors.
  const vecToLiteral = (v) => `[${Array.from(v).map(n => Number(n).toFixed(6)).join(',')}]`;

  return {
    async appendChunks(userId, collection, chunks) {
      if (chunks.length === 0) return { inserted: 0, total: 0 };
      // Bulk insert via VALUES list.
      const rows = chunks.map(c => ({
        userId, collection,
        source: c.source || null,
        title: c.title || null,
        text: c.text,
        embedding: vecToLiteral(c.embedding),
        meta: c.meta || null,
      }));
      for (const r of rows) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.$executeRawUnsafe(
          `INSERT INTO rag_chunks (user_id, collection, source, title, text_content, embedding, meta)
           VALUES ($1, $2, $3, $4, $5, $6::vector, $7::jsonb)`,
          r.userId, r.collection, r.source, r.title, r.text, r.embedding,
          r.meta ? JSON.stringify(r.meta) : null,
        );
      }
      const countRows = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS total FROM rag_chunks WHERE user_id = $1 AND collection = $2`,
        userId, collection,
      ).catch(() => [{ total: chunks.length }]);
      return { inserted: chunks.length, total: Number(countRows?.[0]?.total || chunks.length) };
    },
    async getAll(userId, collection) {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT source, title, text_content AS text, embedding::text AS embedding, meta
         FROM rag_chunks WHERE user_id = $1 AND collection = $2
         ORDER BY created_at ASC`,
        userId, collection,
      );
      return rows.map(r => ({
        ...r,
        embedding: r.embedding ? Float32Array.from(JSON.parse(r.embedding)) : null,
      }));
    },
    async listSources(userId, collection) {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT source, MIN(title) AS title, COUNT(*)::int AS chunks,
                LEFT(MIN(text_content), 120) AS preview
         FROM rag_chunks WHERE user_id = $1 AND collection = $2
         GROUP BY source
         ORDER BY source`,
        userId, collection,
      );
      return rows;
    },
    async getBySource(userId, collection, src) {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT source, title, text_content AS text, embedding::text AS embedding, meta
         FROM rag_chunks WHERE user_id = $1 AND collection = $2 AND source = $3
         ORDER BY created_at ASC`,
        userId, collection, src,
      );
      return rows.map(r => ({
        ...r,
        embedding: r.embedding ? Float32Array.from(JSON.parse(r.embedding)) : null,
      }));
    },
    async trim(userId, collection, maxChunks) {
      const removed = await prisma.$queryRawUnsafe(
        `WITH victims AS (
           SELECT id, source FROM rag_chunks
           WHERE user_id = $1 AND collection = $2
           ORDER BY created_at ASC
           LIMIT GREATEST(0, (SELECT COUNT(*) - $3::int FROM rag_chunks WHERE user_id = $1 AND collection = $2))
         ),
         deleted AS (
           DELETE FROM rag_chunks WHERE id IN (SELECT id FROM victims)
           RETURNING source
         )
         SELECT source FROM deleted`,
        userId, collection, maxChunks,
      );
      const removedSources = [...new Set(removed.map(r => r.source).filter(Boolean))];
      // Any source entirely gone is one with zero surviving rows.
      const stillPresent = await prisma.$queryRawUnsafe(
        `SELECT DISTINCT source FROM rag_chunks WHERE user_id = $1 AND collection = $2`,
        userId, collection,
      );
      const surviving = new Set(stillPresent.map(r => r.source).filter(Boolean));
      return {
        removed: removed.length,
        removedSources: removedSources.filter(s => !surviving.has(s)),
      };
    },
    async clearCollection(userId, collection) {
      const result = await prisma.$executeRawUnsafe(
        `DELETE FROM rag_chunks WHERE user_id = $1 AND collection = $2`,
        userId, collection,
      );
      return { removed: Number(result) };
    },
    async stats(userId, collection) {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS chunks,
                COUNT(DISTINCT source)::int AS sources
         FROM rag_chunks WHERE user_id = $1 AND collection = $2`,
        userId, collection,
      );
      return { chunks: rows[0].chunks, sources: rows[0].sources, dim: 1536 };
    },
    async evictExpired(userId, collection) {
      if (!CHUNK_TTL_ENABLED) return { removed: 0 };
      const ttlHours = Math.floor(CHUNK_TTL_MS / 3600000);
      const result = await prisma.$executeRawUnsafe(
        `DELETE FROM rag_chunks WHERE user_id = $1 AND collection = $2 AND created_at < NOW() - INTERVAL '${ttlHours} hours'`,
        userId, collection,
      );
      return { removed: Number(result) };
    },
    _reset() { /* no-op — use clearCollection */ },
  };
}

const backend = USE_PG_STORE ? pgBackend() : memoryBackend;

module.exports = backend;
module.exports.isPg = USE_PG_STORE;
module.exports._memoryBackend = memoryBackend; // exposed for tests

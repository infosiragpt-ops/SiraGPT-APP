'use strict';

/**
 * user-memory-store — optional pgvector-backed durable memory.
 *
 * Enabled only when SIRAGPT_USER_MEMORY_STORE=pgvector. The existing
 * long-term-memory RAG path remains the fallback, so deploys can roll this
 * out after applying the migration and configuring Voyage/Jina keys.
 */

const crypto = require('crypto');

const EMBED_DIM = 1024;
const DEFAULT_MODEL = process.env.SIRAGPT_MEMORY_EMBED_MODEL || 'voyage-3-large';
const DEFAULT_PROVIDER = (process.env.SIRAGPT_MEMORY_EMBED_PROVIDER || 'voyage').toLowerCase();

function isEnabled(env = process.env) {
  return env.SIRAGPT_USER_MEMORY_STORE === 'pgvector';
}

/**
 * The pgvector store can be flag-enabled but still lack the embedding
 * provider's API key. In that state we must NOT engage the store: every
 * recall/upsert would throw `VOYAGE_API_KEY not configured` per chat turn.
 * Returning `false` here lets long-term-memory fall back cleanly to its
 * in-memory RAG path (which needs no external key) instead of throwing.
 */
function isConfigured(env = process.env) {
  if (!isEnabled(env)) return false;
  const provider = (env.SIRAGPT_MEMORY_EMBED_PROVIDER || 'voyage').toLowerCase();
  if (provider === 'voyage') return Boolean(env.VOYAGE_API_KEY);
  if (provider === 'jina') return Boolean(env.JINA_API_KEY);
  // Unknown provider: let getStore() proceed so embedTexts surfaces the
  // explicit "unsupported provider" error rather than silently disabling.
  return true;
}

function contentHash(text) {
  return crypto
    .createHash('sha256')
    .update(String(text || '').trim().toLowerCase().replace(/\s+/g, ' '))
    .digest('hex');
}

function vecToLiteral(vector) {
  if (!Array.isArray(vector) && !(vector instanceof Float32Array)) {
    throw new TypeError('user-memory-store: embedding vector must be an array');
  }
  if (vector.length !== EMBED_DIM) {
    throw new Error(`user-memory-store: expected ${EMBED_DIM}-dimension embedding, got ${vector.length}`);
  }
  return `[${Array.from(vector).map(n => Number(n).toFixed(6)).join(',')}]`;
}

async function postJson(url, headers, body, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    // Bound the embedding-provider call (Voyage/Jina) so a stall can't hang the
    // memory write/recall path.
    signal: AbortSignal.timeout(Number(process.env.EMBED_TIMEOUT_MS) || 15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`embedding provider failed: ${res.status} ${text.slice(0, 160)}`);
  }
  return res.json();
}

function coerceEmbedding(vector) {
  if (!Array.isArray(vector)) throw new Error('embedding provider returned no vector');
  if (vector.length !== EMBED_DIM) {
    throw new Error(`embedding provider returned ${vector.length} dims; configure a ${EMBED_DIM}-dim memory model`);
  }
  return Float32Array.from(vector);
}

async function embedTexts(texts, opts = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const provider = (opts.provider || DEFAULT_PROVIDER).toLowerCase();
  const model = opts.model || DEFAULT_MODEL;
  const fetchImpl = opts.fetch || globalThis.fetch;

  if (provider === 'voyage') {
    const apiKey = opts.apiKey || process.env.VOYAGE_API_KEY;
    if (!apiKey) throw new Error('VOYAGE_API_KEY not configured for pgvector user memory');
    const json = await postJson(
      'https://api.voyageai.com/v1/embeddings',
      { authorization: `Bearer ${apiKey}` },
      { model, input: texts, input_type: 'document', output_dimension: EMBED_DIM },
      fetchImpl,
    );
    return (json.data || []).map(item => coerceEmbedding(item.embedding));
  }

  if (provider === 'jina') {
    const apiKey = opts.apiKey || process.env.JINA_API_KEY;
    if (!apiKey) throw new Error('JINA_API_KEY not configured for pgvector user memory');
    const json = await postJson(
      'https://api.jina.ai/v1/embeddings',
      { authorization: `Bearer ${apiKey}` },
      { model: opts.model || 'jina-embeddings-v3', input: texts, dimensions: EMBED_DIM },
      fetchImpl,
    );
    return (json.data || []).map(item => coerceEmbedding(item.embedding));
  }

  throw new Error(`unsupported memory embedding provider: ${provider}`);
}

function createPgUserMemoryStore({ prisma, embedder = embedTexts } = {}) {
  if (!prisma) {
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient();
  }

  return {
    async upsertFacts(userId, facts) {
      if (!userId || !Array.isArray(facts) || facts.length === 0) return { upserted: 0 };
      const clean = facts
        .filter(f => f && typeof f.fact === 'string' && f.fact.trim())
        .map(f => ({
          content: f.fact.trim(),
          category: f.category || 'knowledge',
          confidence: typeof f.confidence === 'number' ? f.confidence : 0.8,
          importanceScore: typeof f.importanceScore === 'number' ? f.importanceScore : 0.1,
          source: f.source || null,
        }));
      if (clean.length === 0) return { upserted: 0 };

      const embeddings = await embedder(clean.map(f => f.content));
      for (let i = 0; i < clean.length; i++) {
        const f = clean[i];
        const hash = contentHash(f.content);
        const embedding = vecToLiteral(embeddings[i]);
        // eslint-disable-next-line no-await-in-loop
        await prisma.$executeRawUnsafe(
          `INSERT INTO user_memories
             (user_id, content, content_hash, embedding, category, importance_score, confidence, source, access_count)
           VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8, 1)
           ON CONFLICT (user_id, content_hash)
           DO UPDATE SET
             category = EXCLUDED.category,
             importance_score = LEAST(1.0, user_memories.importance_score + 0.05),
             confidence = GREATEST(user_memories.confidence, EXCLUDED.confidence),
             source = COALESCE(EXCLUDED.source, user_memories.source),
             access_count = user_memories.access_count + 1,
             last_accessed_at = NOW()`,
          userId,
          f.content,
          hash,
          embedding,
          f.category,
          f.importanceScore,
          f.confidence,
          f.source,
        );
      }
      return { upserted: clean.length };
    },

    async recall(userId, query, k = 5) {
      if (!userId || !query) return [];
      const [queryEmbedding] = await embedder([query]);
      const q = vecToLiteral(queryEmbedding);
      const limit = Math.max(1, Math.min(Number(k) || 5, 20));
      const rows = await prisma.$queryRawUnsafe(
        `WITH ranked AS (
           SELECT id, content, category, importance_score, confidence, access_count,
                  1 - (embedding <=> $2::vector) AS cosine
           FROM user_memories
           WHERE user_id = $1
           ORDER BY embedding <=> $2::vector
           LIMIT $3
         ),
         touched AS (
           UPDATE user_memories
           SET access_count = user_memories.access_count + 1,
               last_accessed_at = NOW()
           WHERE id IN (SELECT id FROM ranked)
           RETURNING id
         )
         SELECT content, category, importance_score, confidence, access_count, cosine
         FROM ranked
         ORDER BY (cosine * 0.75 + importance_score * 0.20 + LEAST(access_count, 10) / 10.0 * 0.05) DESC`,
        userId,
        q,
        limit,
      );
      return rows.map(r => ({
        text: r.content,
        category: r.category || 'knowledge',
        // Mirror the SQL ORDER BY exactly — the returned score dropped the
        // access_count term, so it disagreed with the order rows came back in.
        score: Number(r.cosine || 0) * 0.75
          + Number(r.importance_score || 0) * 0.2
          + (Math.min(Number(r.access_count || 0), 10) / 10) * 0.05,
        cosine: Number(r.cosine || 0),
        importance: Number(r.importance_score || 0),
        confidence: Number(r.confidence || 0),
        mentions: Number(r.access_count || 0),
      }));
    },

    async clear(userId) {
      if (!userId) return { removed: 0 };
      const removed = await prisma.$executeRawUnsafe(
        `DELETE FROM user_memories WHERE user_id = $1`,
        userId,
      );
      return { removed: Number(removed || 0) };
    },

    async stats(userId) {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS memories,
                COUNT(DISTINCT category)::int AS categories,
                COALESCE(AVG(importance_score), 0)::float AS avg_importance
         FROM user_memories WHERE user_id = $1`,
        userId,
      );
      const row = rows[0] || {};
      return {
        memories: Number(row.memories || 0),
        categories: Number(row.categories || 0),
        avgImportance: Number(row.avg_importance || 0),
        dim: EMBED_DIM,
        store: 'pgvector',
      };
    },
  };
}

let singleton = null;
let warnedUnconfigured = false;
function getStore() {
  if (!isEnabled()) return null;
  if (!isConfigured()) {
    // Detect the unconfigured state ONCE: log a single startup-style
    // warning, then return null so callers degrade to the RAG fallback
    // silently instead of throwing/logging on every chat turn.
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      const provider = (process.env.SIRAGPT_MEMORY_EMBED_PROVIDER || 'voyage').toLowerCase();
      const keyName = provider === 'jina' ? 'JINA_API_KEY' : 'VOYAGE_API_KEY';
      console.warn(
        `[user-memory-store] SIRAGPT_USER_MEMORY_STORE=pgvector but ${keyName} is not set; ` +
        'falling back to in-memory RAG user memory (set the key to enable pgvector).',
      );
    }
    return null;
  }
  if (!singleton) singleton = createPgUserMemoryStore();
  return singleton;
}

module.exports = {
  EMBED_DIM,
  contentHash,
  createPgUserMemoryStore,
  embedTexts,
  getStore,
  isConfigured,
  isEnabled,
  vecToLiteral,
};

/**
 * user-memory-vector — Mem0-compatible long-term memory powered by pgvector.
 *
 * Stores user memories as embedded vectors in the `user_memories` table
 * and provides semantic recall with importance/recency re-weighting,
 * consolidation (merge + promote + demote), and stale-memory eviction.
 *
 * Embedding provider: the caller passes an LLM gateway reference; this
 * module calls `gateway.embed({ input })` which routes through Voyage AI /
 * Jina via the existing gateway circuit-breaker infrastructure.
 *
 * Usage:
 *   const { createUserMemoryVector } = require('./services/user-memory-vector.ts');
 *   const memory = createUserMemoryVector({ gateway });
 *   await memory.storeMemory({ userId, content, category: 'preference' });
 *   const matches = await memory.recallMemories({ userId, query: 'favorite color', k: 5 });
 */

import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import pino from "pino";

const EMBED_DIM = 1024;
const logger = pino({ name: "user-memory-vector", level: process.env.LOG_LEVEL || "info" });

type MemoryPrismaClient = Pick<
  PrismaClient,
  "$executeRawUnsafe" | "$queryRawUnsafe"
>;

interface MemoryDatabaseAdapter {
  execute(query: string, params: any[]): any;
}

interface UserMemoryVectorOptions {
  gateway?: any;
  db?: MemoryDatabaseAdapter;
}

// ─── helpers ──────────────────────────────────────────────────────────────

export function contentHash(text: string): string {
  return crypto
    .createHash("sha256")
    .update(String(text || "").trim().toLowerCase().replace(/\s+/g, " "))
    .digest("hex");
}

export function vecToLiteral(vector: number[] | Float32Array): string {
  if (!Array.isArray(vector) && !(vector instanceof Float32Array)) {
    throw new TypeError("embedding vector must be an array");
  }
  const arr = vector instanceof Float32Array ? Array.from(vector) : vector;
  if (arr.length !== EMBED_DIM) {
    throw new Error(`expected ${EMBED_DIM}-dimension embedding, got ${arr.length}`);
  }
  return `[${arr.map((n) => Number(n).toFixed(6)).join(",")}]`;
}

export function importanceH(
  score: number,
  mentions: number,
  lastAccessAgeDays: number | null,
): number {
  const recent =
    lastAccessAgeDays != null
      ? Math.exp((-lastAccessAgeDays / 30.0) * Math.log(2))
      : 1;
  const mention = Math.min((mentions || 0) / 10.0, 1);
  return (Number(score) || 0) * 0.5 + mention * 0.25 + recent * 0.25;
}

// ─── factory ───────────────────────────────────────────────────────────────

export function createUserMemoryVector({
  gateway,
  db,
}: UserMemoryVectorOptions = {}) {
  if (!gateway && !db) {
    throw new Error(
      "createUserMemoryVector requires at least one of `gateway` or `db`",
    );
  }

  async function embedTexts(texts: string[]): Promise<Float32Array[]> {
    if (!Array.isArray(texts) || texts.length === 0) return [];
    if (!gateway) throw new Error("no embedding gateway configured");
    const embeddings: Float32Array[] = [];
    for (const text of texts) {
      const { response } = await gateway.embed({ input: [text] });
      const data = response?.data || response;
      if (Array.isArray(data)) {
        for (const item of data) {
          const vec = item.embedding || item;
          embeddings.push(new Float32Array(vec));
        }
      } else if (data) {
        const vec = data.embedding || data;
        embeddings.push(new Float32Array(vec));
      }
    }
    return embeddings;
  }

  let _prisma: MemoryPrismaClient | null = null;
  function getPrisma(): MemoryPrismaClient {
    if (_prisma) return _prisma;
    try {
      _prisma = require("../config/database") as MemoryPrismaClient;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Prisma not available: ${message}`);
    }
    return _prisma;
  }

  async function rawExecWrite(
    query: string,
    ...params: any[]
  ): Promise<any> {
    if (db) {
      return db.execute(query, params);
    }
    return getPrisma().$executeRawUnsafe(query, ...params);
  }

  // ─── store ──────────────────────────────────────────────────────────

  async function storeMemory({
    userId,
    content,
    category = "knowledge",
    importanceScore = 0.1,
    confidence = 0.8,
    source = null,
  }: {
    userId: string;
    content: string;
    category?: string;
    importanceScore?: number;
    confidence?: number;
    source?: string | null;
  }) {
    if (!userId || !content) throw new Error("userId and content are required");
    const text = String(content).slice(0, 4096).trim();
    if (!text) throw new Error("content must be non-empty");

    const hash = contentHash(text);
    const [embedding] = await embedTexts([text]);
    if (!embedding) throw new Error("embedding generation failed");

    const vecLit = vecToLiteral(embedding);

    await rawExecWrite(
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
      text,
      hash,
      vecLit,
      category,
      importanceScore,
      confidence,
      source,
    );

    logger.debug({ userId, contentHash: hash, category }, "memory stored");
    return { userId, contentHash: hash, stored: true };
  }

  async function storeMemoriesBatch({
    userId,
    memories = [],
  }: {
    userId: string;
    memories: Array<{
      content: string;
      category?: string;
      importanceScore?: number;
      confidence?: number;
      source?: string | null;
    }>;
  }) {
    if (!userId || !Array.isArray(memories) || memories.length === 0) {
      return { stored: 0 };
    }

    const clean = memories
      .filter((m) => m && typeof m.content === "string" && m.content.trim())
      .map((m) => ({
        content: m.content.trim().slice(0, 4096),
        category: m.category || "knowledge",
        importanceScore:
          typeof m.importanceScore === "number" ? m.importanceScore : 0.1,
        confidence: typeof m.confidence === "number" ? m.confidence : 0.8,
        source: m.source || null,
        hash: contentHash(m.content.trim()),
      }));
    if (clean.length === 0) return { stored: 0 };

    const embeds = await embedTexts(clean.map((m) => m.content));

    for (let i = 0; i < clean.length; i++) {
      const m = clean[i];
      const vecLit = vecToLiteral(embeds[i]);
      await rawExecWrite(
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
        m.content,
        m.hash,
        vecLit,
        m.category,
        m.importanceScore,
        m.confidence,
        m.source,
      );
    }

    logger.debug({ userId, count: clean.length }, "batch memories stored");
    return { stored: clean.length };
  }

  // ─── recall ─────────────────────────────────────────────────────────

  async function recallMemories({
    userId,
    query,
    k = 5,
    minImportance = 0,
  }: {
    userId: string;
    query: string;
    k?: number;
    minImportance?: number;
  }) {
    if (!userId || !query) return [];
    const limit = Math.max(1, Math.min(Number(k) || 5, 20));

    const [queryEmbedding] = await embedTexts([query]);
    if (!queryEmbedding) return [];

    const q = vecToLiteral(queryEmbedding);

    const runQuery = db
      ? (sql: string, ...args: any[]) => db.execute(sql, args)
      : (sql: string, ...args: any[]) => getPrisma().$queryRawUnsafe(sql, ...args);

    const rows = await runQuery(
      `WITH ranked AS (
         SELECT id, content, category, importance_score, confidence, access_count,
                1 - (embedding <=> $2::vector) AS cosine,
                EXTRACT(EPOCH FROM (NOW() - last_accessed_at)) / 86400.0 AS access_age_days
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
       )
       SELECT content, category, importance_score, confidence, access_count, cosine, access_age_days
       FROM ranked
       ORDER BY (cosine * 0.65 + LEAST(importance_score, 1.0) * 0.20 + COALESCE(1.0 / (1.0 + access_age_days / 30.0), 1.0) * 0.15) DESC
       LIMIT $4`,
      userId,
      q,
      limit,
      limit,
    );

    return (rows || [])
      .map((r: any) => ({
        text: r.content,
        category: r.category || "knowledge",
        score:
          Number(r.cosine || 0) * 0.65 +
          Number(r.importance_score || 0) * 0.2 +
          (1.0 / (1.0 + Number(r.access_age_days || 0) / 30.0)) * 0.15,
        cosine: Number(r.cosine || 0),
        importance: Number(r.importance_score || 0),
        confidence: Number(r.confidence || 0),
        mentions: Number(r.access_count || 0),
        lastAccessedDaysAgo: Number(r.access_age_days || 0),
      }))
      .filter((r: { importance: number }) => r.importance >= minImportance);
  }

  // ─── consolidate ─────────────────────────────────────────────────────

  async function consolidateMemories(userId: string) {
    const stats: { promoted: number; merged: number; demoted: number } = {
      promoted: 0,
      merged: 0,
      demoted: 0,
    };

    try {
      await rawExecWrite(
        `UPDATE user_memories
         SET importance_score = LEAST(importance_score * 1.2, 1.0)
         WHERE user_id = $1
           AND access_count > 3
           AND importance_score < 0.8
           AND updated_at < NOW() - INTERVAL '24 hours'`,
        userId,
      );
      stats.promoted = 1;
    } catch (err: any) {
      logger.warn({ err, userId }, "promotion pass failed");
    }

    try {
      await rawExecWrite(
        `WITH similar AS (
           SELECT a.id AS keep_id, b.id AS dup_id,
                  1 - (a.embedding <=> b.embedding) AS sim
           FROM user_memories a
           JOIN user_memories b
             ON a.user_id = b.user_id
            AND a.id < b.id
            AND a.user_id = $1
           WHERE 1 - (a.embedding <=> b.embedding) > 0.85
         ),
         candidates AS (
           SELECT DISTINCT keep_id, dup_id, sim FROM similar
         )
         UPDATE user_memories
         SET importance_score = LEAST(importance_score + 0.1, 1.0),
             source = COALESCE(source, 'consolidated')
         WHERE id IN (SELECT keep_id FROM candidates)`,
        userId,
      );
      stats.merged = 1;
    } catch (err: any) {
      logger.debug({ err, userId }, "merge pass skipped or failed");
    }

    try {
      await rawExecWrite(
        `UPDATE user_memories
         SET importance_score = GREATEST(importance_score * 0.85, 0)
         WHERE user_id = $1
           AND access_count < 2
           AND importance_score > 0.15
           AND last_accessed_at < NOW() - INTERVAL '30 days'`,
        userId,
      );
      stats.demoted = 1;
    } catch (err: any) {
      logger.warn({ err, userId }, "demotion pass failed");
    }

    logger.info({ userId, ...stats }, "memory consolidation complete");
    return stats;
  }

  // ─── forget ──────────────────────────────────────────────────────────

  async function forgetStaleMemories(
    userId: string,
    olderThanDays = 90,
  ) {
    const days = Math.max(7, Number(olderThanDays) || 90);

    const result = await rawExecWrite(
      `DELETE FROM user_memories
       WHERE user_id = $1
         AND importance_score < 0.2
         AND access_count < 2
         AND last_accessed_at < NOW() - INTERVAL '${days} days'`,
      userId,
    );

    const removed = typeof result === "number" ? result : 0;
    logger.info(
      { userId, olderThanDays: days, removed },
      "stale memories purged",
    );
    return { removed };
  }

  // ─── enrich system prompt ────────────────────────────────────────────

  async function enrichSystemPrompt(
    userId: string,
    currentQuery: string,
    k = 5,
  ): Promise<string> {
    if (!userId || !currentQuery) return "";

    const memories = await recallMemories({
      userId,
      query: currentQuery,
      k,
      minImportance: 0.05,
    });
    if (!Array.isArray(memories) || memories.length === 0) return "";

    const lines = memories
      .sort((a, b) => b.score - a.score)
      .map((m) => `- [${m.category}] ${m.text}`)
      .filter(Boolean);

    if (lines.length === 0) return "";

    return `\n\n## USER MEMORY (Durable Context)
These facts were learned from prior conversations with this user.
Use them to personalise responses — but if the user contradicts a
fact in the current turn, the new information wins.
${lines.join("\n")}`;
  }

  // ─── bulk read ──────────────────────────────────────────────────────

  async function getAllMemories(userId: string) {
    const runQuery = db
      ? (sql: string, ...args: any[]) => db.execute(sql, args)
      : (sql: string, ...args: any[]) => getPrisma().$queryRawUnsafe(sql, ...args);

    const rows = await runQuery(
      `SELECT id, content, category, importance_score, confidence, access_count,
              last_accessed_at, created_at
       FROM user_memories
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      userId,
    );
    return (rows || []).map((r: any) => ({
      id: r.id,
      content: r.content,
      category: r.category,
      importanceScore: Number(r.importance_score || 0),
      confidence: Number(r.confidence || 0),
      accessCount: Number(r.access_count || 0),
      lastAccessedAt: r.last_accessed_at,
      createdAt: r.created_at,
    }));
  }

  // ─── stats ────────────────────────────────────────────────────────────

  async function stats(userId: string) {
    const runQuery = db
      ? (sql: string, ...args: any[]) => db.execute(sql, args)
      : (sql: string, ...args: any[]) => getPrisma().$queryRawUnsafe(sql, ...args);

    const rows = await runQuery(
      `SELECT COUNT(*)::int AS memories,
              COUNT(DISTINCT category)::int AS categories,
              COALESCE(AVG(importance_score), 0)::real AS avg_importance,
              SUM(access_count)::int AS total_accesses
       FROM user_memories WHERE user_id = $1`,
      userId,
    );
    const row = (rows as any[])[0] || {};
    return {
      memories: Number(row.memories || 0),
      categories: Number(row.categories || 0),
      avgImportance: Number(row.avg_importance || 0),
      totalAccesses: Number(row.total_accesses || 0),
      dim: EMBED_DIM,
      store: "pgvector",
    };
  }

  // ─── clear ────────────────────────────────────────────────────────────

  async function clear(userId: string) {
    if (!userId) return { removed: 0 };
    const result = await rawExecWrite(
      `DELETE FROM user_memories WHERE user_id = $1`,
      userId,
    );
    return { removed: Number(result || 0) };
  }

  return {
    storeMemory,
    storeMemoriesBatch,
    recallMemories,
    consolidateMemories,
    forgetStaleMemories,
    enrichSystemPrompt,
    getAllMemories,
    stats,
    clear,
  };
}

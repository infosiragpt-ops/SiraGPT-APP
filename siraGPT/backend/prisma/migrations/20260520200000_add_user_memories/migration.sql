-- User memory embeddings: separate table for per-memory embedding vectors.
-- The Prisma model UserMemoryEmbedding maps here. The embedding_vector
-- column is intentionally NOT modeled in Prisma because the pgvector type
-- has no Prisma scalar; raw SQL is used for similarity queries.

-- Enable pgvector and pgcrypto (idempotent; also enabled by earlier migration).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Create the embeddings table. Matches the Prisma UserMemoryEmbedding model:
--   id (cuid/text), memory_id (FK -> user_memories.id, cascade),
--   embedding (Bytes / bytea), created_at.
CREATE TABLE IF NOT EXISTS user_memory_embeddings (
    id          TEXT        PRIMARY KEY,
    memory_id   UUID        NOT NULL REFERENCES user_memories(id) ON DELETE CASCADE,
    embedding   BYTEA       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_memory_embeddings_memory_id_idx
    ON user_memory_embeddings (memory_id);

-- Raw pgvector column for fast ANN search (not modeled in Prisma).
ALTER TABLE user_memory_embeddings ADD COLUMN IF NOT EXISTS embedding_vector vector(1024);

-- HNSW index for fast approximate nearest neighbor search on embeddings.
CREATE INDEX IF NOT EXISTS user_memory_embeddings_hnsw_idx
    ON user_memory_embeddings USING hnsw (embedding_vector vector_cosine_ops);

-- Recall indexes on user_memories (created by earlier migration; idempotent here).
CREATE INDEX IF NOT EXISTS user_memories_user_importance_idx
    ON user_memories (user_id, importance_score DESC);

CREATE INDEX IF NOT EXISTS user_memories_last_accessed_idx
    ON user_memories (user_id, last_accessed_at DESC);

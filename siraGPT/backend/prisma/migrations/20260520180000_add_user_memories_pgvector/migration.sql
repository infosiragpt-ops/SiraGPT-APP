-- Durable per-user memory backed by pgvector.
--
-- This table is intentionally separate from rag_chunks: memories have their
-- own lifecycle signals (importance, access count, last accessed) and a
-- narrower 1024-dimension embedding profile for Voyage/Jina memory recall.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS user_memories (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          TEXT        NOT NULL,
    content          TEXT        NOT NULL,
    content_hash     TEXT        NOT NULL,
    embedding        vector(1024) NOT NULL,
    category         TEXT        NOT NULL DEFAULT 'knowledge',
    importance_score REAL        NOT NULL DEFAULT 0.1,
    confidence       REAL        NOT NULL DEFAULT 0.8,
    source           TEXT,
    last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    access_count     INTEGER     NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_memories_user_hash_idx
    ON user_memories (user_id, content_hash);

CREATE INDEX IF NOT EXISTS user_memories_user_access_idx
    ON user_memories (user_id, last_accessed_at DESC);

CREATE INDEX IF NOT EXISTS user_memories_user_category_idx
    ON user_memories (user_id, category);

CREATE INDEX IF NOT EXISTS user_memories_embedding_hnsw_idx
    ON user_memories USING hnsw (embedding vector_cosine_ops);

CREATE OR REPLACE FUNCTION set_user_memories_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_memories_updated_at_trigger ON user_memories;
CREATE TRIGGER user_memories_updated_at_trigger
BEFORE UPDATE ON user_memories
FOR EACH ROW EXECUTE FUNCTION set_user_memories_updated_at();

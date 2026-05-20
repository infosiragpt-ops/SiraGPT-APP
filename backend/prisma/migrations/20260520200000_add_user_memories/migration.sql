-- User memories for persistent semantic/episodic memory per user
-- pgvector extension for fast similarity search on memory embeddings

-- Enable pgvector extension (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding vector column (not modeled in Prisma due to vector type)
ALTER TABLE user_memory_embeddings ADD COLUMN IF NOT EXISTS embedding_vector vector(1024);

-- HNSW index for fast approximate nearest neighbor search on embeddings
CREATE INDEX IF NOT EXISTS user_memory_embeddings_hnsw_idx
    ON user_memory_embeddings USING hnsw (embedding_vector vector_cosine_ops);

-- Index on user_memories for quick top-K recall
CREATE INDEX IF NOT EXISTS user_memories_user_importance_idx
    ON user_memories (user_id, importance_score DESC);

-- Index on user_memories for access-based cleanup
CREATE INDEX IF NOT EXISTS user_memories_last_accessed_idx
    ON user_memories (user_id, last_accessed_at DESC);

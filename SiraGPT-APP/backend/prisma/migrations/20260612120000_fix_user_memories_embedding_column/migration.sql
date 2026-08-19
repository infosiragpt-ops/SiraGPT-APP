-- Add embedding column to user_memories if it doesn't exist.
-- Root cause: the original CREATE TABLE IF NOT EXISTS in migration
-- 20260520180000_add_user_memories_pgvector was a no-op on databases where
-- the table already existed without pgvector support, leaving the embedding
-- (and confidence) columns absent.
-- Added as nullable so existing rows are not rejected; similarity queries
-- naturally exclude rows with null embeddings (no <=> match possible).
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "user_memories"
  ADD COLUMN IF NOT EXISTS "embedding" vector(1024);

-- Cross-chat recall support (cross-chat-retrieval.js). Idempotent on purpose:
-- prod was baselined from a db-push schema, so this must be safe to run on a
-- database that may already have any subset of these objects.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "user_memories" ADD COLUMN IF NOT EXISTS "content_hash" TEXT;
ALTER TABLE "user_memories" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "user_memories" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);

-- The service writes via raw INSERT without id/updated_at (Prisma normally
-- supplies both app-side). Defaults keep raw writes valid without affecting
-- Prisma-managed writes, which always send explicit values.
ALTER TABLE "user_memories" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::text;
ALTER TABLE "user_memories" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

-- ON CONFLICT (user_id, content_hash) requires a UNIQUE index. Postgres
-- allows many NULL content_hash rows, so legacy rows are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS "user_memories_user_id_content_hash_key"
  ON "user_memories"("user_id", "content_hash");

-- Cosine ANN index for the recall ORDER BY embedding <=> query.
CREATE INDEX IF NOT EXISTS "user_memories_embedding_cosine_idx"
  ON "user_memories" USING hnsw ("embedding" vector_cosine_ops);

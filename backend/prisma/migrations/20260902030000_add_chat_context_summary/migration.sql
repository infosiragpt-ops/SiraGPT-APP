-- Rolling context compaction (services/conversation-compactor): persisted
-- summary of the turns older than context_summary_until. Additive only,
-- nullable columns, no backfill.

ALTER TABLE "chats" ADD COLUMN "context_summary" TEXT;
ALTER TABLE "chats" ADD COLUMN "context_summary_until" TIMESTAMP(3);
ALTER TABLE "chats" ADD COLUMN "context_summary_meta" JSONB;

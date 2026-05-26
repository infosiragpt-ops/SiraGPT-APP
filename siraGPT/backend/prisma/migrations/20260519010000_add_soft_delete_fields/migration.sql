-- Soft-delete framework for improvement cycle 14.
-- All new columns are NULLABLE so existing rows are unaffected: a NULL
-- value means "row is alive". The hard-delete cron purges rows with
-- `deletedAt < now() - INTERVAL '30 days'` (see
-- backend/src/jobs/hard-delete-deleted-users.js).
--
-- Indexes use the (userId, deletedAt) partial form where applicable so
-- the common "list alive rows for this user" query stays index-only.
-- All DDL is IF NOT EXISTS so this migration is safely re-runnable.

-- users: account-level soft delete (drives the 30-day GDPR grace window)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "users_deletedAt_idx" ON "users"("deletedAt");

-- messages: mirrors chats.deletedAt so the cascade query stays cheap
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "messages_chatId_deletedAt_idx"
  ON "messages"("chatId", "deletedAt");

-- files: GDPR soft-delete on uploads
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "files_userId_deletedAt_idx"
  ON "files"("userId", "deletedAt");

-- projects: soft-delete tombstone
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "projects_userId_deletedAt_idx"
  ON "projects"("userId", "deletedAt");

-- custom_gpts: creator-driven soft-delete
ALTER TABLE "custom_gpts" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "custom_gpts_creatorId_deletedAt_idx"
  ON "custom_gpts"("creatorId", "deletedAt");

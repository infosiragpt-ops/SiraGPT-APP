-- Persistent app pins per conversation (Apps panel + composer rail).
-- Additive only: nullable JSONB column + integer revision; no backfill.

ALTER TABLE "chats" ADD COLUMN "pinned_app_ids" JSONB;
ALTER TABLE "chats" ADD COLUMN "pin_revision" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "chats_userId_updatedAt_idx" ON "chats"("userId", "updatedAt");

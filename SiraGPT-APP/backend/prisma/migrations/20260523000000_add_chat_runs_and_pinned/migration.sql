-- Sprint 3: ChatRun persistence + chat pin/archive/draft additions.
-- All operations are additive (new columns/tables/indices, no destructive ops).

-- 1) Chat: pin + draft.
ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "isPinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "pinnedAt" TIMESTAMP(3);
ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "draftText" TEXT;
CREATE INDEX IF NOT EXISTS "chats_userId_isPinned_pinnedAt_idx"
  ON "chats" ("userId", "isPinned", "pinnedAt");

-- 2) ChatRunStatus enum.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChatRunStatus') THEN
    CREATE TYPE "ChatRunStatus" AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled');
  END IF;
END $$;

-- 3) ChatRun table.
CREATE TABLE IF NOT EXISTS "chat_runs" (
  "id"              TEXT NOT NULL,
  "chatId"          TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "status"          "ChatRunStatus" NOT NULL DEFAULT 'pending',
  "model"           TEXT NOT NULL,
  "provider"        TEXT,
  "promptMessageId" TEXT,
  "messageId"       TEXT,
  "partialContent"  TEXT NOT NULL DEFAULT '',
  "inputPayload"    JSONB NOT NULL,
  "error"           TEXT,
  "errorClass"      TEXT,
  "jobId"           TEXT,
  "startedAt"       TIMESTAMP(3),
  "lastChunkAt"     TIMESTAMP(3),
  "completedAt"     TIMESTAMP(3),
  "cancelledAt"     TIMESTAMP(3),
  "cancelReason"    TEXT,
  "attempt"         INTEGER NOT NULL DEFAULT 0,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "chat_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "chat_runs_messageId_key" ON "chat_runs" ("messageId");
CREATE INDEX IF NOT EXISTS "chat_runs_chatId_status_idx" ON "chat_runs" ("chatId", "status");
CREATE INDEX IF NOT EXISTS "chat_runs_userId_status_updatedAt_idx" ON "chat_runs" ("userId", "status", "updatedAt");
CREATE INDEX IF NOT EXISTS "chat_runs_status_createdAt_idx" ON "chat_runs" ("status", "createdAt");

-- Partial unique index — enforce "at most one non-terminal run per chat"
-- at the database level. Prisma can't express partial unique indexes
-- declaratively, so it lives only in this migration. The route layer
-- maps the resulting 23505 / P2002 to HTTP 409 with a "wait for the
-- previous reply" hint.
CREATE UNIQUE INDEX IF NOT EXISTS "chat_runs_one_running_per_chat"
  ON "chat_runs" ("chatId") WHERE "status" IN ('pending', 'running');

-- 4) FKs.
ALTER TABLE "chat_runs"
  ADD CONSTRAINT "chat_runs_chatId_fkey"
  FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_runs"
  ADD CONSTRAINT "chat_runs_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5) Message.runId — link assistant rows to their producing run.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "runId" TEXT;
CREATE INDEX IF NOT EXISTS "messages_runId_idx" ON "messages" ("runId");
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "chat_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

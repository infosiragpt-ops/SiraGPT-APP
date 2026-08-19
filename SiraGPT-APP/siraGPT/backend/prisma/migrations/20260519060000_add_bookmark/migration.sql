-- Bookmarks — per-user favourites on individual messages. The
-- optional `note` field lets the user annotate why this message
-- matters ("the answer that fixed the bug", "good prompt template").
-- Unique (userId, messageId) prevents duplicate stars.

CREATE TABLE IF NOT EXISTS "bookmarks" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "note"      TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bookmarks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "bookmarks_userId_messageId_key"
  ON "bookmarks"("userId", "messageId");
CREATE INDEX IF NOT EXISTS "bookmarks_userId_createdAt_idx"
  ON "bookmarks"("userId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookmarks_userId_fkey'
  ) THEN
    ALTER TABLE "bookmarks"
      ADD CONSTRAINT "bookmarks_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookmarks_messageId_fkey'
  ) THEN
    ALTER TABLE "bookmarks"
      ADD CONSTRAINT "bookmarks_messageId_fkey"
      FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

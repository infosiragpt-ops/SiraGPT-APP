-- Saved searches — user-named queries that the UI can replay with
-- one click. `filters` is a free-form JSON bag (chatId, dateRange,
-- role, etc.) so we don't need a schema change every time the
-- search panel grows a new toggle.

CREATE TABLE IF NOT EXISTS "saved_searches" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "query"     TEXT NOT NULL,
  "filters"   JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "saved_searches_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "saved_searches_userId_createdAt_idx"
  ON "saved_searches"("userId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'saved_searches_userId_fkey'
  ) THEN
    ALTER TABLE "saved_searches"
      ADD CONSTRAINT "saved_searches_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

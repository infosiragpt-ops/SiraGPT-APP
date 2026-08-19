-- Ratchet 45 — persistent AI cost-tracker.
--
-- Daily aggregate of AI request cost by (date, userId, model,
-- provider, organizationId). The in-process cost-tracker flushes
-- in-memory records into this table once a day (05:00 UTC default)
-- via cost-tracker.flushDaily(). Reports older than 24h are served
-- from this table; recent rows continue to come from in-memory state.

CREATE TABLE IF NOT EXISTS "cost_usage_daily" (
  "id"             TEXT NOT NULL,
  "userId"         TEXT NOT NULL DEFAULT '',
  "organizationId" TEXT NOT NULL DEFAULT '',
  "date"           DATE NOT NULL,
  "model"          TEXT NOT NULL,
  "provider"       TEXT NOT NULL DEFAULT '',
  "inputTokens"    BIGINT NOT NULL DEFAULT 0,
  "outputTokens"   BIGINT NOT NULL DEFAULT 0,
  "costUSD"        DOUBLE PRECISION NOT NULL DEFAULT 0,
  "requests"       INTEGER NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cost_usage_daily_pkey" PRIMARY KEY ("id")
);

-- Compound uniqueness so flushDaily() can upsert without double-counting.
-- userId / provider / organizationId are NOT NULL DEFAULT '' so the
-- upsert works for anonymous + org-less rows (Postgres treats NULLs as
-- distinct in unique indexes, which would break upsert semantics).
CREATE UNIQUE INDEX IF NOT EXISTS "cost_usage_daily_unique"
  ON "cost_usage_daily" ("date", "userId", "model", "provider", "organizationId");

CREATE INDEX IF NOT EXISTS "cost_usage_daily_date_idx"
  ON "cost_usage_daily" ("date");

CREATE INDEX IF NOT EXISTS "cost_usage_daily_userId_date_idx"
  ON "cost_usage_daily" ("userId", "date");

CREATE INDEX IF NOT EXISTS "cost_usage_daily_organizationId_date_idx"
  ON "cost_usage_daily" ("organizationId", "date");

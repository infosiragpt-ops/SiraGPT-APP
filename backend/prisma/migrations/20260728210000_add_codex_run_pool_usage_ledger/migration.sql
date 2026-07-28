-- Lote 1: durable run attribution and autonomous usage accounting.
-- Additive and idempotent so a partially applied release can be resumed without
-- modifying existing runs, projects, swarms or department pools.

ALTER TABLE "codex_runs"
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT,
  ADD COLUMN IF NOT EXISTS "departmentPoolId" TEXT,
  ADD COLUMN IF NOT EXISTS "swarmTaskId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "codex_runs_idempotencyKey_key"
  ON "codex_runs"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "codex_runs_departmentPoolId_createdAt_idx"
  ON "codex_runs"("departmentPoolId", "createdAt");
CREATE INDEX IF NOT EXISTS "codex_runs_swarmTaskId_createdAt_idx"
  ON "codex_runs"("swarmTaskId", "createdAt");

CREATE TABLE IF NOT EXISTS "codex_usage_entries" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "departmentPoolId" TEXT,
  "source" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "tokensIn" INTEGER NOT NULL DEFAULT 0,
  "tokensOut" INTEGER NOT NULL DEFAULT 0,
  "model" TEXT,
  "costSource" TEXT,
  "costOriginalUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "costAppliedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "costInputUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "costOutputUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "codex_usage_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "codex_usage_entries_idempotencyKey_key"
  ON "codex_usage_entries"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "codex_usage_entries_projectId_createdAt_idx"
  ON "codex_usage_entries"("projectId", "createdAt");
CREATE INDEX IF NOT EXISTS "codex_usage_entries_departmentPoolId_createdAt_idx"
  ON "codex_usage_entries"("departmentPoolId", "createdAt");
CREATE INDEX IF NOT EXISTS "codex_usage_entries_source_sourceId_idx"
  ON "codex_usage_entries"("source", "sourceId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'codex_usage_entries_projectId_fkey'
  ) THEN
    ALTER TABLE "codex_usage_entries"
      ADD CONSTRAINT "codex_usage_entries_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "codex_projects"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

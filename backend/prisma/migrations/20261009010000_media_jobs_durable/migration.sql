-- Media execution is authoritative in Postgres. No existing row is deleted.
CREATE TABLE "media_jobs" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "chat_id" TEXT REFERENCES "chats"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "lane" TEXT NOT NULL CHECK (lane IN ('image','video','voice')),
  "kind" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "public_input" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled','unknown')),
  "phase" TEXT NOT NULL DEFAULT 'Encolado',
  "progress" INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "lease_token" TEXT,
  "lease_until" TIMESTAMP(3),
  "cancel_requested_at" TIMESTAMP(3),
  "checkpoint" JSONB NOT NULL DEFAULT '{}',
  "result" JSONB,
  "error_code" TEXT,
  "error_message" TEXT,
  "quota_reserved_units" BIGINT NOT NULL DEFAULT 0 CHECK (quota_reserved_units >= 0),
  "quota_used_units" BIGINT CHECK (quota_used_units >= 0),
  "quota_epoch" BIGINT NOT NULL DEFAULT 0,
  "quota_settled_at" TIMESTAMP(3),
  "pricing_snapshot" JSONB,
  "estimated_cost_usd" NUMERIC(18,8),
  "actual_cost_usd" NUMERIC(18,8),
  "cost_source" TEXT NOT NULL DEFAULT 'unknown',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC',clock_timestamp()),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC',clock_timestamp()),
  "finished_at" TIMESTAMP(3),
  UNIQUE ("user_id", "idempotency_key")
);
CREATE INDEX "media_jobs_owner_created_idx" ON "media_jobs"("user_id","lane","created_at" DESC);
CREATE INDEX "media_jobs_dispatch_idx" ON "media_jobs"("status","lease_until","created_at");
-- Admission takes the user's row lock too; this is a final DB invariant.
CREATE UNIQUE INDEX "media_jobs_voice_active_user_idx" ON "media_jobs"("user_id")
  WHERE lane='voice' AND status IN ('queued','running');
CREATE TABLE "media_job_events" (
  "id" BIGSERIAL PRIMARY KEY,
  "job_id" TEXT NOT NULL REFERENCES "media_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "seq" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC',clock_timestamp()),
  UNIQUE ("job_id","seq")
);
CREATE INDEX "media_job_events_replay_idx" ON "media_job_events"("job_id","seq");
-- Unknown prices are unknown, not $0 or a made-up per-token conversion.
ALTER TABLE "api_usage" ALTER COLUMN "cost" DROP NOT NULL;
-- Release prerequisite: drain legacy voice jobs before switching workers.
-- Do not rewrite statuses of live legacy jobs while applying a migration.

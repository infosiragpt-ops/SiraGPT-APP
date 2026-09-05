-- Additive only. Postgres is the authority; BullMQ contains IDs, never documents.
CREATE TABLE "doc_jobs" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "admission_ready" BOOLEAN NOT NULL DEFAULT false,
  "mode" TEXT NOT NULL DEFAULT 'preserve',
  "engine" TEXT NOT NULL DEFAULT 'anthropic',
  "model_tier" TEXT NOT NULL,
  "instructions_key" TEXT NOT NULL,
  "input_keys" TEXT[] NOT NULL,
  "output_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "edit_plan_key" TEXT,
  "edit_plan_hash" TEXT,
  "validation_report_key" TEXT,
  "error_code" TEXT,
  "outcome" TEXT,
  "usage" JSONB NOT NULL DEFAULT '{}',
  "cost_usd" DECIMAL(18,8) NOT NULL DEFAULT 0,
  "max_cost_usd" DECIMAL(18,8) NOT NULL DEFAULT 0 CHECK (max_cost_usd >= 0),
  "cost_reservations" JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(cost_reservations) = 'array'),
  "purged_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "storage_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "fence" INTEGER NOT NULL DEFAULT 0,
  "lease_token" TEXT,
  "lease_expires_at" TIMESTAMPTZ(3),
  "event_seq" INTEGER NOT NULL DEFAULT 0,
  "session_ref" TEXT,
  "provider_files" JSONB NOT NULL DEFAULT '[]',
  "provider_containers" JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(provider_containers) = 'array'),
  "attempt_leases" JSONB NOT NULL DEFAULT '[]',
  "cleanup_pending" BOOLEAN NOT NULL DEFAULT false,
  "cleanup_not_before" TIMESTAMPTZ(3),
  "parent_job_id" TEXT REFERENCES "doc_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "idempotency_key" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "prompt_version" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ(3),
  "finished_at" TIMESTAMPTZ(3),
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "deleted_at" TIMESTAMPTZ(3),
  CONSTRAINT "doc_jobs_status_check" CHECK (status IN ('queued','inspecting','planning','awaiting_approval','editing','validating','done','failed','cancelled')),
  CONSTRAINT "doc_jobs_mode_check" CHECK (mode IN ('preserve','tracked_changes','approval','reformat','batch')),
  CONSTRAINT "doc_jobs_tier_check" CHECK (model_tier IN ('mechanical','academic')),
  CONSTRAINT "doc_jobs_attempts_check" CHECK (attempts BETWEEN 0 AND 3 AND fence >= 0 AND event_seq >= 0),
  CONSTRAINT "doc_jobs_cost_check" CHECK (cost_usd >= 0),
  CONSTRAINT "doc_jobs_payload_hash_check" CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "doc_jobs_plan_hash_check" CHECK (edit_plan_hash IS NULL OR edit_plan_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "doc_jobs_lease_check" CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT "doc_jobs_outcome_check" CHECK (outcome IS NULL OR outcome IN ('edited','unchanged','not_possible')),
  CONSTRAINT "doc_jobs_done_gate" CHECK ((status = 'done') = (outcome IS NOT NULL) AND (status <> 'done' OR (validation_report_key IS NOT NULL AND edit_plan_hash IS NOT NULL))),
  CONSTRAINT "doc_jobs_delete_check" CHECK (deleted_at IS NULL OR status IN ('done','failed','cancelled')),
  CONSTRAINT "doc_jobs_provider_files_check" CHECK (jsonb_typeof(provider_files) = 'array')
);
CREATE UNIQUE INDEX "doc_jobs_user_id_idempotency_key_key" ON "doc_jobs"("user_id", "idempotency_key");
CREATE INDEX "doc_jobs_user_id_created_at_idx" ON "doc_jobs"("user_id", "created_at");
CREATE INDEX "doc_jobs_status_lease_expires_at_idx" ON "doc_jobs"("status", "lease_expires_at");
CREATE INDEX "doc_jobs_expires_at_idx" ON "doc_jobs"("expires_at");
CREATE INDEX "doc_jobs_cleanup_pending_idx" ON "doc_jobs"("cleanup_pending");

CREATE TABLE "doc_job_events" (
  "id" TEXT PRIMARY KEY,
  "job_id" TEXT NOT NULL REFERENCES "doc_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "seq" INTEGER NOT NULL CHECK (seq > 0),
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "outbox" TEXT CHECK (outbox IN ('enqueue','cleanup')),
  "dispatched_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "doc_job_events_job_id_seq_key" ON "doc_job_events"("job_id", "seq");
CREATE INDEX "doc_job_events_outbox_dispatched_at_created_at_idx" ON "doc_job_events"("outbox", "dispatched_at", "created_at");

CREATE TABLE "doc_job_artifacts" (
  "id" TEXT PRIMARY KEY,
  "job_id" TEXT NOT NULL REFERENCES "doc_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "attempt" INTEGER NOT NULL CHECK (attempt BETWEEN 0 AND 3),
  "kind" TEXT NOT NULL CHECK (kind IN ('input','output','edit_plan','recipe','agent_result','validation_report','thumbnail_before','thumbnail_after','text_diff','transcript')),
  "storage_key" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "mime" TEXT NOT NULL,
  "size" BIGINT NOT NULL CHECK (size >= 0),
  "sha256" TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  "published" BOOLEAN NOT NULL DEFAULT false,
  "purged_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "doc_job_artifacts_storage_key_key" ON "doc_job_artifacts"("storage_key");
CREATE INDEX "doc_job_artifacts_job_id_kind_idx" ON "doc_job_artifacts"("job_id", "kind");

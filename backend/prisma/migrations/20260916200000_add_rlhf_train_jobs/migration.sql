-- RLHF phase 3: durable admin-triggered SFT/DPO prep jobs.
-- Artifact bytes live in object storage; this table only stores status
-- and pointers. Additive — preference_events is untouched.

CREATE TABLE IF NOT EXISTS "rlhf_train_jobs" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "stage" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "format" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "scope_user_id" TEXT,
    "include_rlaif" BOOLEAN NOT NULL DEFAULT false,
    "min_pairs" INTEGER NOT NULL DEFAULT 1,
    "scrub_pii" BOOLEAN NOT NULL DEFAULT true,
    "submit_requested" BOOLEAN NOT NULL DEFAULT false,
    "filters" JSONB,
    "result" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "rlhf_train_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "rlhf_train_jobs_status_created_at_idx"
    ON "rlhf_train_jobs" ("status", "created_at");

CREATE INDEX IF NOT EXISTS "rlhf_train_jobs_created_by_id_created_at_idx"
    ON "rlhf_train_jobs" ("created_by_id", "created_at");

CREATE INDEX IF NOT EXISTS "rlhf_train_jobs_scope_created_at_idx"
    ON "rlhf_train_jobs" ("scope", "created_at");

ALTER TABLE "rlhf_train_jobs"
    ADD CONSTRAINT "rlhf_train_jobs_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rlhf_train_jobs"
    ADD CONSTRAINT "rlhf_train_jobs_scope_user_id_fkey"
    FOREIGN KEY ("scope_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

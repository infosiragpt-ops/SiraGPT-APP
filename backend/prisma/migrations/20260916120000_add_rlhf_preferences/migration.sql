-- RLHF flywheel: durable human-preference events + reward-model snapshots.
-- Training rows are scoped to the user (GDPR cascade) and deliberately
-- have no FK to messages/chats so a message delete cannot wipe labels.

CREATE TABLE IF NOT EXISTS "preference_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "chat_id" TEXT,
    "message_id" TEXT,
    "prompt_message_id" TEXT,
    "pair_id" TEXT,
    "run_id" TEXT,
    "agent" TEXT,
    "source" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "prompt_text" TEXT NOT NULL,
    "response_text" TEXT NOT NULL,
    "prompt_hash" TEXT NOT NULL,
    "prompt_embedding" BYTEA,
    "response_embedding" BYTEA,
    "judge_score" JSONB,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preference_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "preference_events_user_id_created_at_idx"
    ON "preference_events" ("user_id", "created_at");

CREATE INDEX IF NOT EXISTS "preference_events_user_id_prompt_hash_idx"
    ON "preference_events" ("user_id", "prompt_hash");

CREATE INDEX IF NOT EXISTS "preference_events_user_id_run_id_idx"
    ON "preference_events" ("user_id", "run_id");

CREATE INDEX IF NOT EXISTS "preference_events_pair_id_idx"
    ON "preference_events" ("pair_id");

CREATE INDEX IF NOT EXISTS "preference_events_source_label_idx"
    ON "preference_events" ("source", "label");

ALTER TABLE "preference_events"
    ADD CONSTRAINT "preference_events_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "reward_model_snapshots" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "user_id" TEXT,
    "dim" INTEGER NOT NULL,
    "weights" BYTEA NOT NULL,
    "n_train" INTEGER NOT NULL,
    "n_pairs" INTEGER NOT NULL,
    "auc" DOUBLE PRECISION,
    "logloss" DOUBLE PRECISION,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_model_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "reward_model_snapshots_scope_user_id_active_idx"
    ON "reward_model_snapshots" ("scope", "user_id", "active");

CREATE INDEX IF NOT EXISTS "reward_model_snapshots_active_created_at_idx"
    ON "reward_model_snapshots" ("active", "created_at");

ALTER TABLE "reward_model_snapshots"
    ADD CONSTRAINT "reward_model_snapshots_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

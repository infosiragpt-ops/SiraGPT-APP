-- LangGraph-style durable checkpoints for internal orchestration.

CREATE TABLE IF NOT EXISTS agent_checkpoints (
    thread_id            TEXT        NOT NULL,
    checkpoint_id        TEXT        NOT NULL,
    parent_checkpoint_id TEXT,
    state                JSONB       NOT NULL DEFAULT '{}'::jsonb,
    metadata             JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (thread_id, checkpoint_id)
);

CREATE INDEX IF NOT EXISTS agent_checkpoints_thread_created_idx
    ON agent_checkpoints (thread_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_checkpoints_state_gin_idx
    ON agent_checkpoints USING GIN (state);

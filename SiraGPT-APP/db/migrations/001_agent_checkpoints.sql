CREATE TABLE IF NOT EXISTS agent_checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  state JSONB NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, checkpoint_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_state ON agent_checkpoints USING GIN (state);
CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_created_at ON agent_checkpoints (created_at DESC);

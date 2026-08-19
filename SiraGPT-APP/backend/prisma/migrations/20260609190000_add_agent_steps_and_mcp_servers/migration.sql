-- Agent harness (Phase 1)
--
-- 1. agent_steps: full-fidelity trace of each agent-turn step (reasoning
--    burst / tool call) FK'd to the assistant message that produced it, so
--    chat history re-renders complete AgentTrace timelines.
-- 2. messages.agent_metadata: compact JSONB projection of the run (status,
--    totals, per-step previews) the history endpoint returns inline.
-- 3. mcp_servers: user-registered external MCP servers (auth headers stored
--    encrypted; tools discovered per turn and namespaced mcp__srv__tool).
--
-- All statements are idempotent (IF NOT EXISTS) — safe to re-apply.

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "agent_metadata" JSONB;

CREATE TABLE IF NOT EXISTS "agent_steps" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "step_index" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "tool_name" TEXT,
    "args" JSONB,
    "result" JSONB,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "duration_ms" INTEGER,
    "is_error" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_steps_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "agent_steps_message_id_step_index_idx"
    ON "agent_steps"("message_id", "step_index");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'agent_steps_message_id_fkey'
    ) THEN
        ALTER TABLE "agent_steps"
            ADD CONSTRAINT "agent_steps_message_id_fkey"
            FOREIGN KEY ("message_id") REFERENCES "messages"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS "mcp_servers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "transport" TEXT NOT NULL DEFAULT 'streamable-http',
    "headers_encrypted" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_servers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "mcp_servers_user_id_name_key"
    ON "mcp_servers"("user_id", "name");

CREATE INDEX IF NOT EXISTS "mcp_servers_user_id_enabled_idx"
    ON "mcp_servers"("user_id", "enabled");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'mcp_servers_user_id_fkey'
    ) THEN
        ALTER TABLE "mcp_servers"
            ADD CONSTRAINT "mcp_servers_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- Observability: per-run correlation id on the agent step trace.
ALTER TABLE "agent_steps" ADD COLUMN IF NOT EXISTS "trace_id" TEXT;
CREATE INDEX IF NOT EXISTS "agent_steps_trace_id_idx" ON "agent_steps"("trace_id");

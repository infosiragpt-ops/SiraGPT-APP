-- Codex Agent V2 feature 05: per-run user prompt/context for the agent loop.
ALTER TABLE "codex_runs" ADD COLUMN "prompt" TEXT;

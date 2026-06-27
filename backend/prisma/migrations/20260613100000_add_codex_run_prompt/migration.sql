-- Codex Agent V2 feature 05: per-run user prompt/context for the agent loop.
-- Idempotent (IF NOT EXISTS): production already had this column from an earlier
-- apply, so the non-guarded form failed with 42701 -> P3009 -> boot abort. The
-- guard also lets start-with-migrations.js classify this as auto-rollback-safe
-- and self-recover on the next deploy.
ALTER TABLE "codex_runs" ADD COLUMN IF NOT EXISTS "prompt" TEXT;

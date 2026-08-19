-- Preserve the user's /code reasoning-depth choice across durable plan/build
-- continuation and browser reconnects. Additive and rollback-safe.
ALTER TABLE "codex_runs"
  ADD COLUMN IF NOT EXISTS "reasoningEffort" TEXT;

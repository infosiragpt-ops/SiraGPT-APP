-- Codex Agent V2 G4 (re-planning): a plan run may re-work an earlier plan given
-- the user's feedback. priorPlanRunId points at the plan run whose plan_proposed
-- is the starting point; feedback is the user's requested adjustment.
-- Idempotent (IF NOT EXISTS) so a re-apply on an already-migrated prod DB is a
-- no-op instead of a 42701 -> P3009 boot abort.
ALTER TABLE "codex_runs" ADD COLUMN IF NOT EXISTS "priorPlanRunId" TEXT;
ALTER TABLE "codex_runs" ADD COLUMN IF NOT EXISTS "feedback" TEXT;

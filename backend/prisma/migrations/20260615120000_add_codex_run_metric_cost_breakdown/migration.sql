-- Codex Agent V2 feature 08: Agent Usage detail — model behind the run and the
-- per-direction (input/output) applied cost breakdown for the run-summary card.
ALTER TABLE "codex_run_metrics" ADD COLUMN "model" TEXT;
ALTER TABLE "codex_run_metrics" ADD COLUMN "costInputUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "codex_run_metrics" ADD COLUMN "costOutputUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;

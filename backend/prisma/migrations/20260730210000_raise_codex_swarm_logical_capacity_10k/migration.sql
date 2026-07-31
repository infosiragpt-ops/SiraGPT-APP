-- Raise durable swarm logical capacity from 1_000 → 10_000 agents and
-- effective research concurrency from 128 → 256. Additive only: drop/recreate
-- CHECK constraints; no data loss.

ALTER TABLE "codex_swarms" DROP CONSTRAINT IF EXISTS "codex_swarms_task_limit_check";
ALTER TABLE "codex_swarms" DROP CONSTRAINT IF EXISTS "codex_swarms_concurrency_check";

ALTER TABLE "codex_swarms"
  ALTER COLUMN "taskLimit" SET DEFAULT 10000,
  ALTER COLUMN "maxConcurrency" SET DEFAULT 64;

ALTER TABLE "codex_swarms"
  ADD CONSTRAINT "codex_swarms_task_limit_check"
    CHECK ("taskLimit" BETWEEN 1 AND 10000);

ALTER TABLE "codex_swarms"
  ADD CONSTRAINT "codex_swarms_concurrency_check"
    CHECK ("maxConcurrency" BETWEEN 1 AND 256);

ALTER TABLE "codex_swarm_tasks" DROP CONSTRAINT IF EXISTS "codex_swarm_tasks_ordinal_check";

ALTER TABLE "codex_swarm_tasks"
  ADD CONSTRAINT "codex_swarm_tasks_ordinal_check"
    CHECK ("ordinal" BETWEEN 0 AND 9999);

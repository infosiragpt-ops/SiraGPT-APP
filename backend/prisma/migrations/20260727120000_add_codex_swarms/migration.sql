-- Persistent coding-swarm control plane. This migration is additive: it does
-- not alter or remove existing Codex projects, runs or user data.

CREATE TABLE "codex_swarms" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "strategy" TEXT NOT NULL DEFAULT 'dag',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "taskLimit" INTEGER NOT NULL DEFAULT 1000,
    "maxConcurrency" INTEGER NOT NULL DEFAULT 16,
    "maxConcurrentWriters" INTEGER NOT NULL DEFAULT 4,
    "metadata" JSONB,
    "cancellationReason" TEXT,
    "cancelRequestedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "totalTaskCount" INTEGER NOT NULL DEFAULT 0,
    "queuedTaskCount" INTEGER NOT NULL DEFAULT 0,
    "blockedTaskCount" INTEGER NOT NULL DEFAULT 0,
    "runningTaskCount" INTEGER NOT NULL DEFAULT 0,
    "succeededTaskCount" INTEGER NOT NULL DEFAULT 0,
    "failedTaskCount" INTEGER NOT NULL DEFAULT 0,
    "cancelledTaskCount" INTEGER NOT NULL DEFAULT 0,
    "progressPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "codex_swarms_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "codex_swarms_strategy_check"
      CHECK ("strategy" IN ('dag', 'map_reduce')),
    CONSTRAINT "codex_swarms_status_check"
      CHECK ("status" IN (
        'queued',
        'running',
        'paused',
        'cancelling',
        'completed',
        'completed_with_errors',
        'failed',
        'cancelled'
      )),
    CONSTRAINT "codex_swarms_task_limit_check"
      CHECK ("taskLimit" BETWEEN 1 AND 1000),
    CONSTRAINT "codex_swarms_concurrency_check"
      CHECK ("maxConcurrency" BETWEEN 1 AND 128),
    CONSTRAINT "codex_swarms_writer_concurrency_check"
      CHECK (
        "maxConcurrentWriters" BETWEEN 1 AND 32
        AND "maxConcurrentWriters" <= "maxConcurrency"
      ),
    CONSTRAINT "codex_swarms_progress_check"
      CHECK ("progressPercent" BETWEEN 0 AND 100),
    CONSTRAINT "codex_swarms_counts_check"
      CHECK (
        "totalTaskCount" >= 0
        AND "queuedTaskCount" >= 0
        AND "blockedTaskCount" >= 0
        AND "runningTaskCount" >= 0
        AND "succeededTaskCount" >= 0
        AND "failedTaskCount" >= 0
        AND "cancelledTaskCount" >= 0
        AND "totalTaskCount" <= "taskLimit"
      )
);

CREATE TABLE "codex_swarm_tasks" (
    "id" TEXT NOT NULL,
    "swarmId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'work',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "dependsOn" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "input" JSONB,
    "result" JSONB,
    "error" TEXT,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "claimId" TEXT,
    "leaseOwner" TEXT,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "codex_swarm_tasks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "codex_swarm_tasks_ordinal_check"
      CHECK ("ordinal" BETWEEN 0 AND 999),
    CONSTRAINT "codex_swarm_tasks_role_check"
      CHECK ("role" IN ('writer', 'read-only', 'reviewer', 'integrator')),
    CONSTRAINT "codex_swarm_tasks_stage_check"
      CHECK ("stage" IN ('work', 'map', 'reduce', 'integrate')),
    CONSTRAINT "codex_swarm_tasks_status_check"
      CHECK ("status" IN (
        'queued',
        'blocked',
        'running',
        'succeeded',
        'failed',
        'cancelled'
      )),
    CONSTRAINT "codex_swarm_tasks_attempts_check"
      CHECK (
        "maxAttempts" BETWEEN 1 AND 20
        AND "attemptCount" >= 0
        AND "attemptCount" <= "maxAttempts"
      )
);

CREATE INDEX "codex_swarms_userId_status_updatedAt_idx"
  ON "codex_swarms"("userId", "status", "updatedAt");
CREATE INDEX "codex_swarms_projectId_createdAt_idx"
  ON "codex_swarms"("projectId", "createdAt");
CREATE INDEX "codex_swarms_status_updatedAt_idx"
  ON "codex_swarms"("status", "updatedAt");
CREATE UNIQUE INDEX "codex_swarms_project_active_key"
  ON "codex_swarms"("projectId")
  WHERE "status" IN ('queued', 'running', 'paused', 'cancelling');

CREATE UNIQUE INDEX "codex_swarm_tasks_claimId_key"
  ON "codex_swarm_tasks"("claimId");
CREATE UNIQUE INDEX "codex_swarm_tasks_leaseToken_key"
  ON "codex_swarm_tasks"("leaseToken");
CREATE UNIQUE INDEX "codex_swarm_tasks_swarmId_key_key"
  ON "codex_swarm_tasks"("swarmId", "key");
CREATE UNIQUE INDEX "codex_swarm_tasks_swarmId_ordinal_key"
  ON "codex_swarm_tasks"("swarmId", "ordinal");
CREATE INDEX "codex_swarm_tasks_swarmId_status_priority_ordinal_idx"
  ON "codex_swarm_tasks"("swarmId", "status", "priority", "ordinal");
CREATE INDEX "codex_swarm_tasks_swarmId_role_status_idx"
  ON "codex_swarm_tasks"("swarmId", "role", "status");
CREATE INDEX "codex_swarm_tasks_status_leaseExpiresAt_idx"
  ON "codex_swarm_tasks"("status", "leaseExpiresAt");

ALTER TABLE "codex_swarms"
  ADD CONSTRAINT "codex_swarms_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "codex_swarms"
  ADD CONSTRAINT "codex_swarms_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "codex_projects"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "codex_swarm_tasks"
  ADD CONSTRAINT "codex_swarm_tasks_swarmId_fkey"
  FOREIGN KEY ("swarmId") REFERENCES "codex_swarms"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

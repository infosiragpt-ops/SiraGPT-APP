-- Codex Agent V2 (flag CODEX_AGENT_V2) — spec docs/codex-agent-ux.md §4
-- Migración puramente aditiva: 6 tablas codex_* + índices + FKs.
-- Extraída de `prisma migrate diff --from-empty --to-schema-datamodel`.

-- CreateTable
CREATE TABLE "codex_projects" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'provisioning',
    "workspacePath" TEXT,
    "previewUrl" TEXT,
    "brief" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "codex_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codex_runs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "jobId" TEXT,
    "model" TEXT,
    "tier" TEXT,
    "planRunId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "codex_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codex_events" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "codex_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codex_actions" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "command" TEXT,
    "path" TEXT,
    "outputSummary" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "durationMs" INTEGER,
    "linesRead" INTEGER,
    "groupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "codex_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codex_checkpoints" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "codex_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codex_run_metrics" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "timeWorkedMs" INTEGER NOT NULL DEFAULT 0,
    "actionsCount" INTEGER NOT NULL DEFAULT 0,
    "itemsReadLines" INTEGER NOT NULL DEFAULT 0,
    "additions" INTEGER NOT NULL DEFAULT 0,
    "deletions" INTEGER NOT NULL DEFAULT 0,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costSource" TEXT NOT NULL DEFAULT 'estimated',
    "costOriginalUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costAppliedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "codex_run_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "codex_projects_userId_updatedAt_idx" ON "codex_projects"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "codex_runs_jobId_key" ON "codex_runs"("jobId");

-- CreateIndex
CREATE INDEX "codex_runs_projectId_createdAt_idx" ON "codex_runs"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "codex_runs_userId_status_updatedAt_idx" ON "codex_runs"("userId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "codex_events_runId_createdAt_idx" ON "codex_events"("runId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "codex_events_runId_seq_key" ON "codex_events"("runId", "seq");

-- CreateIndex
CREATE INDEX "codex_actions_runId_createdAt_idx" ON "codex_actions"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "codex_checkpoints_projectId_createdAt_idx" ON "codex_checkpoints"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "codex_run_metrics_runId_key" ON "codex_run_metrics"("runId");

-- AddForeignKey
ALTER TABLE "codex_projects" ADD CONSTRAINT "codex_projects_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_runs" ADD CONSTRAINT "codex_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_runs" ADD CONSTRAINT "codex_runs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "codex_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_events" ADD CONSTRAINT "codex_events_runId_fkey" FOREIGN KEY ("runId") REFERENCES "codex_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_actions" ADD CONSTRAINT "codex_actions_runId_fkey" FOREIGN KEY ("runId") REFERENCES "codex_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_checkpoints" ADD CONSTRAINT "codex_checkpoints_runId_fkey" FOREIGN KEY ("runId") REFERENCES "codex_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_checkpoints" ADD CONSTRAINT "codex_checkpoints_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "codex_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_run_metrics" ADD CONSTRAINT "codex_run_metrics_runId_fkey" FOREIGN KEY ("runId") REFERENCES "codex_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

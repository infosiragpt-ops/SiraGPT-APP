-- Scheduler engine: persisted job definitions and run history.

CREATE TABLE "scheduler_jobs" (
    "id"             TEXT NOT NULL,
    "name"           TEXT NOT NULL,
    "schedule"       TEXT NOT NULL,
    "enabled"        BOOLEAN NOT NULL DEFAULT TRUE,
    "state"          TEXT NOT NULL DEFAULT 'idle',
    "nextRunAt"      TIMESTAMP(3),
    "lastRunAt"      TIMESTAMP(3),
    "lastError"      TEXT,
    "runCount"       INTEGER NOT NULL DEFAULT 0,
    "successCount"   INTEGER NOT NULL DEFAULT 0,
    "failureCount"   INTEGER NOT NULL DEFAULT 0,
    "lockedBy"       TEXT,
    "lockedUntil"    TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduler_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "scheduler_jobs_nextRunAt_idx"   ON "scheduler_jobs" ("nextRunAt");
CREATE INDEX "scheduler_jobs_state_idx"       ON "scheduler_jobs" ("state");
CREATE INDEX "scheduler_jobs_lockedUntil_idx" ON "scheduler_jobs" ("lockedUntil");

CREATE TABLE "scheduler_runs" (
    "runId"      TEXT NOT NULL,
    "jobId"      TEXT NOT NULL,
    "startedAt"  TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "status"     TEXT NOT NULL,
    "attempt"    INTEGER NOT NULL DEFAULT 0,
    "error"      TEXT,
    "durationMs" INTEGER,

    CONSTRAINT "scheduler_runs_pkey" PRIMARY KEY ("runId")
);

CREATE INDEX "scheduler_runs_jobId_idx"     ON "scheduler_runs" ("jobId");
CREATE INDEX "scheduler_runs_startedAt_idx" ON "scheduler_runs" ("startedAt");
CREATE INDEX "scheduler_runs_status_idx"    ON "scheduler_runs" ("status");

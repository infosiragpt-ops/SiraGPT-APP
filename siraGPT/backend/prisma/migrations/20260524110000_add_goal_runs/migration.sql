-- Persistent /goal background runs (spec §F-goal).
--
-- Adds `goal_runs` + `goal_run_events`, the durable parent + child event
-- log driving the chat composer's `/goal X` slash command. The HTTP
-- route persists a row, enqueues a BullMQ job, and the worker keeps
-- running even after the user closes the tab. A future re-attach flow
-- replays the event log from `goal_run_events`.
--
-- Mirrors the agent_tasks + agent_task_events shape from migration
-- 20260516120000_add_agent_tasks. Aditiva. Sin DROP. Sigue el mismo
-- patrón que migration 20260523190000_add_password_reset.

CREATE TABLE IF NOT EXISTS "goal_runs" (
  "id"             TEXT PRIMARY KEY,
  "userId"         TEXT NOT NULL,
  "chatId"         TEXT,
  "jobId"          TEXT,
  "status"         TEXT NOT NULL DEFAULT 'queued',
  "prompt"         TEXT NOT NULL,
  "depth"          TEXT NOT NULL DEFAULT 'standard',
  "agentKind"      TEXT NOT NULL DEFAULT 'research',
  "papersCount"    INTEGER NOT NULL DEFAULT 0,
  "findingsCount"  INTEGER NOT NULL DEFAULT 0,
  "pagesCount"     INTEGER NOT NULL DEFAULT 0,
  "phase"          TEXT,
  "finalReport"    TEXT,
  "error"          TEXT,
  "cancelReason"   TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt"      TIMESTAMP(3),
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"    TIMESTAMP(3),
  "cancelledAt"    TIMESTAMP(3),
  "failedAt"       TIMESTAMP(3)
);

CREATE UNIQUE INDEX IF NOT EXISTS "goal_runs_jobId_key"
  ON "goal_runs"("jobId");
CREATE INDEX IF NOT EXISTS "goal_runs_userId_status_updatedAt_idx"
  ON "goal_runs"("userId", "status", "updatedAt");
CREATE INDEX IF NOT EXISTS "goal_runs_chatId_status_idx"
  ON "goal_runs"("chatId", "status");
CREATE INDEX IF NOT EXISTS "goal_runs_status_createdAt_idx"
  ON "goal_runs"("status", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'goal_runs_userId_fkey'
  ) THEN
    ALTER TABLE "goal_runs"
      ADD CONSTRAINT "goal_runs_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'goal_runs_chatId_fkey'
  ) THEN
    ALTER TABLE "goal_runs"
      ADD CONSTRAINT "goal_runs_chatId_fkey"
      FOREIGN KEY ("chatId") REFERENCES "chats"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "goal_run_events" (
  "id"         TEXT PRIMARY KEY,
  "goalRunId"  TEXT NOT NULL,
  "seq"        INTEGER NOT NULL,
  "type"       TEXT NOT NULL,
  "payload"    JSONB NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "goal_run_events_goalRunId_seq_key"
  ON "goal_run_events"("goalRunId", "seq");
CREATE INDEX IF NOT EXISTS "goal_run_events_goalRunId_createdAt_idx"
  ON "goal_run_events"("goalRunId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'goal_run_events_goalRunId_fkey'
  ) THEN
    ALTER TABLE "goal_run_events"
      ADD CONSTRAINT "goal_run_events_goalRunId_fkey"
      FOREIGN KEY ("goalRunId") REFERENCES "goal_runs"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

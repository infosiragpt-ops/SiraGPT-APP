-- Cowork control plane. Additive only: no existing rows, columns or data are
-- removed. Existing chats keep a NULL workspace mount.

CREATE TABLE "cowork_workspaces" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "cowork_workspaces_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "chats" ADD COLUMN "cowork_workspace_id" TEXT;

CREATE TABLE "cowork_files" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "storage_ref" TEXT NOT NULL,
    "artifact_id" TEXT,
    "size" INTEGER NOT NULL,
    "mime" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL DEFAULT 'user',
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "cowork_files_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cowork_runs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT,
    "workspaceId" TEXT,
    "parentRunId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "kind" TEXT NOT NULL DEFAULT 'chat',
    "prompt" TEXT NOT NULL,
    "checklist" JSONB,
    "maxSteps" INTEGER NOT NULL DEFAULT 12,
    "maxCostUsd" DOUBLE PRECISION,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tokensEstimate" INTEGER NOT NULL DEFAULT 0,
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "lastEvent" TEXT,
    "checkpoint" JSONB,
    "controlVersion" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "cowork_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cowork_file_versions" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "storage_ref" TEXT NOT NULL,
    "artifact_id" TEXT,
    "size" INTEGER NOT NULL,
    "mime" TEXT NOT NULL,
    "author_run_id" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cowork_file_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cowork_steering_notes" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),
    CONSTRAINT "cowork_steering_notes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_approvals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT,
    "runId" TEXT,
    "tool" TEXT NOT NULL,
    "args" JSONB,
    "humanDescription" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decision" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agent_approvals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "scheduled_agent_tasks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "prompt" TEXT NOT NULL,
    "cron_expr" TEXT NOT NULL,
    "tz" TEXT NOT NULL DEFAULT 'UTC',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "deliver" TEXT NOT NULL DEFAULT 'chat',
    "createdFrom" TEXT NOT NULL DEFAULT 'ui',
    "maxSteps" INTEGER NOT NULL DEFAULT 12,
    "maxCostUsd" DOUBLE PRECISION,
    "lockedBy" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "scheduled_agent_tasks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "connector_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accountLabel" TEXT,
    "authType" TEXT NOT NULL DEFAULT 'oauth2',
    "scopes" JSONB,
    "tokenEncrypted" TEXT,
    "configEncrypted" TEXT,
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "lastHealthAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "connector_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cowork_memories" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "fact" TEXT NOT NULL,
    "sourceChatId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cowork_memories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "runId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "inputSummary" TEXT,
    "resultSummary" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cowork_cost_daily" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "workspaceId" TEXT,
    "chatId" TEXT,
    "day" DATE NOT NULL,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tokensEstimate" INTEGER NOT NULL DEFAULT 0,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "cowork_cost_daily_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cowork_workspaces_userId_updatedAt_idx" ON "cowork_workspaces"("userId", "updatedAt");
CREATE INDEX "chats_cowork_workspace_id_idx" ON "chats"("cowork_workspace_id");
CREATE UNIQUE INDEX "cowork_files_workspaceId_path_key" ON "cowork_files"("workspaceId", "path");
CREATE INDEX "cowork_files_workspaceId_updatedAt_idx" ON "cowork_files"("workspaceId", "updatedAt");
CREATE INDEX "cowork_files_content_hash_idx" ON "cowork_files"("content_hash");
CREATE INDEX "cowork_runs_userId_status_updatedAt_idx" ON "cowork_runs"("userId", "status", "updatedAt");
CREATE INDEX "cowork_runs_chatId_status_idx" ON "cowork_runs"("chatId", "status");
CREATE INDEX "cowork_runs_workspaceId_updatedAt_idx" ON "cowork_runs"("workspaceId", "updatedAt");
CREATE INDEX "cowork_runs_parentRunId_idx" ON "cowork_runs"("parentRunId");
CREATE UNIQUE INDEX "cowork_file_versions_fileId_version_key" ON "cowork_file_versions"("fileId", "version");
CREATE INDEX "cowork_file_versions_author_run_id_idx" ON "cowork_file_versions"("author_run_id");
CREATE INDEX "cowork_file_versions_content_hash_idx" ON "cowork_file_versions"("content_hash");
CREATE INDEX "cowork_steering_notes_runId_status_createdAt_idx" ON "cowork_steering_notes"("runId", "status", "createdAt");
CREATE INDEX "cowork_steering_notes_userId_createdAt_idx" ON "cowork_steering_notes"("userId", "createdAt");
CREATE INDEX "agent_approvals_userId_status_expiresAt_idx" ON "agent_approvals"("userId", "status", "expiresAt");
CREATE INDEX "agent_approvals_chatId_status_idx" ON "agent_approvals"("chatId", "status");
CREATE INDEX "agent_approvals_runId_status_idx" ON "agent_approvals"("runId", "status");
CREATE INDEX "scheduled_agent_tasks_enabled_nextRunAt_idx" ON "scheduled_agent_tasks"("enabled", "nextRunAt");
CREATE INDEX "scheduled_agent_tasks_userId_createdAt_idx" ON "scheduled_agent_tasks"("userId", "createdAt");
CREATE INDEX "scheduled_agent_tasks_lockedUntil_idx" ON "scheduled_agent_tasks"("lockedUntil");
CREATE UNIQUE INDEX "connector_accounts_userId_provider_key" ON "connector_accounts"("userId", "provider");
CREATE INDEX "connector_accounts_userId_status_idx" ON "connector_accounts"("userId", "status");
CREATE INDEX "cowork_memories_workspaceId_createdAt_idx" ON "cowork_memories"("workspaceId", "createdAt");
CREATE INDEX "cowork_memories_userId_createdAt_idx" ON "cowork_memories"("userId", "createdAt");
CREATE INDEX "agent_audit_logs_userId_createdAt_idx" ON "agent_audit_logs"("userId", "createdAt");
CREATE INDEX "agent_audit_logs_workspaceId_createdAt_idx" ON "agent_audit_logs"("workspaceId", "createdAt");
CREATE INDEX "agent_audit_logs_runId_createdAt_idx" ON "agent_audit_logs"("runId", "createdAt");
CREATE INDEX "agent_audit_logs_action_createdAt_idx" ON "agent_audit_logs"("action", "createdAt");
CREATE UNIQUE INDEX "cowork_cost_daily_userId_scopeKey_day_key" ON "cowork_cost_daily"("userId", "scopeKey", "day");
CREATE INDEX "cowork_cost_daily_userId_day_idx" ON "cowork_cost_daily"("userId", "day");
CREATE INDEX "cowork_cost_daily_workspaceId_day_idx" ON "cowork_cost_daily"("workspaceId", "day");
CREATE INDEX "cowork_cost_daily_chatId_day_idx" ON "cowork_cost_daily"("chatId", "day");

ALTER TABLE "cowork_workspaces" ADD CONSTRAINT "cowork_workspaces_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chats" ADD CONSTRAINT "chats_cowork_workspace_id_fkey"
  FOREIGN KEY ("cowork_workspace_id") REFERENCES "cowork_workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cowork_files" ADD CONSTRAINT "cowork_files_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "cowork_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cowork_runs" ADD CONSTRAINT "cowork_runs_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cowork_runs" ADD CONSTRAINT "cowork_runs_chatId_fkey"
  FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cowork_runs" ADD CONSTRAINT "cowork_runs_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "cowork_workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cowork_runs" ADD CONSTRAINT "cowork_runs_parentRunId_fkey"
  FOREIGN KEY ("parentRunId") REFERENCES "cowork_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cowork_file_versions" ADD CONSTRAINT "cowork_file_versions_fileId_fkey"
  FOREIGN KEY ("fileId") REFERENCES "cowork_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cowork_file_versions" ADD CONSTRAINT "cowork_file_versions_author_run_id_fkey"
  FOREIGN KEY ("author_run_id") REFERENCES "cowork_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cowork_steering_notes" ADD CONSTRAINT "cowork_steering_notes_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "cowork_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cowork_steering_notes" ADD CONSTRAINT "cowork_steering_notes_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_chatId_fkey"
  FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "cowork_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "scheduled_agent_tasks" ADD CONSTRAINT "scheduled_agent_tasks_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scheduled_agent_tasks" ADD CONSTRAINT "scheduled_agent_tasks_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "cowork_workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "connector_accounts" ADD CONSTRAINT "connector_accounts_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cowork_memories" ADD CONSTRAINT "cowork_memories_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cowork_memories" ADD CONSTRAINT "cowork_memories_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "cowork_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_audit_logs" ADD CONSTRAINT "agent_audit_logs_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_audit_logs" ADD CONSTRAINT "agent_audit_logs_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "cowork_workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "agent_audit_logs" ADD CONSTRAINT "agent_audit_logs_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "cowork_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cowork_cost_daily" ADD CONSTRAINT "cowork_cost_daily_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

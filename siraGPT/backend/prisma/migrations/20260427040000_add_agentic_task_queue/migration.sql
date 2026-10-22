-- Durable agentic runtime: task snapshots, resumable events and generated artifacts.

CREATE TABLE "agent_tasks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT,
    "jobId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "goal" TEXT NOT NULL,
    "model" TEXT,
    "traceId" TEXT,
    "documentPolicy" JSONB,
    "state" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),

    CONSTRAINT "agent_tasks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_task_events" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_task_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "generated_artifacts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "taskId" TEXT,
    "chatId" TEXT,
    "messageId" TEXT,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "path" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "previewHtml" TEXT,
    "validation" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generated_artifacts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_tasks_jobId_key" ON "agent_tasks"("jobId");
CREATE INDEX "agent_tasks_userId_updatedAt_idx" ON "agent_tasks"("userId", "updatedAt");
CREATE INDEX "agent_tasks_status_updatedAt_idx" ON "agent_tasks"("status", "updatedAt");
CREATE UNIQUE INDEX "agent_task_events_taskId_seq_key" ON "agent_task_events"("taskId", "seq");
CREATE INDEX "agent_task_events_taskId_createdAt_idx" ON "agent_task_events"("taskId", "createdAt");
CREATE INDEX "generated_artifacts_userId_createdAt_idx" ON "generated_artifacts"("userId", "createdAt");
CREATE INDEX "generated_artifacts_taskId_createdAt_idx" ON "generated_artifacts"("taskId", "createdAt");

ALTER TABLE "agent_tasks"
  ADD CONSTRAINT "agent_tasks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_tasks"
  ADD CONSTRAINT "agent_tasks_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "agent_task_events"
  ADD CONSTRAINT "agent_task_events_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "generated_artifacts"
  ADD CONSTRAINT "generated_artifacts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "generated_artifacts"
  ADD CONSTRAINT "generated_artifacts_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "agent_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "generated_artifacts"
  ADD CONSTRAINT "generated_artifacts_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "generated_artifacts"
  ADD CONSTRAINT "generated_artifacts_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

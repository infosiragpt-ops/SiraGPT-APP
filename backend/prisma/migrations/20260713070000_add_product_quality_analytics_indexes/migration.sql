-- Additive indexes for privacy-safe product quality analytics.
CREATE INDEX "users_lastActiveAt_idx"
ON "users"("lastActiveAt");

CREATE INDEX "messages_timestamp_feedback_idx"
ON "messages"("timestamp", "feedback");

CREATE INDEX "chat_runs_createdAt_idx"
ON "chat_runs"("createdAt");
CREATE INDEX "chat_runs_userId_createdAt_idx"
ON "chat_runs"("userId", "createdAt");
CREATE INDEX "chat_runs_completedAt_idx"
ON "chat_runs"("completedAt");
CREATE INDEX "chat_runs_cancelledAt_idx"
ON "chat_runs"("cancelledAt");
CREATE INDEX "chat_runs_status_updatedAt_idx"
ON "chat_runs"("status", "updatedAt");

CREATE INDEX "agent_tasks_createdAt_idx"
ON "agent_tasks"("createdAt");
CREATE INDEX "agent_tasks_userId_createdAt_idx"
ON "agent_tasks"("userId", "createdAt");
CREATE INDEX "agent_tasks_completedAt_idx"
ON "agent_tasks"("completedAt");
CREATE INDEX "agent_tasks_failedAt_idx"
ON "agent_tasks"("failedAt");
CREATE INDEX "agent_tasks_cancelledAt_idx"
ON "agent_tasks"("cancelledAt");

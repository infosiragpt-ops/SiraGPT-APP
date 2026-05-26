-- Performance indexes added in improvement cycle 8.
-- Covers foreign-key columns lacking indexes and frequent query patterns
-- (user-scoped time-range queries, status filters, FK lookups).
-- All indexes use CREATE INDEX IF NOT EXISTS so this migration is
-- safely re-runnable in environments where some indexes may already
-- exist from manual ops or partial replays.

-- sessions: lookup by user and expiry-based cleanup
CREATE INDEX IF NOT EXISTS "sessions_userId_idx" ON "sessions"("userId");
CREATE INDEX IF NOT EXISTS "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- chats: FK columns for project / customGpt lookups
CREATE INDEX IF NOT EXISTS "chats_customGptId_idx" ON "chats"("customGptId");
CREATE INDEX IF NOT EXISTS "chats_projectId_idx" ON "chats"("projectId");

-- agent_tasks: FK on chatId (chat -> tasks listings)
CREATE INDEX IF NOT EXISTS "agent_tasks_chatId_idx" ON "agent_tasks"("chatId");

-- message_shares: lookups by messageId / chatId
CREATE INDEX IF NOT EXISTS "message_shares_messageId_idx" ON "message_shares"("messageId");
CREATE INDEX IF NOT EXISTS "message_shares_chatId_idx" ON "message_shares"("chatId");

-- files: FK columns for customGpt / project bucket lookups
CREATE INDEX IF NOT EXISTS "files_customGptId_idx" ON "files"("customGptId");
CREATE INDEX IF NOT EXISTS "files_projectId_idx" ON "files"("projectId");

-- payments: user history + admin status filters with time ranges
CREATE INDEX IF NOT EXISTS "payments_userId_createdAt_idx" ON "payments"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "payments_status_createdAt_idx" ON "payments"("status", "createdAt");

-- api_usage: per-user analytics + per-model groupBy
CREATE INDEX IF NOT EXISTS "api_usage_userId_timestamp_idx" ON "api_usage"("userId", "timestamp");
CREATE INDEX IF NOT EXISTS "api_usage_model_timestamp_idx" ON "api_usage"("model", "timestamp");

-- usage_alerts: per-user history
CREATE INDEX IF NOT EXISTS "usage_alerts_userId_sentAt_idx" ON "usage_alerts"("userId", "sentAt");

-- notifications: unread badge + per-user list
CREATE INDEX IF NOT EXISTS "notifications_userId_createdAt_idx" ON "notifications"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "notifications_userId_read_idx" ON "notifications"("userId", "read");

-- subscription_events: per-user history + global event-type analytics
CREATE INDEX IF NOT EXISTS "subscription_events_userId_processedAt_idx" ON "subscription_events"("userId", "processedAt");
CREATE INDEX IF NOT EXISTS "subscription_events_eventType_processedAt_idx" ON "subscription_events"("eventType", "processedAt");

-- custom_gpts: creator dashboard + public featured listings
CREATE INDEX IF NOT EXISTS "custom_gpts_creatorId_updatedAt_idx" ON "custom_gpts"("creatorId", "updatedAt");
CREATE INDEX IF NOT EXISTS "custom_gpts_visibility_isFeatured_idx" ON "custom_gpts"("visibility", "isFeatured");

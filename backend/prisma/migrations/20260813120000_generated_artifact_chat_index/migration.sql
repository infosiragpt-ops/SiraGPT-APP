-- Follow-up lookups ("ahora ponlas rosadas") always need the latest artifact
-- for (userId, chatId), not a scan of the user's entire artifact history.
CREATE INDEX IF NOT EXISTS "generated_artifacts_userId_chatId_createdAt_idx"
ON "generated_artifacts" ("userId", "chatId", "createdAt");

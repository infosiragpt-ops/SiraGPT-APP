ALTER TABLE "codex_external_actions"
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "consumedAt" TIMESTAMP(3),
  ADD COLUMN "attemptId" TEXT,
  ADD COLUMN "revokedAt" TIMESTAMP(3);

CREATE INDEX "codex_external_actions_project_status_expiresAt_idx"
  ON "codex_external_actions"("projectId", "status", "expiresAt");

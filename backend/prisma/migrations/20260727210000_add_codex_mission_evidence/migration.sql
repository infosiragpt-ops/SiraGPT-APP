-- Durable mission evidence and CEO review chain. Additive only: no existing
-- table, column or row is modified or removed.

CREATE TABLE "codex_missions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "missionKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "objective" TEXT,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "source" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "contentHash" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "codex_missions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "codex_mission_artifacts" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "artifactKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'recorded',
    "source" TEXT NOT NULL,
    "sourceRef" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "contentHash" TEXT NOT NULL,
    "storageRef" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "codex_mission_artifacts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "codex_activity_reports" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "source" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "contentHash" TEXT NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "counts" JSONB NOT NULL,
    "delivery" JSONB NOT NULL,
    "author" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "codex_activity_reports_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "codex_ceo_approvals" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "missionId" TEXT,
    "reportId" TEXT,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "note" TEXT,
    "reviewerName" TEXT NOT NULL,
    "resourceHash" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'ceo_review',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "codex_ceo_approvals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "codex_missions_projectId_sourceRef_key"
  ON "codex_missions"("projectId", "sourceRef");
CREATE INDEX "codex_missions_userId_projectId_status_updatedAt_idx"
  ON "codex_missions"("userId", "projectId", "status", "updatedAt");
CREATE INDEX "codex_missions_projectId_missionKey_version_idx"
  ON "codex_missions"("projectId", "missionKey", "version");
CREATE INDEX "codex_missions_contentHash_idx"
  ON "codex_missions"("contentHash");

CREATE UNIQUE INDEX "codex_mission_artifacts_missionId_artifactKey_version_key"
  ON "codex_mission_artifacts"("missionId", "artifactKey", "version");
CREATE INDEX "codex_mission_artifacts_userId_projectId_createdAt_idx"
  ON "codex_mission_artifacts"("userId", "projectId", "createdAt");
CREATE INDEX "codex_mission_artifacts_projectId_type_status_idx"
  ON "codex_mission_artifacts"("projectId", "type", "status");
CREATE INDEX "codex_mission_artifacts_contentHash_idx"
  ON "codex_mission_artifacts"("contentHash");

CREATE UNIQUE INDEX "codex_activity_reports_projectId_reportKey_version_key"
  ON "codex_activity_reports"("projectId", "reportKey", "version");
CREATE INDEX "codex_activity_reports_userId_projectId_status_createdAt_idx"
  ON "codex_activity_reports"("userId", "projectId", "status", "createdAt");
CREATE INDEX "codex_activity_reports_contentHash_idx"
  ON "codex_activity_reports"("contentHash");

CREATE INDEX "codex_ceo_approvals_userId_projectId_createdAt_idx"
  ON "codex_ceo_approvals"("userId", "projectId", "createdAt");
CREATE INDEX "codex_ceo_approvals_resourceType_resourceId_createdAt_idx"
  ON "codex_ceo_approvals"("resourceType", "resourceId", "createdAt");
CREATE INDEX "codex_ceo_approvals_missionId_createdAt_idx"
  ON "codex_ceo_approvals"("missionId", "createdAt");
CREATE INDEX "codex_ceo_approvals_reportId_createdAt_idx"
  ON "codex_ceo_approvals"("reportId", "createdAt");

ALTER TABLE "codex_missions" ADD CONSTRAINT "codex_missions_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "codex_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "codex_missions" ADD CONSTRAINT "codex_missions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "codex_mission_artifacts" ADD CONSTRAINT "codex_mission_artifacts_missionId_fkey"
  FOREIGN KEY ("missionId") REFERENCES "codex_missions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "codex_mission_artifacts" ADD CONSTRAINT "codex_mission_artifacts_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "codex_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "codex_mission_artifacts" ADD CONSTRAINT "codex_mission_artifacts_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "codex_activity_reports" ADD CONSTRAINT "codex_activity_reports_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "codex_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "codex_activity_reports" ADD CONSTRAINT "codex_activity_reports_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "codex_ceo_approvals" ADD CONSTRAINT "codex_ceo_approvals_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "codex_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "codex_ceo_approvals" ADD CONSTRAINT "codex_ceo_approvals_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "codex_ceo_approvals" ADD CONSTRAINT "codex_ceo_approvals_missionId_fkey"
  FOREIGN KEY ("missionId") REFERENCES "codex_missions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "codex_ceo_approvals" ADD CONSTRAINT "codex_ceo_approvals_reportId_fkey"
  FOREIGN KEY ("reportId") REFERENCES "codex_activity_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

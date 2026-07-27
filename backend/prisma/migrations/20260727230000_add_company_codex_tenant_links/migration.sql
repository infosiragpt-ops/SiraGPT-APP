-- R2: durable Company ↔ CodexProject identity and connector assignment.
-- This migration is intentionally additive and idempotent. Existing rows stay
-- unlinked until an owner confirms them in the association wizard.

ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

ALTER TABLE "codex_projects"
  ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

ALTER TABLE "connector_accounts"
  ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

CREATE TABLE IF NOT EXISTS "company_codex_project_links" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "codexProjectId" TEXT NOT NULL,
  "organizationId" TEXT,
  "linkedByUserId" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "company_codex_project_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "company_codex_project_links_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "company_codex_project_links_codexProjectId_fkey"
    FOREIGN KEY ("codexProjectId") REFERENCES "codex_projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "company_codex_project_links_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "project_connector_assignments" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "connectorAccountId" TEXT NOT NULL,
  "organizationId" TEXT,
  "assignedByUserId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "capabilities" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_connector_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_connector_assignments_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "project_connector_assignments_connectorAccountId_fkey"
    FOREIGN KEY ("connectorAccountId") REFERENCES "connector_accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "project_connector_assignments_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "company_codex_project_links_projectId_key"
  ON "company_codex_project_links"("projectId");
CREATE UNIQUE INDEX IF NOT EXISTS "company_codex_project_links_codexProjectId_key"
  ON "company_codex_project_links"("codexProjectId");
CREATE INDEX IF NOT EXISTS "company_codex_project_links_organizationId_updatedAt_idx"
  ON "company_codex_project_links"("organizationId", "updatedAt");
CREATE INDEX IF NOT EXISTS "company_codex_project_links_linkedByUserId_updatedAt_idx"
  ON "company_codex_project_links"("linkedByUserId", "updatedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "project_connector_assignments_projectId_connectorAccountId_key"
  ON "project_connector_assignments"("projectId", "connectorAccountId");
CREATE INDEX IF NOT EXISTS "project_connector_assignments_organizationId_projectId_status_idx"
  ON "project_connector_assignments"("organizationId", "projectId", "status");
CREATE INDEX IF NOT EXISTS "project_connector_assignments_connectorAccountId_status_idx"
  ON "project_connector_assignments"("connectorAccountId", "status");
CREATE INDEX IF NOT EXISTS "project_connector_assignments_assignedByUserId_updatedAt_idx"
  ON "project_connector_assignments"("assignedByUserId", "updatedAt");

CREATE INDEX IF NOT EXISTS "projects_organizationId_updatedAt_idx"
  ON "projects"("organizationId", "updatedAt");
CREATE INDEX IF NOT EXISTS "codex_projects_organizationId_updatedAt_idx"
  ON "codex_projects"("organizationId", "updatedAt");
CREATE INDEX IF NOT EXISTS "connector_accounts_organizationId_status_idx"
  ON "connector_accounts"("organizationId", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'projects_organizationId_fkey'
  ) THEN
    ALTER TABLE "projects"
      ADD CONSTRAINT "projects_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'codex_projects_organizationId_fkey'
  ) THEN
    ALTER TABLE "codex_projects"
      ADD CONSTRAINT "codex_projects_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'connector_accounts_organizationId_fkey'
  ) THEN
    ALTER TABLE "connector_accounts"
      ADD CONSTRAINT "connector_accounts_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

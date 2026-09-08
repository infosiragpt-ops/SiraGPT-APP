-- B9 extends the durable Company identity already introduced by the channels
-- foundation. It never replaces existing company, channel, or project data.
ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "organizationId" TEXT,
  ADD COLUMN IF NOT EXISTS "brief" JSONB;

ALTER TABLE "company_codex_project_links"
  ADD COLUMN IF NOT EXISTS "companyId" TEXT;

-- Existing Company rows keep their identity and acquire tenant/profile context
-- only when it can be derived from an explicitly confirmed project link.
UPDATE "companies" AS company
SET
  "organizationId" = COALESCE(
    company."organizationId",
    link."organizationId",
    project."organizationId"
  ),
  "brief" = COALESCE(
    company."brief",
    codex."brief"->'companyProfile',
    '{}'::jsonb
  )
FROM "company_codex_project_links" AS link
JOIN "projects" AS project ON project."id" = link."projectId"
JOIN "codex_projects" AS codex ON codex."id" = link."codexProjectId"
WHERE company."projectId" = link."projectId";

-- Promote only confirmed links that do not already have a Company record.
INSERT INTO "companies" (
  "id",
  "userId",
  "projectId",
  "organizationId",
  "name",
  "mission",
  "vision",
  "urls",
  "industry",
  "brief",
  "createdAt",
  "updatedAt"
)
SELECT
  'company_' || link."id",
  project."userId",
  project."id",
  COALESCE(link."organizationId", project."organizationId"),
  COALESCE(
    NULLIF(codex."brief"->'companyProfile'->>'companyName', ''),
    project."name"
  ),
  NULLIF(codex."brief"->'companyProfile'->>'mission', ''),
  NULLIF(codex."brief"->'companyProfile'->>'vision', ''),
  CASE
    WHEN COALESCE(
      NULLIF(codex."brief"->'companyProfile'->>'websiteUrl', ''),
      NULLIF(codex."brief"->'publication'->>'url', '')
    ) IS NULL THEN NULL
    ELSE jsonb_build_object(
      'web',
      COALESCE(
        NULLIF(codex."brief"->'companyProfile'->>'websiteUrl', ''),
        NULLIF(codex."brief"->'publication'->>'url', '')
      ),
      'socials',
      '{}'::jsonb
    )
  END,
  NULLIF(codex."brief"->'companyProfile'->>'industry', ''),
  COALESCE(codex."brief"->'companyProfile', '{}'::jsonb),
  link."createdAt",
  CURRENT_TIMESTAMP
FROM "company_codex_project_links" AS link
JOIN "projects" AS project ON project."id" = link."projectId"
JOIN "codex_projects" AS codex ON codex."id" = link."codexProjectId"
ON CONFLICT ("projectId") DO NOTHING;

UPDATE "company_codex_project_links" AS link
SET "companyId" = company."id"
FROM "companies" AS company
WHERE link."companyId" IS NULL
  AND company."projectId" = link."projectId";

CREATE INDEX IF NOT EXISTS "companies_organizationId_updatedAt_idx"
  ON "companies"("organizationId", "updatedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "company_codex_project_links_companyId_key"
  ON "company_codex_project_links"("companyId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'companies_organizationId_fkey'
  ) THEN
    ALTER TABLE "companies"
      ADD CONSTRAINT "companies_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'company_codex_project_links_companyId_fkey'
  ) THEN
    ALTER TABLE "company_codex_project_links"
      ADD CONSTRAINT "company_codex_project_links_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "companies"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

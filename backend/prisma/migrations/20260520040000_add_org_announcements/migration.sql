-- Ratchet 45 — Org-wide announcements.
--
-- Adds the `org_announcements` table and `OrgAnnouncementSeverity`
-- enum so that ADMIN+ members can broadcast a banner-style message
-- to every member of the org. Rows can carry an optional
-- `expiresAt` after which the GET feed hides them, and a severity
-- level (info | warn | critical) so the UI can choose styling.
--
-- All operations are idempotent so the migration can be re-run
-- against partially-applied environments.

-- ─── OrgAnnouncementSeverity enum ───────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OrgAnnouncementSeverity') THEN
    CREATE TYPE "OrgAnnouncementSeverity" AS ENUM ('info', 'warn', 'critical');
  END IF;
END
$$;

-- ─── org_announcements table ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "org_announcements" (
  "id"            TEXT NOT NULL,
  "orgId"         TEXT NOT NULL,
  "title"         TEXT NOT NULL,
  "body"          TEXT NOT NULL,
  "createdById"   TEXT NOT NULL,
  "severity"      "OrgAnnouncementSeverity" NOT NULL DEFAULT 'info',
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"     TIMESTAMP(3),
  CONSTRAINT "org_announcements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "org_announcements_orgId_createdAt_idx"
  ON "org_announcements"("orgId", "createdAt");
CREATE INDEX IF NOT EXISTS "org_announcements_orgId_expiresAt_idx"
  ON "org_announcements"("orgId", "expiresAt");
CREATE INDEX IF NOT EXISTS "org_announcements_createdById_idx"
  ON "org_announcements"("createdById");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_announcements_orgId_fkey'
  ) THEN
    ALTER TABLE "org_announcements"
      ADD CONSTRAINT "org_announcements_orgId_fkey"
      FOREIGN KEY ("orgId") REFERENCES "organizations"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_announcements_createdById_fkey'
  ) THEN
    ALTER TABLE "org_announcements"
      ADD CONSTRAINT "org_announcements_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

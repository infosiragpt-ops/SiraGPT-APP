-- Ratchet 45 — Org announcement read receipts.
--
-- One row per (announcementId, userId) the first time a member
-- acknowledges they read an announcement. The GET feed joins against
-- this table for the requesting user to derive
-- `acknowledgedByCurrentUser` on every item.
--
-- All operations are idempotent so the migration can be re-run
-- against partially-applied environments.

-- ─── org_announcement_reads table ───────────────────────────────────
CREATE TABLE IF NOT EXISTS "org_announcement_reads" (
  "id"             TEXT NOT NULL,
  "announcementId" TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "readAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "org_announcement_reads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "org_announcement_reads_announcementId_userId_key"
  ON "org_announcement_reads"("announcementId", "userId");
CREATE INDEX IF NOT EXISTS "org_announcement_reads_userId_idx"
  ON "org_announcement_reads"("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_announcement_reads_announcementId_fkey'
  ) THEN
    ALTER TABLE "org_announcement_reads"
      ADD CONSTRAINT "org_announcement_reads_announcementId_fkey"
      FOREIGN KEY ("announcementId") REFERENCES "org_announcements"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_announcement_reads_userId_fkey'
  ) THEN
    ALTER TABLE "org_announcement_reads"
      ADD CONSTRAINT "org_announcement_reads_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

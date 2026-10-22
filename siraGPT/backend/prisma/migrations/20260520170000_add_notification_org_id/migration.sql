-- Ratchet 44 — org-scoped notifications inbox (cycle 165).
--
-- Cycle 128 introduced user-targeted in-app `Notification` rows. This
-- migration extends the schema with an optional `orgId` column so an
-- org admin can broadcast a notification to every matching member of
-- the org (optionally filtered by role) via
-- POST /api/orgs/:id/notifications. The broadcast endpoint fans out
-- one Notification row per recipient with the org id stamped here so
-- the FE inbox can group / filter by organization.
--
-- The column is nullable to preserve all existing user-scoped rows
-- (which were never associated with an org). No foreign-key constraint
-- is added: the relation is logical, the column is informational, and
-- we want orgs to be hard-deletable without cascading through every
-- historical notification.
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "orgId" TEXT;

-- Composite index for the upcoming "by org" inbox view + admin tooling
-- that lists every notification produced by a given broadcast.
CREATE INDEX IF NOT EXISTS "notifications_orgId_createdAt_idx"
  ON "notifications" ("orgId", "createdAt");

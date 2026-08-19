-- Project trash retention for APPS/Empresas.
--
-- `deletedAt` already marks a project as hidden. `deleteAfter` stores the
-- 30-day deadline shown to the owner so code workspaces are recoverable from
-- the Empresas trash instead of being hard-deleted immediately.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "deleteAfter" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "projects_userId_deleteAfter_idx"
  ON "projects"("userId", "deleteAfter");

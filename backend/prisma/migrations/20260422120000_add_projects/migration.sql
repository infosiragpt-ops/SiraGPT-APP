-- Projects — task-scoped workspaces bundling files + instructions into
-- chats. The AI route injects the project's description, instructions,
-- and attached file contents into the system prompt for every turn
-- whose chat belongs to the project.
--
-- This migration is IDEMPOTENT (uses IF NOT EXISTS / IF EXISTS guards)
-- so it can be re-run on an instance where `prisma db push` already
-- applied the same schema. Without the guards, re-applying would
-- clash with the existing columns and break restarts.
--
-- Known upstream issue: the migration history contains a date
-- inversion where `20241125_add_model_sync_fields` (Nov 2024) runs
-- BEFORE `20250919203029_init` (Sep 2025) creates the `ai_models`
-- table it targets. `prisma migrate deploy` from an empty database
-- therefore fails on the Nov migration. That predates Projects and is
-- tracked separately; this migration does NOT try to fix it.

-- ─── projects table ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "projects" (
    "id"           TEXT         NOT NULL,
    "userId"       TEXT         NOT NULL,
    "name"         TEXT         NOT NULL,
    "description"  TEXT,
    "instructions" TEXT,
    "isStarred"    BOOLEAN      NOT NULL DEFAULT false,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- Index supports the "most-recently-touched per user" queries the
-- /api/projects list endpoint uses.
CREATE INDEX IF NOT EXISTS "projects_userId_updatedAt_idx"
    ON "projects" ("userId", "updatedAt");

-- Owner FK — Cascade on delete so a removed user takes their projects
-- with them (matches the User → chats / files / gpts cascade pattern).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'projects_userId_fkey'
    ) THEN
        ALTER TABLE "projects"
        ADD CONSTRAINT "projects_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END$$;

-- ─── chats.projectId ───────────────────────────────────────────────────────

ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "projectId" TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'chats_projectId_fkey'
    ) THEN
        ALTER TABLE "chats"
        ADD CONSTRAINT "chats_projectId_fkey"
        FOREIGN KEY ("projectId") REFERENCES "projects"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END$$;

-- ─── files.projectId ───────────────────────────────────────────────────────

ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "projectId" TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'files_projectId_fkey'
    ) THEN
        ALTER TABLE "files"
        ADD CONSTRAINT "files_projectId_fkey"
        FOREIGN KEY ("projectId") REFERENCES "projects"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END$$;

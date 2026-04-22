-- Project documents — long-form writing surface, edited with Tiptap
-- and serialised to Markdown. See ProjectDocument in schema.prisma
-- for the rationale on keeping these separate from File.
--
-- Idempotent (IF NOT EXISTS) so it can re-run cleanly on instances
-- where `prisma db push` already applied the same change.

CREATE TABLE IF NOT EXISTS "project_documents" (
    "id"         TEXT         NOT NULL,
    "projectId"  TEXT         NOT NULL,
    "title"      TEXT         NOT NULL,
    "content"    TEXT         NOT NULL,
    "meta"       JSONB,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_documents_pkey" PRIMARY KEY ("id")
);

-- Hot query: "list this project's docs, newest-edit first".
CREATE INDEX IF NOT EXISTS "project_documents_projectId_updatedAt_idx"
    ON "project_documents" ("projectId", "updatedAt");

-- Cascade delete with the project — unlike Files (SetNull), documents
-- have no meaning outside their project, so drop them with it.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'project_documents_projectId_fkey'
    ) THEN
        ALTER TABLE "project_documents"
        ADD CONSTRAINT "project_documents_projectId_fkey"
        FOREIGN KEY ("projectId") REFERENCES "projects"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END$$;

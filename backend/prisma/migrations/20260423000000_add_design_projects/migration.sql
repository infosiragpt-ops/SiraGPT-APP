-- Design projects — single-file HTML artifacts (prototypes, slide
-- decks, templates, ad-hoc pages) the user iterates on via chat in
-- the siraGPT Design studio. See the DesignProject model in
-- schema.prisma for the rationale on storing full HTML snapshots
-- plus an inline messages log.
--
-- Idempotent (IF NOT EXISTS guards) so it can re-run cleanly on an
-- instance where `prisma db push` already applied the same schema.

CREATE TABLE IF NOT EXISTS "design_projects" (
    "id"           TEXT         NOT NULL,
    "userId"       TEXT         NOT NULL,
    "name"         TEXT         NOT NULL,
    "kind"         TEXT         NOT NULL,
    "fidelity"     TEXT,
    "speakerNotes" BOOLEAN      DEFAULT false,
    "html"         TEXT,
    "messages"     JSONB,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "design_projects_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "design_projects_userId_updatedAt_idx"
    ON "design_projects" ("userId", "updatedAt");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'design_projects_userId_fkey'
    ) THEN
        ALTER TABLE "design_projects"
        ADD CONSTRAINT "design_projects_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END$$;

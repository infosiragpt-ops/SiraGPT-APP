-- Hierarchical document nodes — tree structure for RAPTOR-style
-- summary trees built by services/rag/hierarchical-chunker.js.
-- Each row is a node; the tree is reconstructed via parentId.
--
-- U0: document_analyses / chunks / tables were historically created via
-- `db push` only. Materialize them here (idempotent) so empty-database
-- `migrate deploy` can create the analysisId FK without P3018.

CREATE TABLE IF NOT EXISTS "document_analyses" (
    "id"         TEXT NOT NULL,
    "userId"     TEXT NOT NULL,
    "fileId"     TEXT NOT NULL,
    "status"     TEXT NOT NULL DEFAULT 'pending',
    "language"   TEXT,
    "mimeType"   TEXT,
    "pageCount"  INTEGER,
    "sheetCount" INTEGER,
    "slideCount" INTEGER,
    "charCount"  INTEGER NOT NULL DEFAULT 0,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "tableCount" INTEGER NOT NULL DEFAULT 0,
    "summary"    TEXT,
    "textCoverage" JSONB,
    "ocr"        JSONB,
    "warnings"   JSONB,
    "metadata"   JSONB,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_analyses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "document_analyses_fileId_key"
    ON "document_analyses" ("fileId");
CREATE INDEX IF NOT EXISTS "document_analyses_userId_updatedAt_idx"
    ON "document_analyses" ("userId", "updatedAt");

DO $$ BEGIN
  ALTER TABLE "document_analyses"
    ADD CONSTRAINT "document_analyses_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "document_analyses"
    ADD CONSTRAINT "document_analyses_fileId_fkey"
    FOREIGN KEY ("fileId") REFERENCES "files"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "document_chunks" (
    "id"           TEXT NOT NULL,
    "analysisId"   TEXT NOT NULL,
    "fileId"       TEXT NOT NULL,
    "ordinal"      INTEGER NOT NULL,
    "sourceType"   TEXT NOT NULL,
    "sourceLabel"  TEXT,
    "pageNumber"   INTEGER,
    "sheetName"    TEXT,
    "slideNumber"  INTEGER,
    "sectionTitle" TEXT,
    "text"         TEXT NOT NULL,
    "charCount"    INTEGER NOT NULL DEFAULT 0,
    "metadata"     JSONB,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "document_chunks_analysisId_ordinal_idx"
    ON "document_chunks" ("analysisId", "ordinal");
CREATE INDEX IF NOT EXISTS "document_chunks_fileId_ordinal_idx"
    ON "document_chunks" ("fileId", "ordinal");

DO $$ BEGIN
  ALTER TABLE "document_chunks"
    ADD CONSTRAINT "document_chunks_analysisId_fkey"
    FOREIGN KEY ("analysisId") REFERENCES "document_analyses"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "document_chunks"
    ADD CONSTRAINT "document_chunks_fileId_fkey"
    FOREIGN KEY ("fileId") REFERENCES "files"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "document_tables" (
    "id"          TEXT NOT NULL,
    "analysisId"  TEXT NOT NULL,
    "fileId"      TEXT NOT NULL,
    "ordinal"     INTEGER NOT NULL,
    "sourceType"  TEXT NOT NULL,
    "sourceLabel" TEXT,
    "pageNumber"  INTEGER,
    "sheetName"   TEXT,
    "slideNumber" INTEGER,
    "title"       TEXT,
    "columns"     TEXT[],
    "rowCount"    INTEGER NOT NULL DEFAULT 0,
    "preview"     JSONB,
    "markdown"    TEXT,
    "metadata"    JSONB,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_tables_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "document_tables_analysisId_ordinal_idx"
    ON "document_tables" ("analysisId", "ordinal");
CREATE INDEX IF NOT EXISTS "document_tables_fileId_ordinal_idx"
    ON "document_tables" ("fileId", "ordinal");

DO $$ BEGIN
  ALTER TABLE "document_tables"
    ADD CONSTRAINT "document_tables_analysisId_fkey"
    FOREIGN KEY ("analysisId") REFERENCES "document_analyses"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "document_tables"
    ADD CONSTRAINT "document_tables_fileId_fkey"
    FOREIGN KEY ("fileId") REFERENCES "files"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "document_nodes" (
    "id"          TEXT NOT NULL,
    "fileId"      TEXT NOT NULL,
    "analysisId"  TEXT,
    "parentId"    TEXT,
    "level"       INTEGER NOT NULL,
    "role"        TEXT NOT NULL,
    "heading"     TEXT,
    "text"        TEXT NOT NULL DEFAULT '',
    "summary"     TEXT NOT NULL DEFAULT '',
    "embedding"   JSONB,
    "metadata"    JSONB,
    "ordinal"     INTEGER NOT NULL DEFAULT 0,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_nodes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "document_nodes_fileId_ordinal_idx"
    ON "document_nodes" ("fileId", "ordinal");
CREATE INDEX IF NOT EXISTS "document_nodes_fileId_level_idx"
    ON "document_nodes" ("fileId", "level");
CREATE INDEX IF NOT EXISTS "document_nodes_parentId_idx"
    ON "document_nodes" ("parentId");
CREATE INDEX IF NOT EXISTS "document_nodes_analysisId_idx"
    ON "document_nodes" ("analysisId");

DO $$ BEGIN
  ALTER TABLE "document_nodes"
    ADD CONSTRAINT "document_nodes_fileId_fkey"
    FOREIGN KEY ("fileId") REFERENCES "files"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "document_nodes"
    ADD CONSTRAINT "document_nodes_analysisId_fkey"
    FOREIGN KEY ("analysisId") REFERENCES "document_analyses"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "document_nodes"
    ADD CONSTRAINT "document_nodes_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "document_nodes"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

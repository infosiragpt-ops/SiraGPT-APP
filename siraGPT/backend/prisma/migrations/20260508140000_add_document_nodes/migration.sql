-- Hierarchical document nodes — tree structure for RAPTOR-style
-- summary trees built by services/rag/hierarchical-chunker.js.
-- Each row is a node; the tree is reconstructed via parentId.

CREATE TABLE "document_nodes" (
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

CREATE INDEX "document_nodes_fileId_ordinal_idx"
    ON "document_nodes" ("fileId", "ordinal");
CREATE INDEX "document_nodes_fileId_level_idx"
    ON "document_nodes" ("fileId", "level");
CREATE INDEX "document_nodes_parentId_idx"
    ON "document_nodes" ("parentId");
CREATE INDEX "document_nodes_analysisId_idx"
    ON "document_nodes" ("analysisId");

ALTER TABLE "document_nodes"
    ADD CONSTRAINT "document_nodes_fileId_fkey"
    FOREIGN KEY ("fileId") REFERENCES "files"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "document_nodes"
    ADD CONSTRAINT "document_nodes_analysisId_fkey"
    FOREIGN KEY ("analysisId") REFERENCES "document_analyses"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "document_nodes"
    ADD CONSTRAINT "document_nodes_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "document_nodes"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

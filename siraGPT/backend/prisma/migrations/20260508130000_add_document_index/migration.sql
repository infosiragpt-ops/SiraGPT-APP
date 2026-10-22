-- Document index cache: persists chunked + embedded representations of
-- uploaded files keyed by content hash so identical re-uploads skip the
-- parse + chunk + embed pipeline. `pageHashes` enables incremental diff
-- (only the pages that changed need their embeddings recomputed).

CREATE TABLE "document_index" (
    "contentHash"      TEXT NOT NULL,
    "version"          INTEGER NOT NULL DEFAULT 1,
    "chunks"           JSONB NOT NULL,
    "embeddings"       JSONB NOT NULL,
    "pageHashes"       JSONB,
    "hierarchyRootId"  TEXT,
    "bytesSize"        INTEGER NOT NULL DEFAULT 0,
    "embedTokens"      INTEGER NOT NULL DEFAULT 0,
    "metadata"         JSONB,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accessedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hitCount"         INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "document_index_pkey" PRIMARY KEY ("contentHash")
);

CREATE INDEX "document_index_accessedAt_idx" ON "document_index" ("accessedAt");
CREATE INDEX "document_index_createdAt_idx"  ON "document_index" ("createdAt");
CREATE INDEX "document_index_hierarchyRootId_idx" ON "document_index" ("hierarchyRootId");

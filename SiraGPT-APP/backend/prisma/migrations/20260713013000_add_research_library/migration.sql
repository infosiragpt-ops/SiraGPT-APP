-- Additive scientific reference library for personal collections, notes,
-- deduplication conflicts, exports, and citation-graph workflows.
CREATE TABLE "research_collections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "folder" TEXT,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "research_collections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "research_references" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "titleKey" TEXT NOT NULL,
    "doi" TEXT,
    "title" TEXT NOT NULL,
    "authors" JSONB,
    "year" INTEGER,
    "venue" TEXT,
    "abstract" TEXT,
    "url" TEXT,
    "pdfUrl" TEXT,
    "source" TEXT,
    "sources" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "metadata" JSONB,
    "citationCount" INTEGER,
    "openAccess" BOOLEAN,
    "publicationStage" TEXT,
    "peerReviewStatus" TEXT,
    "studyType" TEXT,
    "integrityStatus" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "research_references_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "research_collection_items" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "research_collection_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "research_reference_conflicts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "existingReferenceId" TEXT NOT NULL,
    "candidateReferenceId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resolution" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "research_reference_conflicts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "research_collections_userId_name_key" ON "research_collections"("userId", "name");
CREATE INDEX "research_collections_userId_folder_updatedAt_idx" ON "research_collections"("userId", "folder", "updatedAt");
CREATE UNIQUE INDEX "research_references_userId_identityKey_key" ON "research_references"("userId", "identityKey");
CREATE INDEX "research_references_userId_titleKey_idx" ON "research_references"("userId", "titleKey");
CREATE INDEX "research_references_userId_status_updatedAt_idx" ON "research_references"("userId", "status", "updatedAt");
CREATE UNIQUE INDEX "research_collection_items_collectionId_referenceId_key" ON "research_collection_items"("collectionId", "referenceId");
CREATE INDEX "research_collection_items_referenceId_idx" ON "research_collection_items"("referenceId");
CREATE UNIQUE INDEX "research_reference_conflicts_userId_existingReferenceId_candidateReferenceId_key" ON "research_reference_conflicts"("userId", "existingReferenceId", "candidateReferenceId");
CREATE INDEX "research_reference_conflicts_userId_status_createdAt_idx" ON "research_reference_conflicts"("userId", "status", "createdAt");

ALTER TABLE "research_collections" ADD CONSTRAINT "research_collections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_references" ADD CONSTRAINT "research_references_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_collection_items" ADD CONSTRAINT "research_collection_items_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "research_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_collection_items" ADD CONSTRAINT "research_collection_items_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES "research_references"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_reference_conflicts" ADD CONSTRAINT "research_reference_conflicts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_reference_conflicts" ADD CONSTRAINT "research_reference_conflicts_existingReferenceId_fkey" FOREIGN KEY ("existingReferenceId") REFERENCES "research_references"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_reference_conflicts" ADD CONSTRAINT "research_reference_conflicts_candidateReferenceId_fkey" FOREIGN KEY ("candidateReferenceId") REFERENCES "research_references"("id") ON DELETE CASCADE ON UPDATE CASCADE;

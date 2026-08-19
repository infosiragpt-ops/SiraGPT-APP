-- Organization-scoped scientific libraries, collaboration and reusable briefs.
CREATE TYPE "ResearchCollectionShareAccess" AS ENUM ('VIEW', 'EDIT');

CREATE TABLE "research_collection_shares" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sharedById" TEXT NOT NULL,
    "access" "ResearchCollectionShareAccess" NOT NULL DEFAULT 'VIEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "research_collection_shares_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "research_collection_comments" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "mentionedUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "research_collection_comments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "research_templates" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "query" TEXT NOT NULL,
    "filters" JSONB,
    "methodology" JSONB,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "research_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "research_collection_shares_collectionId_organizationId_key"
ON "research_collection_shares"("collectionId", "organizationId");
CREATE INDEX "research_collection_shares_organizationId_access_updatedAt_idx"
ON "research_collection_shares"("organizationId", "access", "updatedAt");
CREATE INDEX "research_collection_shares_sharedById_idx"
ON "research_collection_shares"("sharedById");

CREATE INDEX "research_collection_comments_collectionId_organizationId_createdAt_idx"
ON "research_collection_comments"("collectionId", "organizationId", "createdAt");
CREATE INDEX "research_collection_comments_authorId_createdAt_idx"
ON "research_collection_comments"("authorId", "createdAt");

CREATE UNIQUE INDEX "research_templates_organizationId_name_key"
ON "research_templates"("organizationId", "name");
CREATE INDEX "research_templates_organizationId_updatedAt_idx"
ON "research_templates"("organizationId", "updatedAt");
CREATE INDEX "research_templates_createdById_idx"
ON "research_templates"("createdById");

ALTER TABLE "research_collection_shares"
ADD CONSTRAINT "research_collection_shares_collectionId_fkey"
FOREIGN KEY ("collectionId") REFERENCES "research_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_collection_shares"
ADD CONSTRAINT "research_collection_shares_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_collection_shares"
ADD CONSTRAINT "research_collection_shares_sharedById_fkey"
FOREIGN KEY ("sharedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "research_collection_comments"
ADD CONSTRAINT "research_collection_comments_collectionId_fkey"
FOREIGN KEY ("collectionId") REFERENCES "research_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_collection_comments"
ADD CONSTRAINT "research_collection_comments_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_collection_comments"
ADD CONSTRAINT "research_collection_comments_authorId_fkey"
FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "research_templates"
ADD CONSTRAINT "research_templates_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_templates"
ADD CONSTRAINT "research_templates_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

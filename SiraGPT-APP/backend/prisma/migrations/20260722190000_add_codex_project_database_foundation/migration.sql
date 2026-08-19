-- Additive, inert foundation for one PostgreSQL resource per Codex project.
--
-- This migration provisions no external database and stores no plaintext
-- credential. Runtime behavior remains behind CODEX_PROJECT_DATABASES=0.

-- AlterTable
ALTER TABLE "codex_projects"
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "deleteAfter" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "codex_project_databases" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'sira_postgres',
    "clusterRef" TEXT NOT NULL,
    "resourceRef" TEXT,
    "databaseName" TEXT NOT NULL,
    "ownerRole" TEXT NOT NULL,
    "migratorRole" TEXT NOT NULL,
    "runtimeRole" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "desiredState" TEXT NOT NULL DEFAULT 'ready',
    "operationId" TEXT,
    "operationLeaseUntil" TIMESTAMP(3),
    "credentialGeneration" INTEGER NOT NULL DEFAULT 1,
    "quotaMb" INTEGER NOT NULL DEFAULT 512,
    "maxConnections" INTEGER NOT NULL DEFAULT 10,
    "backupPolicy" JSONB,
    "lastBackupAt" TIMESTAMP(3),
    "lastRestoreTestAt" TIMESTAMP(3),
    "provisionedAt" TIMESTAMP(3),
    "rotationDueAt" TIMESTAMP(3),
    "deleteRequestedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "codex_project_databases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codex_project_database_secrets" (
    "databaseId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "envelope" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "rotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "codex_project_database_secrets_pkey" PRIMARY KEY ("databaseId")
);

-- CreateTable
CREATE TABLE "codex_database_leases" (
    "id" TEXT NOT NULL,
    "databaseId" TEXT NOT NULL,
    "sandboxRef" TEXT NOT NULL,
    "runId" TEXT,
    "scope" TEXT NOT NULL,
    "roleName" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "codex_database_leases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "codex_projects_userId_deleteAfter_idx"
ON "codex_projects"("userId", "deleteAfter");

-- CreateIndex
CREATE UNIQUE INDEX "codex_project_databases_projectId_key"
ON "codex_project_databases"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "codex_project_databases_resourceRef_key"
ON "codex_project_databases"("resourceRef");

-- CreateIndex
CREATE UNIQUE INDEX "codex_project_databases_clusterRef_databaseName_key"
ON "codex_project_databases"("clusterRef", "databaseName");

-- CreateIndex
CREATE UNIQUE INDEX "codex_project_databases_clusterRef_ownerRole_key"
ON "codex_project_databases"("clusterRef", "ownerRole");

-- CreateIndex
CREATE UNIQUE INDEX "codex_project_databases_clusterRef_migratorRole_key"
ON "codex_project_databases"("clusterRef", "migratorRole");

-- CreateIndex
CREATE UNIQUE INDEX "codex_project_databases_clusterRef_runtimeRole_key"
ON "codex_project_databases"("clusterRef", "runtimeRole");

-- CreateIndex
CREATE INDEX "codex_project_databases_status_operationLeaseUntil_idx"
ON "codex_project_databases"("status", "operationLeaseUntil");

-- CreateIndex
CREATE INDEX "codex_project_databases_desiredState_status_idx"
ON "codex_project_databases"("desiredState", "status");

-- CreateIndex
CREATE INDEX "codex_project_database_secrets_keyId_idx"
ON "codex_project_database_secrets"("keyId");

-- CreateIndex
CREATE INDEX "codex_database_leases_databaseId_expiresAt_idx"
ON "codex_database_leases"("databaseId", "expiresAt");

-- CreateIndex
CREATE INDEX "codex_database_leases_expiresAt_revokedAt_idx"
ON "codex_database_leases"("expiresAt", "revokedAt");

-- CreateIndex
CREATE INDEX "codex_database_leases_runId_idx"
ON "codex_database_leases"("runId");

-- AddForeignKey. SET NULL preserves an external-resource tombstone if the
-- CodexProject is deleted before a future reconciler finishes cleanup.
ALTER TABLE "codex_project_databases"
ADD CONSTRAINT "codex_project_databases_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "codex_projects"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_project_database_secrets"
ADD CONSTRAINT "codex_project_database_secrets_databaseId_fkey"
FOREIGN KEY ("databaseId") REFERENCES "codex_project_databases"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_database_leases"
ADD CONSTRAINT "codex_database_leases_databaseId_fkey"
FOREIGN KEY ("databaseId") REFERENCES "codex_project_databases"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

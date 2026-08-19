-- Deployments / Publishing (flag DEPLOYMENTS_V2). Management clone of Replit's
-- Deployments tab: status lifecycle + immutable versions + custom domains.
-- Migración puramente aditiva: 3 tablas deployment* + índices + FKs.
-- Extraída de `prisma migrate diff` (solo las tablas de deployments).

-- CreateTable
CREATE TABLE "deployments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "deploymentType" TEXT NOT NULL DEFAULT 'autoscale',
    "status" TEXT NOT NULL DEFAULT 'building',
    "suspendedReason" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "geography" TEXT NOT NULL DEFAULT 'na',
    "machineTier" TEXT NOT NULL DEFAULT 'autoscale',
    "cpu" DOUBLE PRECISION,
    "memoryMb" INTEGER,
    "subdomain" TEXT,
    "buildCommand" TEXT,
    "runCommand" TEXT,
    "publicDir" TEXT,
    "externalPort" INTEGER DEFAULT 80,
    "databaseConnected" BOOLEAN NOT NULL DEFAULT false,
    "databaseProvider" TEXT,
    "currentVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment_versions" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "shortHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'promoting',
    "isLive" BOOLEAN NOT NULL DEFAULT false,
    "isRollback" BOOLEAN NOT NULL DEFAULT false,
    "rolledBackFromId" TEXT,
    "publishedById" TEXT,
    "buildLog" TEXT,
    "securityScan" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment_domains" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'custom',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "verificationStatus" TEXT NOT NULL DEFAULT 'pending',
    "tlsStatus" TEXT NOT NULL DEFAULT 'provisioning',
    "dnsRecords" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_domains_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deployments_subdomain_key" ON "deployments"("subdomain");

-- CreateIndex
CREATE INDEX "deployments_userId_updatedAt_idx" ON "deployments"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "deployments_userId_deletedAt_idx" ON "deployments"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "deployment_versions_deploymentId_createdAt_idx" ON "deployment_versions"("deploymentId", "createdAt");

-- CreateIndex
CREATE INDEX "deployment_domains_deploymentId_idx" ON "deployment_domains"("deploymentId");

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_versions" ADD CONSTRAINT "deployment_versions_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_domains" ADD CONSTRAINT "deployment_domains_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Merge the Replit-style Publishing model and the Hostinger/SFTP deployment
-- history into one additive `deployments` table. This is intentionally
-- idempotent because older environments may have received either side first.
-- migration-safety: allow-destructive reason="name backfilled before SET NOT NULL"

ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "projectId" TEXT;
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "name" TEXT;
UPDATE "deployments" SET "name" = 'Deployment' WHERE "name" IS NULL;
ALTER TABLE "deployments" ALTER COLUMN "name" SET DEFAULT 'Deployment';
ALTER TABLE "deployments" ALTER COLUMN "name" SET NOT NULL;

ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "connectedRepositoryId" TEXT;
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "hostingTargetId" TEXT;
ALTER TABLE "deployments" ALTER COLUMN "connectedRepositoryId" DROP NOT NULL;
ALTER TABLE "deployments" ALTER COLUMN "hostingTargetId" DROP NOT NULL;
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "branch" TEXT;
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "outputDir" TEXT;
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "remotePath" TEXT;
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "url" TEXT;
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "error" TEXT;
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "logTail" TEXT;
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3);
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "finishedAt" TIMESTAMP(3);

ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "deploymentType" TEXT NOT NULL DEFAULT 'autoscale';
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'building';
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "suspendedReason" TEXT;
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "visibility" TEXT NOT NULL DEFAULT 'public';
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "geography" TEXT NOT NULL DEFAULT 'na';
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "machineTier" TEXT NOT NULL DEFAULT 'autoscale';
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "cpu" DOUBLE PRECISION;
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "memoryMb" INTEGER;
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "subdomain" TEXT;
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "buildCommand" TEXT;
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "runCommand" TEXT;
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "publicDir" TEXT;
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "externalPort" INTEGER DEFAULT 80;
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "databaseConnected" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "databaseProvider" TEXT;
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "currentVersionId" TEXT;
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "deployments_subdomain_key" ON "deployments"("subdomain");
CREATE INDEX IF NOT EXISTS "deployments_userId_updatedAt_idx" ON "deployments"("userId", "updatedAt");
CREATE INDEX IF NOT EXISTS "deployments_userId_deletedAt_idx" ON "deployments"("userId", "deletedAt");
CREATE INDEX IF NOT EXISTS "deployments_connectedRepositoryId_idx" ON "deployments"("connectedRepositoryId");
CREATE INDEX IF NOT EXISTS "deployments_hostingTargetId_idx" ON "deployments"("hostingTargetId");

CREATE TABLE IF NOT EXISTS "deployment_versions" (
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

CREATE TABLE IF NOT EXISTS "deployment_domains" (
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

CREATE TABLE IF NOT EXISTS "deployment_logs" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "versionId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'Runtime',
    "level" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "deployment_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "deployment_versions_deploymentId_createdAt_idx" ON "deployment_versions"("deploymentId", "createdAt");
CREATE INDEX IF NOT EXISTS "deployment_domains_deploymentId_idx" ON "deployment_domains"("deploymentId");
CREATE INDEX IF NOT EXISTS "deployment_logs_deploymentId_createdAt_idx" ON "deployment_logs"("deploymentId", "createdAt");
CREATE INDEX IF NOT EXISTS "deployment_logs_deploymentId_level_createdAt_idx" ON "deployment_logs"("deploymentId", "level", "createdAt");
CREATE INDEX IF NOT EXISTS "deployment_logs_versionId_createdAt_idx" ON "deployment_logs"("versionId", "createdAt");

CREATE TABLE IF NOT EXISTS "hosting_targets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'hostinger',
    "label" TEXT NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'sftp',
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "username" TEXT NOT NULL,
    "encryptedCreds" TEXT NOT NULL,
    "remoteBaseDir" TEXT NOT NULL DEFAULT '/public_html',
    "siteUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "hosting_targets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "deploy_envs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectedRepositoryId" TEXT NOT NULL,
    "encryptedEnv" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "deploy_envs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "hosting_targets_userId_idx" ON "hosting_targets"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "deploy_envs_connectedRepositoryId_key" ON "deploy_envs"("connectedRepositoryId");
CREATE INDEX IF NOT EXISTS "deploy_envs_userId_idx" ON "deploy_envs"("userId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deployments_userId_fkey') THEN
    ALTER TABLE "deployments" ADD CONSTRAINT "deployments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deployments_connectedRepositoryId_fkey') THEN
    ALTER TABLE "deployments" ADD CONSTRAINT "deployments_connectedRepositoryId_fkey" FOREIGN KEY ("connectedRepositoryId") REFERENCES "connected_repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deployments_hostingTargetId_fkey') THEN
    ALTER TABLE "deployments" ADD CONSTRAINT "deployments_hostingTargetId_fkey" FOREIGN KEY ("hostingTargetId") REFERENCES "hosting_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deployment_versions_deploymentId_fkey') THEN
    ALTER TABLE "deployment_versions" ADD CONSTRAINT "deployment_versions_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deployment_domains_deploymentId_fkey') THEN
    ALTER TABLE "deployment_domains" ADD CONSTRAINT "deployment_domains_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deployment_logs_deploymentId_fkey') THEN
    ALTER TABLE "deployment_logs" ADD CONSTRAINT "deployment_logs_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deployment_logs_versionId_fkey') THEN
    ALTER TABLE "deployment_logs" ADD CONSTRAINT "deployment_logs_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "deployment_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hosting_targets_userId_fkey') THEN
    ALTER TABLE "hosting_targets" ADD CONSTRAINT "hosting_targets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deploy_envs_userId_fkey') THEN
    ALTER TABLE "deploy_envs" ADD CONSTRAINT "deploy_envs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deploy_envs_connectedRepositoryId_fkey') THEN
    ALTER TABLE "deploy_envs" ADD CONSTRAINT "deploy_envs_connectedRepositoryId_fkey" FOREIGN KEY ("connectedRepositoryId") REFERENCES "connected_repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- CreateTable: hosting_targets (SFTP/FTP deploy targets; creds AES-256 sealed)
CREATE TABLE "hosting_targets" (
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
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hosting_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable: hosting_deployments (build + upload history per connected repo).
-- Named hosting_deployments (NOT deployments) to avoid colliding with the
-- Deployments-module "deployments" table (migration 20260618200000).
CREATE TABLE "hosting_deployments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectedRepositoryId" TEXT NOT NULL,
    "hostingTargetId" TEXT NOT NULL,
    "branch" TEXT,
    "buildCommand" TEXT,
    "outputDir" TEXT,
    "remotePath" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "url" TEXT,
    "error" TEXT,
    "logTail" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hosting_deployments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hosting_targets_userId_idx" ON "hosting_targets"("userId");
CREATE INDEX "hosting_deployments_userId_idx" ON "hosting_deployments"("userId");
CREATE INDEX "hosting_deployments_connectedRepositoryId_idx" ON "hosting_deployments"("connectedRepositoryId");

-- AddForeignKey
ALTER TABLE "hosting_targets" ADD CONSTRAINT "hosting_targets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hosting_deployments" ADD CONSTRAINT "hosting_deployments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hosting_deployments" ADD CONSTRAINT "hosting_deployments_connectedRepositoryId_fkey" FOREIGN KEY ("connectedRepositoryId") REFERENCES "connected_repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hosting_deployments" ADD CONSTRAINT "hosting_deployments_hostingTargetId_fkey" FOREIGN KEY ("hostingTargetId") REFERENCES "hosting_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

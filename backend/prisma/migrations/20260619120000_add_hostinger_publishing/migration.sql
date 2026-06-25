-- CreateTable: hosting_targets (SFTP/FTP deploy targets; creds AES-256 sealed)
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
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hosting_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable: deployments (build + upload history per connected repo)
CREATE TABLE IF NOT EXISTS "deployments" (
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

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "hosting_targets_userId_idx" ON "hosting_targets"("userId");
CREATE INDEX IF NOT EXISTS "deployments_userId_idx" ON "deployments"("userId");
CREATE INDEX IF NOT EXISTS "deployments_connectedRepositoryId_idx" ON "deployments"("connectedRepositoryId");

-- AddForeignKey (idempotent via DO block)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'hosting_targets_userId_fkey'
  ) THEN
    ALTER TABLE "hosting_targets" ADD CONSTRAINT "hosting_targets_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'deployments_userId_fkey'
  ) THEN
    ALTER TABLE "deployments" ADD CONSTRAINT "deployments_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'deployments_connectedRepositoryId_fkey'
  ) THEN
    ALTER TABLE "deployments" ADD CONSTRAINT "deployments_connectedRepositoryId_fkey"
      FOREIGN KEY ("connectedRepositoryId") REFERENCES "connected_repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'deployments_hostingTargetId_fkey'
  ) THEN
    ALTER TABLE "deployments" ADD CONSTRAINT "deployments_hostingTargetId_fkey"
      FOREIGN KEY ("hostingTargetId") REFERENCES "hosting_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

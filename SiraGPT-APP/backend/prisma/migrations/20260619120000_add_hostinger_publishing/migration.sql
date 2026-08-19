-- Hostinger/SFTP publishing targets.
-- The overlapping `deployments` shape is merged later in
-- 20260624223000_merge_deployment_models. Creating a second incompatible
-- `deployments` table here used to break empty-DB migrate deploy when the
-- Replit-style deployments table already existed (U0).

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

CREATE INDEX IF NOT EXISTS "hosting_targets_userId_idx" ON "hosting_targets"("userId");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'hosting_targets_userId_fkey'
  ) THEN
    ALTER TABLE "hosting_targets" ADD CONSTRAINT "hosting_targets_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

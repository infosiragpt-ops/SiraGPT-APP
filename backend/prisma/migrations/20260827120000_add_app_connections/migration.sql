-- ChatGPT-style first-party apps on /conexiones.
-- Additive only: tokens stay in existing sealed vault columns.

CREATE TABLE "app_connections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "appId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'error',
    "scopes" JSONB,
    "expiresAt" TIMESTAMP(3),
    "lastHealthAt" TIMESTAMP(3),
    "lastHealthOk" TIMESTAMP(3),
    "lastError" TEXT,
    "secretRef" TEXT NOT NULL,
    "accountLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "app_connections_userId_appId_key" ON "app_connections"("userId", "appId");
CREATE INDEX "app_connections_userId_status_idx" ON "app_connections"("userId", "status");
CREATE INDEX "app_connections_secretRef_idx" ON "app_connections"("secretRef");

ALTER TABLE "app_connections"
  ADD CONSTRAINT "app_connections_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "app_connections"
  ADD CONSTRAINT "app_connections_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AdminConnection: admin-curated upstream AI API endpoints
CREATE TABLE "admin_connections" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "providerLabel" TEXT,
    "apiKey" TEXT,
    "authType" TEXT NOT NULL DEFAULT 'Bearer',
    "apiType" TEXT NOT NULL DEFAULT 'chat_completions',
    "headers" JSONB,
    "prefixId" TEXT,
    "modelIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncOk" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_connections_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_connections_providerKey_idx" ON "admin_connections"("providerKey");
CREATE INDEX "admin_connections_enabled_idx" ON "admin_connections"("enabled");

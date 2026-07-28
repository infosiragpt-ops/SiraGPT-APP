CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mission" TEXT,
    "vision" TEXT,
    "industry" TEXT,
    "urls" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "business_channels" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectorAccountId" TEXT,
    "kind" TEXT NOT NULL,
    "label" TEXT,
    "credentialsEncrypted" TEXT,
    "dmPolicy" TEXT NOT NULL DEFAULT 'pairing',
    "allowFrom" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "outboundMode" TEXT NOT NULL DEFAULT 'review',
    "status" TEXT NOT NULL DEFAULT 'active',
    "metadata" JSONB,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_channels_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inbox_messages" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "threadId" TEXT,
    "from" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'inbound',
    "status" TEXT NOT NULL DEFAULT 'received',
    "departmentId" TEXT,
    "intent" TEXT,
    "confidence" DOUBLE PRECISION,
    "metadata" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbox_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "business_channel_pairings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "senderRef" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_channel_pairings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "companies_projectId_key" ON "companies"("projectId");
CREATE INDEX "companies_userId_updatedAt_idx" ON "companies"("userId", "updatedAt");
CREATE INDEX "business_channels_companyId_status_updatedAt_idx" ON "business_channels"("companyId", "status", "updatedAt");
CREATE INDEX "business_channels_userId_kind_status_idx" ON "business_channels"("userId", "kind", "status");
CREATE INDEX "business_channels_connectorAccountId_idx" ON "business_channels"("connectorAccountId");
CREATE UNIQUE INDEX "inbox_messages_channelId_externalId_key" ON "inbox_messages"("channelId", "externalId");
CREATE INDEX "inbox_messages_companyId_status_receivedAt_idx" ON "inbox_messages"("companyId", "status", "receivedAt");
CREATE INDEX "inbox_messages_channelId_threadId_receivedAt_idx" ON "inbox_messages"("channelId", "threadId", "receivedAt");
CREATE INDEX "inbox_messages_departmentId_status_idx" ON "inbox_messages"("departmentId", "status");
CREATE UNIQUE INDEX "business_channel_pairings_channelId_senderRef_key" ON "business_channel_pairings"("channelId", "senderRef");
CREATE INDEX "business_channel_pairings_companyId_status_expiresAt_idx" ON "business_channel_pairings"("companyId", "status", "expiresAt");

ALTER TABLE "companies" ADD CONSTRAINT "companies_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "companies" ADD CONSTRAINT "companies_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "business_channels" ADD CONSTRAINT "business_channels_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "business_channels" ADD CONSTRAINT "business_channels_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "business_channels" ADD CONSTRAINT "business_channels_connectorAccountId_fkey"
FOREIGN KEY ("connectorAccountId") REFERENCES "connector_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_channelId_fkey"
FOREIGN KEY ("channelId") REFERENCES "business_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "business_channel_pairings" ADD CONSTRAINT "business_channel_pairings_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "business_channel_pairings" ADD CONSTRAINT "business_channel_pairings_channelId_fkey"
FOREIGN KEY ("channelId") REFERENCES "business_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

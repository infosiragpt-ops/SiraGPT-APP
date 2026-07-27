CREATE TABLE "codex_company_leads" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "contactName" TEXT,
    "domain" TEXT,
    "websiteUrl" TEXT,
    "email" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "sourceTitle" TEXT,
    "evidence" TEXT,
    "status" TEXT NOT NULL DEFAULT 'discovered',
    "score" INTEGER NOT NULL DEFAULT 0,
    "tags" JSONB,
    "lastContactedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "codex_company_leads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "codex_company_inbox_items" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'gmail',
    "externalId" TEXT NOT NULL,
    "threadId" TEXT,
    "senderEmail" TEXT,
    "senderName" TEXT,
    "subject" TEXT,
    "snippet" TEXT,
    "receivedAt" TIMESTAMP(3),
    "category" TEXT NOT NULL DEFAULT 'other',
    "urgency" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'pending_review',
    "draftBody" TEXT,
    "modelConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "providerDraftId" TEXT,
    "sentMessageId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "codex_company_inbox_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "codex_external_actions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetRef" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_review',
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "approvedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "codex_external_actions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "codex_company_leads_projectId_fingerprint_key"
ON "codex_company_leads"("projectId", "fingerprint");
CREATE INDEX "codex_company_leads_userId_projectId_status_updatedAt_idx"
ON "codex_company_leads"("userId", "projectId", "status", "updatedAt");
CREATE INDEX "codex_company_leads_projectId_score_idx"
ON "codex_company_leads"("projectId", "score");

CREATE UNIQUE INDEX "codex_company_inbox_items_projectId_provider_externalId_key"
ON "codex_company_inbox_items"("projectId", "provider", "externalId");
CREATE INDEX "codex_company_inbox_items_userId_projectId_status_updatedAt_idx"
ON "codex_company_inbox_items"("userId", "projectId", "status", "updatedAt");
CREATE INDEX "codex_company_inbox_items_projectId_category_urgency_idx"
ON "codex_company_inbox_items"("projectId", "category", "urgency");

CREATE UNIQUE INDEX "codex_external_actions_idempotencyKey_key"
ON "codex_external_actions"("idempotencyKey");
CREATE INDEX "codex_external_actions_userId_projectId_status_createdAt_idx"
ON "codex_external_actions"("userId", "projectId", "status", "createdAt");
CREATE INDEX "codex_external_actions_projectId_kind_createdAt_idx"
ON "codex_external_actions"("projectId", "kind", "createdAt");

ALTER TABLE "codex_company_leads"
ADD CONSTRAINT "codex_company_leads_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "codex_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "codex_company_leads"
ADD CONSTRAINT "codex_company_leads_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "codex_company_inbox_items"
ADD CONSTRAINT "codex_company_inbox_items_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "codex_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "codex_company_inbox_items"
ADD CONSTRAINT "codex_company_inbox_items_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "codex_external_actions"
ADD CONSTRAINT "codex_external_actions_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "codex_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "codex_external_actions"
ADD CONSTRAINT "codex_external_actions_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "codex_proactive_leases" (
    "projectId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "codex_proactive_leases_pkey" PRIMARY KEY ("projectId")
);

CREATE UNIQUE INDEX "codex_proactive_leases_token_key"
ON "codex_proactive_leases"("token");
CREATE INDEX "codex_proactive_leases_expiresAt_idx"
ON "codex_proactive_leases"("expiresAt");

ALTER TABLE "codex_proactive_leases"
ADD CONSTRAINT "codex_proactive_leases_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "codex_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

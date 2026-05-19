-- WebhookEndpoint — user-managed outbound webhook subscriptions.
-- One row per {url, events[], secret} triple. The trigger registry
-- fans out to these endpoints when matching events are published.

CREATE TABLE IF NOT EXISTS "webhook_endpoints" (
  "id"             TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "url"            TEXT NOT NULL,
  "events"         TEXT[] NOT NULL,
  "secret"         TEXT NOT NULL,
  "isActive"       BOOLEAN NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastDeliveryAt" TIMESTAMP(3),
  CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "webhook_endpoints_userId_createdAt_idx"
  ON "webhook_endpoints"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "webhook_endpoints_userId_isActive_idx"
  ON "webhook_endpoints"("userId", "isActive");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'webhook_endpoints_userId_fkey'
  ) THEN
    ALTER TABLE "webhook_endpoints"
      ADD CONSTRAINT "webhook_endpoints_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- SlackIntegration — per-user Slack Incoming Webhook configuration.
-- The webhookUrl is encrypted at rest by services/slack-integration.js
-- (AES-256-GCM, base64-encoded). `isEnabled` gates whether the trigger
-- registry actually fires Slack notifications for this user.

CREATE TABLE IF NOT EXISTS "slack_integrations" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "webhookUrl"  TEXT NOT NULL,
  "channelName" TEXT,
  "isEnabled"   BOOLEAN NOT NULL DEFAULT false,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastEventAt" TIMESTAMP(3),
  CONSTRAINT "slack_integrations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "slack_integrations_userId_idx"
  ON "slack_integrations"("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'slack_integrations_userId_fkey'
  ) THEN
    ALTER TABLE "slack_integrations"
      ADD CONSTRAINT "slack_integrations_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

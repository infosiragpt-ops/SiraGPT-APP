-- Cycle 45 — per-org Slack integrations.
-- Add a nullable organizationId column to slack_integrations so a Slack
-- webhook can be attached to an Organization (in addition to the
-- existing per-user scope). The trigger-registry prefers the org-scoped
-- integration when the publish payload carries an orgId.

ALTER TABLE "slack_integrations"
  ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

CREATE INDEX IF NOT EXISTS "slack_integrations_organizationId_isEnabled_idx"
  ON "slack_integrations"("organizationId", "isEnabled");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'slack_integrations_organizationId_fkey'
  ) THEN
    ALTER TABLE "slack_integrations"
      ADD CONSTRAINT "slack_integrations_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

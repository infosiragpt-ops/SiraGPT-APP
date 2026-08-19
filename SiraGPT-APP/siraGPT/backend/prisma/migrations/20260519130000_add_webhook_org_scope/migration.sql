-- Cycle 45 — per-org webhook endpoints.
-- Add a nullable organizationId column to webhook_endpoints so endpoints
-- can be scoped to an org (in addition to the existing per-user scope).
-- The trigger registry fans out to org endpoints when the publish payload
-- carries an orgId.

ALTER TABLE "webhook_endpoints"
  ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

CREATE INDEX IF NOT EXISTS "webhook_endpoints_organizationId_isActive_idx"
  ON "webhook_endpoints"("organizationId", "isActive");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'webhook_endpoints_organizationId_fkey'
  ) THEN
    ALTER TABLE "webhook_endpoints"
      ADD CONSTRAINT "webhook_endpoints_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

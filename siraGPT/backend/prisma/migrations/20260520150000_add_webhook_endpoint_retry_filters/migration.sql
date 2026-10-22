-- Ratchet 44 — WebhookEndpoint per-endpoint retry policy + delivery
-- filters/transformers. Both columns are nullable so existing rows keep
-- their effective defaults (dispatcher default maxRetries, no filters)
-- without a data backfill.
ALTER TABLE "webhook_endpoints"
  ADD COLUMN IF NOT EXISTS "maxRetries" INTEGER;

ALTER TABLE "webhook_endpoints"
  ADD COLUMN IF NOT EXISTS "filters" JSONB;

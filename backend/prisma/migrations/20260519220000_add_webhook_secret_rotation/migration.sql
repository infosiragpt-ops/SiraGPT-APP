-- Ratchet 45 — webhook signing secret rotation (Task 1).
-- Add a grace-window slot for the *previous* HMAC secret so an operator
-- can rotate the active secret without an instant cutover for receivers.
-- The dispatcher emits signatures using the current secret, but the
-- inbound verifier (and any consumer using @siragpt/sdk/verify-webhook)
-- accepts either the current or previous secret while
-- previousSecretExpiresAt is in the future. Both columns are nullable so
-- existing rows (no rotation yet) are unaffected.

ALTER TABLE "webhook_endpoints"
  ADD COLUMN IF NOT EXISTS "previousSecret" TEXT;

ALTER TABLE "webhook_endpoints"
  ADD COLUMN IF NOT EXISTS "previousSecretExpiresAt" TIMESTAMP(3);

-- Ratchet 45 (TrueDelete) — soft-delete tombstone on ApiKey.
--
-- DELETE /api/orgs/:id/api-keys/:keyId now sets `deletedAt` instead of
-- hard-removing the row, so:
--   1. Past audit/cost-tracker rows still resolve to a real key id.
--   2. The auth middleware rejects requests whose key has a non-null
--      `deletedAt` (treated identically to "expired/revoked").
--
-- The dedicated admin purge endpoint
--   POST /api/admin/api-keys/purge
-- hard-deletes rows where `deletedAt IS NOT NULL` (optionally older than
-- a retention window). The index on `deletedAt` keeps that scan cheap.

ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "api_keys_deletedAt_idx" ON "api_keys" ("deletedAt");

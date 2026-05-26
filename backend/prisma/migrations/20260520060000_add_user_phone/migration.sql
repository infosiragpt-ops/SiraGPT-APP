-- Ratchet 45 — User.phone column for SMS critical-notification fan-out.
--
-- Nullable so the migration is safe to apply against any existing
-- environment. The SMS bridge (`sms-delivery.js`) treats NULL as
-- "user has not opted into SMS" and silently skips delivery.
--
-- Idempotent: re-running the migration against a partially-applied
-- environment is a no-op.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone" TEXT;

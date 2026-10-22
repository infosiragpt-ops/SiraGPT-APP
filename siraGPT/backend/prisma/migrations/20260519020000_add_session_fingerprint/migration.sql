-- Add fingerprint column to sessions for IP+UA binding (drift-tolerant via /24, /64).
-- Idempotent so re-applies across environments are safe.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "fingerprint" TEXT;

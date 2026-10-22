-- Ratchet 45 — 2FA opt-in flag on User. When true AND phoneVerifiedAt
-- is non-null, the login handler returns 202 { twoFactorRequired: true,
-- challengeId } instead of a full JWT, forcing the user through the
-- /2fa/sms/verify step before session issuance.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false;

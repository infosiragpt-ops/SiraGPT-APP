-- Ratchet 45 — TOTP-based 2FA scaffold (Authy / Google Authenticator).
-- Alternative to the SMS challenge already wired in
-- 20260520080000_add_two_fa_challenge. `totpSecret` stores the base32
-- seed encrypted with ENCRYPTION_KEY (see src/utils/encryption.js).
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "totpSecret"  TEXT,
  ADD COLUMN IF NOT EXISTS "totpEnabled" BOOLEAN NOT NULL DEFAULT false;

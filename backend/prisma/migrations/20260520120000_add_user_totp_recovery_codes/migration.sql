-- Ratchet 45 (Task 2) — TOTP recovery codes.
-- Stores up to 10 hashed single-use 16-char recovery codes as a JSON
-- array of `{ hash, usedAt? }` entries. Plaintext codes are only
-- returned ONCE at generation time (POST /api/users/me/2fa/totp/recovery-codes).
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "totpRecoveryCodes" JSONB;

-- Ratchet 45 — WebAuthn / passkey credentials (scaffold follow-on to
-- the cycle 135 TOTP rollout). Stores a JSON array of
-- `{ credentialId, publicKey, counter, transports[], label?,
--   createdAt, lastUsedAt? }` per user. Null on legacy rows.
-- Managed by backend/src/services/webauthn.js +
--  - POST /api/users/me/webauthn/registration-options
--  - POST /api/users/me/webauthn/registration-verify
--  - POST /api/auth/webauthn/authentication-options
--  - POST /api/auth/webauthn/authentication-verify
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "webauthnCredentials" JSONB;

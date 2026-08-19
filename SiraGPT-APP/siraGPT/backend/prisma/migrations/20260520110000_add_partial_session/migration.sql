-- Ratchet 45 — PartialSession bridge for TOTP login gate.
-- Stores a short-lived (5 minute) opaque token that the /login handler
-- mints when the user has totpEnabled = true and twoFactorEnabled = false.
-- The client redeems it at POST /api/auth/2fa/totp/verify in exchange for
-- a full session JWT.

CREATE TABLE IF NOT EXISTS "partial_sessions" (
  "id"         TEXT NOT NULL,
  "token"      TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "partial_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "partial_sessions_token_key"
  ON "partial_sessions"("token");

CREATE INDEX IF NOT EXISTS "partial_sessions_userId_idx"
  ON "partial_sessions"("userId");

CREATE INDEX IF NOT EXISTS "partial_sessions_expiresAt_idx"
  ON "partial_sessions"("expiresAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'partial_sessions_userId_fkey'
  ) THEN
    ALTER TABLE "partial_sessions"
      ADD CONSTRAINT "partial_sessions_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

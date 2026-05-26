-- Spec §7.13 — explicit password reset flow.
--
-- Adds `password_reset_tokens`, a short-lived (30m by default) single-use
-- token table. The forgot-password endpoint mints a row and emails the
-- link; the reset endpoint redeems the row, updates `users.password`, and
-- marks the row consumed.
--
-- Aditiva. Sin DROP. Sigue el mismo patrón que email_verification_tokens
-- (migration 20260519180000_add_email_verification).

CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id"         TEXT PRIMARY KEY,
  "userId"     TEXT NOT NULL,
  "token"      TEXT NOT NULL,
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requestedFromIp" TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tokens_token_key"
  ON "password_reset_tokens"("token");
CREATE INDEX IF NOT EXISTS "password_reset_tokens_userId_idx"
  ON "password_reset_tokens"("userId");
CREATE INDEX IF NOT EXISTS "password_reset_tokens_expiresAt_idx"
  ON "password_reset_tokens"("expiresAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'password_reset_tokens_userId_fkey'
  ) THEN
    ALTER TABLE "password_reset_tokens"
      ADD CONSTRAINT "password_reset_tokens_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

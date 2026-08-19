-- Ratchet 45 — email verification scaffold.
--
-- 1) Adds `emailVerifiedAt` to `users` so org-invitation acceptance and
--    other identity-sensitive flows can gate on "this email was proven".
-- 2) Adds `email_verification_tokens`, a short-lived (24h) token table.
--    The verify-email endpoint redeems a row, sets `users.emailVerifiedAt`,
--    and marks the row consumed. The resend endpoint mints new rows.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "email_verification_tokens" (
  "id"         TEXT PRIMARY KEY,
  "userId"     TEXT NOT NULL,
  "token"      TEXT NOT NULL,
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "email_verification_tokens_token_key"
  ON "email_verification_tokens"("token");
CREATE INDEX IF NOT EXISTS "email_verification_tokens_userId_idx"
  ON "email_verification_tokens"("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'email_verification_tokens_userId_fkey'
  ) THEN
    ALTER TABLE "email_verification_tokens"
      ADD CONSTRAINT "email_verification_tokens_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

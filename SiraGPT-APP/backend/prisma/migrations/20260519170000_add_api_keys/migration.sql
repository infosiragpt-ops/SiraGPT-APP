-- Ratchet 45 — org-scoped API key tokens.
--
-- Adds `api_keys`, a table of bearer credentials a user (or org admin)
-- can mint for programmatic access. Tokens are stored as SHA-256
-- hashes; the full plaintext is only ever returned once at creation
-- time. The `prefix` column is the first 8 chars of the plaintext
-- (after the `sk_` scheme tag) and is safe to display — it lets the
-- UI render "sk_abcd1234…" without exposing the secret. The middleware
-- looks up keys by `prefix` (indexed) then compares the SHA-256 hash
-- of the presented token to `tokenHash`.

CREATE TABLE IF NOT EXISTS "api_keys" (
  "id"             TEXT PRIMARY KEY,
  "name"           TEXT NOT NULL,
  "prefix"         TEXT NOT NULL,
  "tokenHash"      TEXT NOT NULL,
  "organizationId" TEXT,
  "userId"         TEXT NOT NULL,
  "scopes"         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "lastUsedAt"     TIMESTAMP(3),
  "expiresAt"      TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_tokenHash_key" ON "api_keys"("tokenHash");
CREATE INDEX IF NOT EXISTS "api_keys_prefix_idx" ON "api_keys"("prefix");
CREATE INDEX IF NOT EXISTS "api_keys_organizationId_createdAt_idx" ON "api_keys"("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "api_keys_userId_createdAt_idx" ON "api_keys"("userId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_organizationId_fkey'
  ) THEN
    ALTER TABLE "api_keys"
      ADD CONSTRAINT "api_keys_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_userId_fkey'
  ) THEN
    ALTER TABLE "api_keys"
      ADD CONSTRAINT "api_keys_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

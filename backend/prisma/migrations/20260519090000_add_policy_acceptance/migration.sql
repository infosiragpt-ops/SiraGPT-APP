-- Add policy_acceptance table for GDPR/ToS consent records.
CREATE TABLE IF NOT EXISTS "policy_acceptance" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "document"   TEXT NOT NULL,
  "version"    TEXT NOT NULL,
  "ip"         TEXT,
  "ua"         TEXT,
  "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "policy_acceptance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "policy_acceptance_userId_document_version_key"
  ON "policy_acceptance"("userId", "document", "version");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'policy_acceptance_userId_fkey'
  ) THEN
    ALTER TABLE "policy_acceptance"
      ADD CONSTRAINT "policy_acceptance_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

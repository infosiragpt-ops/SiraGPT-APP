-- TwoFAChallenge — SMS-based 2FA login challenge (ratchet 45, cycle 131).
-- Login-flow integration (binding partial session → full JWT) is left for
-- the next cycle. This migration only adds the storage layer.

CREATE TABLE IF NOT EXISTS "two_fa_challenges" (
  "id"          TEXT NOT NULL,
  "challengeId" TEXT NOT NULL,
  "userId"      TEXT,
  "channel"     TEXT NOT NULL,
  "destination" TEXT NOT NULL,
  "lookup"      TEXT NOT NULL,
  "codeHash"    TEXT NOT NULL,
  "expiresAt"   TIMESTAMP(3) NOT NULL,
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  "consumedAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "two_fa_challenges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "two_fa_challenges_challengeId_key"
  ON "two_fa_challenges"("challengeId");

CREATE INDEX IF NOT EXISTS "two_fa_challenges_userId_idx"
  ON "two_fa_challenges"("userId");

CREATE INDEX IF NOT EXISTS "two_fa_challenges_lookup_idx"
  ON "two_fa_challenges"("lookup");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'two_fa_challenges_userId_fkey'
  ) THEN
    ALTER TABLE "two_fa_challenges"
      ADD CONSTRAINT "two_fa_challenges_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

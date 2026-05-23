-- Ratchet 45 — SSO domain claim.
--
-- Adds `ssoDomains TEXT[]` to `organizations`. When a user
-- registers or logs in with an email whose domain matches an
-- entry here AND the org has `ssoEnabled = true`, the login
-- endpoint short-circuits to the SSO redirect (currently 501
-- per the SSO scaffold). Empty array = no claimed domains
-- (default password-auth flow).

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "ssoDomains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Lookup index for the login-time domain match. GIN supports
-- the `= ANY()` array containment we use in the resolver.
CREATE INDEX IF NOT EXISTS "organizations_ssoDomains_idx"
  ON "organizations" USING GIN ("ssoDomains");

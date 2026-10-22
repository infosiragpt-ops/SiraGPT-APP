-- Ratchet 45 — SSO identity link (cycle 144). Tracks the external
-- IdP identity (SAML nameID / OIDC sub) that authenticated a given
-- local User into a given Organization. A user can have one identity
-- per (provider, externalId) tuple — re-logins hit the existing row
-- and refresh `lastUsedAt`. Decouples local auth from the SSO trust
-- chain so we can later support multi-IdP, identity-merge flows, and
-- admin-side "who logged in from where" forensics.
CREATE TABLE IF NOT EXISTS "sso_identities" (
  "id"         TEXT PRIMARY KEY,
  "userId"     TEXT NOT NULL,
  "orgId"      TEXT NOT NULL,
  "provider"   TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "sso_identities_provider_externalId_key"
  ON "sso_identities" ("provider", "externalId");
CREATE INDEX IF NOT EXISTS "sso_identities_userId_idx" ON "sso_identities" ("userId");
CREATE INDEX IF NOT EXISTS "sso_identities_orgId_idx"  ON "sso_identities" ("orgId");

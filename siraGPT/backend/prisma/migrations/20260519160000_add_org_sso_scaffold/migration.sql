-- Ratchet 45 — minimal SSO scaffold for organisations.
--
-- Adds two columns to `organizations`:
--   * `ssoConfig`  JSONB  — opaque provider config (provider type,
--                            entryPoint / issuer / authorizeUrl, callback,
--                            x509 certs, audience, etc.). Schema-less on
--                            purpose; the route validates the keys the FE
--                            cares about.
--   * `ssoEnabled` BOOL   — flag flip that makes the SSO login route
--                            actually redirect; defaults to FALSE so a
--                            half-configured org keeps password auth.
--
-- Real SAML/OIDC integration ships later. This migration only adds the
-- data model — the API routes return 501 until the integration lands.

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "ssoConfig" JSONB,
  ADD COLUMN IF NOT EXISTS "ssoEnabled" BOOLEAN NOT NULL DEFAULT false;

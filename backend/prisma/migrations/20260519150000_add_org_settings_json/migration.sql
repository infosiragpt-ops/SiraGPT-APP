-- Cycle 66 — per-org settings JSON column.
-- Add a nullable JSONB `settings` column to organizations so each org
-- can persist flexible per-org configuration (default model, response
-- style, branding tokens, feature toggles, etc.) without requiring a
-- schema change every time we add a new knob.
--
-- Read path : GET   /api/orgs/:id/settings  (any member)
-- Write path: PATCH /api/orgs/:id/settings  (ADMIN+; merge update,
--             audit-logged via `org_settings_update`).

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "settings" JSONB;

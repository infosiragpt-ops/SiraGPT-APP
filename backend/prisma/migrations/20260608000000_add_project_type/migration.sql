-- Add project "type" + "hostingProvider" columns.
-- Additive, non-destructive: both columns get a constant default so the
-- change is metadata-only on PostgreSQL (no table rewrite) and existing
-- rows backfill to the defaults.
--   type:            'general' (default) | 'webapp'
--   hostingProvider: 'sira-cloud' (default) | 'github'

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'general';
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "hostingProvider" TEXT NOT NULL DEFAULT 'sira-cloud';

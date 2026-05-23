-- Add Gema4 token pool columns for plan-credits-catalog routing
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "gemaTokenUsage" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "gemaTokenLimit" BIGINT NOT NULL DEFAULT 0;

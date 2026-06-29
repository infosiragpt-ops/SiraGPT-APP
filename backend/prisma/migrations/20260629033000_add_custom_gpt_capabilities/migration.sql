-- Custom GPT tool toggles. The Prisma schema has expected this column since
-- the GPT capability-gating work; keep the migration guarded so existing
-- production databases can be repaired safely and repeated deploys are no-ops.

ALTER TABLE "custom_gpts"
  ADD COLUMN IF NOT EXISTS "capabilities" JSONB;

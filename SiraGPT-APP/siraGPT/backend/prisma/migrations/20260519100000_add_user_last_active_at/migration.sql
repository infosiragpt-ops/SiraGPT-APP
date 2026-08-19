-- Add lastActiveAt to users (written via write-behind cache from auth middleware).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lastActiveAt" TIMESTAMP(3);

-- Partial index: only users seen in the last 30 days, for /admin/stats/users active-vs-dormant.
CREATE INDEX IF NOT EXISTS "users_lastActiveAt_idx" ON "users"("lastActiveAt");

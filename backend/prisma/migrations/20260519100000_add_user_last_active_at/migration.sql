-- Add lastActiveAt to User (written via write-behind cache from auth middleware).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastActiveAt" TIMESTAMP(3);

-- Partial index: only users seen in the last 30 days, for /admin/stats/users active-vs-dormant.
CREATE INDEX IF NOT EXISTS "User_lastActiveAt_idx" ON "User"("lastActiveAt");

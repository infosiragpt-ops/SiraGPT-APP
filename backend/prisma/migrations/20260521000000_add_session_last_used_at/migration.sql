-- Task 8 — Appshots token revocation.
--
-- The settings UI lists active Appshots sessions with both their creation
-- time and their last use. createdAt already exists; we add a nullable
-- lastUsedAt column that the /api/appshots/capture route bumps on every
-- successful upload. Existing rows stay NULL until used once.

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "lastUsedAt" TIMESTAMP(3);

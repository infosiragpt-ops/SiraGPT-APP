-- Add confidence column to user_memories.
-- This column tracks how confident the system is in each stored memory fact.
-- Uses IF NOT EXISTS so re-running (e.g. on P3009 rollback) is safe.
ALTER TABLE "user_memories"
  ADD COLUMN IF NOT EXISTS "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8;

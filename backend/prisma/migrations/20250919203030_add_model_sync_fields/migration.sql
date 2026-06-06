/*
  Warnings:

  - Add auto-sync tracking fields to AiModel

*/

-- AlterTable
ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS     "lastSynced" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS     "syncSource" TEXT DEFAULT 'manual',
ADD COLUMN IF NOT EXISTS     "contextLength" INTEGER,
ADD COLUMN IF NOT EXISTS     "pricing" JSONB,
ADD COLUMN IF NOT EXISTS     "tags" TEXT[];
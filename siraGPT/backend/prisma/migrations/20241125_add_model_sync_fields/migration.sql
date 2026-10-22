/*
  Warnings:

  - Add auto-sync tracking fields to AiModel

*/

-- AlterTable
ALTER TABLE "ai_models" ADD COLUMN     "lastSynced" TIMESTAMP(3),
ADD COLUMN     "syncSource" TEXT DEFAULT 'manual',
ADD COLUMN     "contextLength" INTEGER,
ADD COLUMN     "pricing" JSONB,
ADD COLUMN     "tags" TEXT[];
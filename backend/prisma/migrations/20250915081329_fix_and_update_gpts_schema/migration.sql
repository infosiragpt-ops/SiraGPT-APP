-- CreateEnum
CREATE TYPE "GptVisibility" AS ENUM ('PRIVATE', 'UNLISTED', 'PUBLIC');

-- AlterTable
ALTER TABLE "files" ADD COLUMN     "customGptId" TEXT;

-- CreateTable
CREATE TABLE "custom_gpts" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "iconUrl" TEXT,
    "instructions" TEXT NOT NULL,
    "greetingMessage" TEXT,
    "modelName" TEXT NOT NULL DEFAULT 'gpt-3.5-turbo',
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "maxTokens" INTEGER,
    "actions" JSONB,
    "conversationStarters" JSONB,
    "visibility" "GptVisibility" NOT NULL DEFAULT 'PRIVATE',
    "shareId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_gpts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "custom_gpts_shareId_key" ON "custom_gpts"("shareId");

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_customGptId_fkey" FOREIGN KEY ("customGptId") REFERENCES "custom_gpts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_gpts" ADD CONSTRAINT "custom_gpts_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

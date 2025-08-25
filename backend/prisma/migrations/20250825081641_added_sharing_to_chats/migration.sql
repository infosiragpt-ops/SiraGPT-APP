/*
  Warnings:

  - A unique constraint covering the columns `[shareId]` on the table `chats` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "chats" ADD COLUMN     "isShared" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shareId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "chats_shareId_key" ON "chats"("shareId");

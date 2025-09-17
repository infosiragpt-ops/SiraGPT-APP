-- CreateEnum
CREATE TYPE "ModelType" AS ENUM ('TEXT', 'IMAGE');

-- AlterTable
ALTER TABLE "ai_models" ADD COLUMN     "icon" TEXT,
ADD COLUMN     "type" "ModelType" NOT NULL DEFAULT 'TEXT';

-- AlterTable
ALTER TABLE "custom_gpts" ADD COLUMN     "category" TEXT,
ADD COLUMN     "isFeatured" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "anonymous_usage" (
    "id" TEXT NOT NULL,
    "anonId" TEXT NOT NULL,
    "usedQueries" INTEGER NOT NULL DEFAULT 0,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "anonymous_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "anonymous_usage_anonId_key" ON "anonymous_usage"("anonId");

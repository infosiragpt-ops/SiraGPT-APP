-- CreateTable (idempotent: safe under cross-session migration drift)
CREATE TABLE IF NOT EXISTS "file_versions" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "artifactId" TEXT,
    "filename" TEXT NOT NULL,
    "summary" TEXT,
    "editPlan" JSONB,
    "validationPassed" BOOLEAN NOT NULL DEFAULT true,
    "createdByChatId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "file_versions_fileId_version_key" ON "file_versions"("fileId", "version");
CREATE INDEX IF NOT EXISTS "file_versions_fileId_idx" ON "file_versions"("fileId");
CREATE INDEX IF NOT EXISTS "file_versions_userId_idx" ON "file_versions"("userId");

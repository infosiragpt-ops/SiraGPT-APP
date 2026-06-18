-- CreateTable
CREATE TABLE "github_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "githubUserId" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT,
    "scope" TEXT,
    "tokenType" TEXT NOT NULL DEFAULT 'bearer',
    "encryptedTokens" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connected_repositories" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "githubAccountId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "private" BOOLEAN NOT NULL DEFAULT false,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "cloneUrl" TEXT NOT NULL,
    "htmlUrl" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connected_repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "localPath" TEXT NOT NULL,
    "currentBranch" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastError" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_accounts_userId_key" ON "github_accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "github_accounts_githubUserId_key" ON "github_accounts"("githubUserId");

-- CreateIndex
CREATE INDEX "github_accounts_userId_idx" ON "github_accounts"("userId");

-- CreateIndex
CREATE INDEX "connected_repositories_userId_idx" ON "connected_repositories"("userId");

-- CreateIndex
CREATE INDEX "connected_repositories_githubAccountId_idx" ON "connected_repositories"("githubAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "connected_repositories_userId_repoId_key" ON "connected_repositories"("userId", "repoId");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_repositoryId_key" ON "workspaces"("repositoryId");

-- CreateIndex
CREATE INDEX "workspaces_userId_idx" ON "workspaces"("userId");

-- AddForeignKey
ALTER TABLE "github_accounts" ADD CONSTRAINT "github_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connected_repositories" ADD CONSTRAINT "connected_repositories_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connected_repositories" ADD CONSTRAINT "connected_repositories_githubAccountId_fkey" FOREIGN KEY ("githubAccountId") REFERENCES "github_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "connected_repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

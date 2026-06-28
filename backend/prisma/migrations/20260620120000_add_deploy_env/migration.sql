-- CreateTable: deploy_envs (build-time secrets per connected repo; sealed)
CREATE TABLE "deploy_envs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectedRepositoryId" TEXT NOT NULL,
    "encryptedEnv" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deploy_envs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deploy_envs_connectedRepositoryId_key" ON "deploy_envs"("connectedRepositoryId");
CREATE INDEX "deploy_envs_userId_idx" ON "deploy_envs"("userId");

-- AddForeignKey
ALTER TABLE "deploy_envs" ADD CONSTRAINT "deploy_envs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deploy_envs" ADD CONSTRAINT "deploy_envs_connectedRepositoryId_fkey" FOREIGN KEY ("connectedRepositoryId") REFERENCES "connected_repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

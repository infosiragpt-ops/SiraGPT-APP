-- Runtime logs for Deployments / Publishing.
-- Aditiva: guarda eventos de build/runtime para que la pestana Logs pueda
-- seguir errores en vivo despues de publicar una app.

CREATE TABLE "deployment_logs" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "versionId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'Runtime',
    "level" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "deployment_logs_deploymentId_createdAt_idx" ON "deployment_logs"("deploymentId", "createdAt");
CREATE INDEX "deployment_logs_deploymentId_level_createdAt_idx" ON "deployment_logs"("deploymentId", "level", "createdAt");
CREATE INDEX "deployment_logs_versionId_createdAt_idx" ON "deployment_logs"("versionId", "createdAt");

ALTER TABLE "deployment_logs" ADD CONSTRAINT "deployment_logs_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deployment_logs" ADD CONSTRAINT "deployment_logs_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "deployment_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

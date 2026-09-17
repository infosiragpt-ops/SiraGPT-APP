CREATE TABLE "codex_department_pools" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 1,
    "dailyBudgetUsd" DOUBLE PRECISION,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "codex_department_pools_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "codex_department_pools_projectId_departmentId_key"
ON "codex_department_pools"("projectId", "departmentId");

CREATE INDEX "codex_department_pools_projectId_enabled_idx"
ON "codex_department_pools"("projectId", "enabled");

ALTER TABLE "codex_department_pools"
ADD CONSTRAINT "codex_department_pools_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "codex_projects"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

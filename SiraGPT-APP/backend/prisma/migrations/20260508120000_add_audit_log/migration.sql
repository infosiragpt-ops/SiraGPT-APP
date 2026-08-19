-- Audit log: actor / resource / action with before+after snapshots.

CREATE TABLE "audit_log" (
    "id"           TEXT NOT NULL,
    "actorType"    TEXT NOT NULL,
    "actorId"      TEXT,
    "actorName"    TEXT,
    "resourceType" TEXT NOT NULL,
    "resourceId"   TEXT,
    "action"       TEXT NOT NULL,
    "before"       JSONB,
    "after"        JSONB,
    "diff"         JSONB,
    "metadata"     JSONB,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_log_actorType_actorId_createdAt_idx"
    ON "audit_log" ("actorType", "actorId", "createdAt");
CREATE INDEX "audit_log_resourceType_resourceId_createdAt_idx"
    ON "audit_log" ("resourceType", "resourceId", "createdAt");
CREATE INDEX "audit_log_action_createdAt_idx"
    ON "audit_log" ("action", "createdAt");
CREATE INDEX "audit_log_createdAt_idx"
    ON "audit_log" ("createdAt");

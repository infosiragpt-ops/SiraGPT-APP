CREATE TABLE "codex_session_states" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "transcript" JSONB NOT NULL DEFAULT '[]',
    "snapshot" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "codex_session_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "codex_session_states_projectId_sessionId_key"
ON "codex_session_states"("projectId", "sessionId");

CREATE INDEX "codex_session_states_projectId_updatedAt_idx"
ON "codex_session_states"("projectId", "updatedAt");

ALTER TABLE "codex_session_states"
ADD CONSTRAINT "codex_session_states_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "codex_projects"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Slice C: server-backed /code editor FS snapshot per Project.
-- Distinct from File (knowledge/RAG). Single JSON blob; owner via projects.userId.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "codeWorkspace" JSONB;

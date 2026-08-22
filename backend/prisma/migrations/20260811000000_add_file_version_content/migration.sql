-- Additive column: edited Markdown for manual /chat document-editor edits (MVP).
-- Version rows created by the background document editor keep content NULL and
-- continue to point at their immutable artifactId.
ALTER TABLE "file_versions"
  ADD COLUMN IF NOT EXISTS "content" TEXT;
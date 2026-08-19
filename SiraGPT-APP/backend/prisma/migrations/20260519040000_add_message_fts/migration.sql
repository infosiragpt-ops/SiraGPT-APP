-- Full-text search support for Message.content.
--
-- We store the tsvector in a column managed by a BEFORE INSERT/UPDATE
-- trigger (instead of a Postgres GENERATED column) so the search
-- language can be runtime-configurable via the regconfig of choice
-- without an ALTER TABLE. Default language is `spanish` — flip to
-- `simple` for accent-insensitive multilingual indexing.
--
-- A GIN index on the tsvector keeps `@@` queries cheap even with
-- millions of rows. Soft-deleted messages keep their tsvector so a
-- one-off purge job can use the same path; the /api/search route
-- filters them out at query time.

ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "content_tsv" tsvector;

-- Backfill existing rows. coalesce guards against NULL content (none
-- expected, but cheap insurance).
UPDATE "messages"
  SET "content_tsv" = to_tsvector('spanish', coalesce("content", ''))
  WHERE "content_tsv" IS NULL;

-- Trigger function — recompute tsvector whenever content changes.
CREATE OR REPLACE FUNCTION messages_content_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW."content_tsv" := to_tsvector('spanish', coalesce(NEW."content", ''));
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_content_tsv_trigger ON "messages";
CREATE TRIGGER messages_content_tsv_trigger
  BEFORE INSERT OR UPDATE OF "content" ON "messages"
  FOR EACH ROW EXECUTE FUNCTION messages_content_tsv_update();

-- GIN index for fast @@ queries.
CREATE INDEX IF NOT EXISTS "messages_content_tsv_idx"
  ON "messages" USING GIN ("content_tsv");

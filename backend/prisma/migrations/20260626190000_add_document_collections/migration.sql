-- Persistent document collections for multi-file corpus analysis.
-- Reuses already-ingested File rows and stores durable pgvector chunks
-- scoped by collection so retrieval survives process restarts.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS document_collections (
    id          text PRIMARY KEY,
    owner_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        text NOT NULL,
    description text,
    status      text NOT NULL DEFAULT 'ready',
    doc_count   integer NOT NULL DEFAULT 0,
    chunk_count integer NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_collections_owner_created_idx
    ON document_collections (owner_id, created_at);

CREATE TABLE IF NOT EXISTS collection_documents (
    id            text PRIMARY KEY,
    collection_id text NOT NULL REFERENCES document_collections(id) ON DELETE CASCADE,
    document_id   text NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status        text NOT NULL DEFAULT 'queued',
    chunk_count   integer NOT NULL DEFAULT 0,
    last_error    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT collection_documents_collection_document_key UNIQUE (collection_id, document_id)
);

CREATE INDEX IF NOT EXISTS collection_documents_owner_status_idx
    ON collection_documents (owner_id, status);

CREATE INDEX IF NOT EXISTS collection_documents_document_idx
    ON collection_documents (document_id);

CREATE TABLE IF NOT EXISTS document_collection_chunks (
    id            text PRIMARY KEY,
    collection_id text NOT NULL REFERENCES document_collections(id) ON DELETE CASCADE,
    document_id   text NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content       text NOT NULL,
    embedding     vector(1536) NOT NULL,
    page          integer,
    "offset"      integer,
    token_count   integer NOT NULL DEFAULT 0,
    content_hash  text NOT NULL,
    metadata      jsonb,
    content_tsv   tsvector,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT document_collection_chunks_collection_document_hash_key UNIQUE (collection_id, document_id, content_hash)
);

CREATE INDEX IF NOT EXISTS document_collection_chunks_owner_collection_idx
    ON document_collection_chunks (owner_id, collection_id);

CREATE INDEX IF NOT EXISTS document_collection_chunks_document_idx
    ON document_collection_chunks (document_id);

CREATE INDEX IF NOT EXISTS document_collection_chunks_collection_hash_idx
    ON document_collection_chunks (collection_id, content_hash);

CREATE INDEX IF NOT EXISTS document_collection_chunks_content_tsv_idx
    ON document_collection_chunks USING GIN (content_tsv);

CREATE INDEX IF NOT EXISTS document_collection_chunks_embedding_idx
    ON document_collection_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE OR REPLACE FUNCTION document_collection_chunks_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.content_tsv :=
    to_tsvector('spanish', coalesce(NEW.content, '')) ||
    to_tsvector('simple', coalesce(NEW.content, ''));
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS document_collection_chunks_tsv_trigger ON document_collection_chunks;
CREATE TRIGGER document_collection_chunks_tsv_trigger
  BEFORE INSERT OR UPDATE OF content ON document_collection_chunks
  FOR EACH ROW EXECUTE FUNCTION document_collection_chunks_tsv_update();

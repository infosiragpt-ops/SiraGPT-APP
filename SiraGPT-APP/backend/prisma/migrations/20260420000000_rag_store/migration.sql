-- RAG chunk store with pgvector.
-- Enables the pgvector extension (safe to re-run) and creates the rag_chunks
-- table plus the triple-graph companion table for GEAR retrieval.
--
-- Required for `USE_PG_STORE=1` to work. The application falls back to the
-- in-memory store when this migration hasn't been applied.

CREATE EXTENSION IF NOT EXISTS vector;

-- ─── rag_chunks ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rag_chunks (
    id            BIGSERIAL PRIMARY KEY,
    user_id       TEXT        NOT NULL,
    collection    TEXT        NOT NULL,
    source        TEXT,
    title         TEXT,
    text_content  TEXT        NOT NULL,
    embedding     vector(1536) NOT NULL,
    meta          JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insertion-order + namespace lookup (used by getAll / trim / listSources).
CREATE INDEX IF NOT EXISTS rag_chunks_ns_time_idx
    ON rag_chunks (user_id, collection, created_at);

-- Source lookup (used by getBySource / list_files tool).
CREATE INDEX IF NOT EXISTS rag_chunks_ns_source_idx
    ON rag_chunks (user_id, collection, source);

-- Cosine similarity index. ivfflat performs well with lists ≈ sqrt(N) of
-- expected row count. Bumped to 100 for small-to-medium deployments; run
-- `ANALYZE rag_chunks;` after heavy inserts so the planner picks it.
CREATE INDEX IF NOT EXISTS rag_chunks_embed_idx
    ON rag_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ─── rag_triples ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rag_triples (
    id            BIGSERIAL PRIMARY KEY,
    user_id       TEXT        NOT NULL,
    collection    TEXT        NOT NULL,
    subject       TEXT        NOT NULL,
    predicate     TEXT        NOT NULL,
    object_value  TEXT        NOT NULL,
    source        TEXT,
    confidence    REAL,
    -- Sentence-form embedding for linkTriple (cosine). Nullable because
    -- heuristic-mode ingests without embeddings; a later LLM pass backfills.
    embedding     vector(1536),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, collection, subject, predicate, object_value)
);

-- Entity lookup for get_neighbours (GEAR §4.2).
CREATE INDEX IF NOT EXISTS rag_triples_subject_idx
    ON rag_triples (user_id, collection, subject);
CREATE INDEX IF NOT EXISTS rag_triples_object_idx
    ON rag_triples (user_id, collection, object_value);
CREATE INDEX IF NOT EXISTS rag_triples_source_idx
    ON rag_triples (user_id, collection, source);
CREATE INDEX IF NOT EXISTS rag_triples_embed_idx
    ON rag_triples USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50)
    WHERE embedding IS NOT NULL;

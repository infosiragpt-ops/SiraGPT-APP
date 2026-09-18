# Embeddings, RAG and memory — hardening notes (2026-09-18)

## Why

Production ran every embedding on ONE key (OpenAI). When that key was rejected
(401) the whole retrieval stack failed at once and silently:

- `rag-service.embed()` threw before the lexical ranker ran, so `retrieve()`
  returned an error instead of the BM25 hits it already had.
- Operational RAG (`rag/operational-runtime.js`) swallowed the error and served
  turns without evidence — the user saw "loses context".
- Memory extraction used a dedicated `new OpenAI()` client, so long-term memory
  stopped being written; semantic recall stopped as well.
- `/api/health` reported `model_providers` healthy because it only checks key
  presence, never validity.

## What changed

### `backend/src/utils/provider-key-health.js`
Process-wide memo of keys a provider REJECTED (401/403, "invalid api key").
`markRejected(provider, key, err)` / `isRejected(provider, key)`. Re-arms on TTL
(`SIRAGPT_KEY_REJECT_MEMO_MS`, 5 min), when the key fingerprint changes, or when
`admin-connections-bridge` applies a connection (`clear(provider)`). Quota,
network and 5xx errors are never memoised.

### `backend/src/services/embedding-provider.js`
The ladder: OpenAI (`text-embedding-3-small`, `dimensions` for ≠1536) → Gemini
(`gemini-embedding-001`, `outputDimensionality` + L2 normalisation) → Voyage →
Jina → Mistral (1024 only). Rules:

1. **Space id** `provider:model:dim` on every result. The first space that
   serves a dimension is sticky for the process; a flapping provider cannot
   interleave two spaces in one index. Callers that need a specific space pass
   `space` and get `EmbeddingUnavailableError` instead of a substitute.
2. **1:1 guarantee** — exactly `targetDim` floats per input or it throws (the
   OpenAI native 1536 path keeps the pre-ladder laxness so offline stubs work).
3. Results cached per (space, text); failures never cached.
4. Metrics: `siragpt_embedding_requests_total{provider,outcome}`,
   `siragpt_embedding_space_switch_total{dim,from,to}`.
5. `expectedSpace(dim)` is stable before and after the first call so
   `rag-service` can key its own embed cache on it.

### `backend/src/services/rag-service.js`
`_embedRaw` delegates to the ladder (handing over its shared OpenAI client so
the existing seams keep working). `retrieve()` wraps `embed()`: when embeddings
are unavailable it serves the lexical BM25 pool only, tags hits with
`retrievalMode: 'bm25_degraded'`, logs once per minute and bumps
`siragpt_rag_retrieve_mode_total{mode="bm25_degraded"}`.

### Memory
- `user-memory-store.js`: `SIRAGPT_MEMORY_EMBED_PROVIDER=auto|ladder` (default)
  embeds through the ladder at 1024 dims; explicit provider names still pin.
- `memory-semantic.js`: `isSemanticAvailable()` asks the ladder, not the env.
- `memory-llm-client.js`: `createMemoryLlmClient()` returns an OpenAI-shaped
  client that rides the doc-agent failover ladder (`SIRAGPT_MEMORY_LLM_MODEL`);
  `routes/ai.js` uses it for fact extraction instead of a raw OpenAI client.

### Health
`observability/health-check.js` `checkEmbeddings(env)` → `embeddings` check:
`pass` when a rung can serve 1536 dims, `warn` when the only key was rejected
or none configured, listing rejected providers and the active spaces.

## Operating it

- A rejected key shows in `/api/health` under `checks[].name == "embeddings"`
  and in the backend log as `[embedding-provider] <provider> rejected the API
  key (401); memoised, trying the next provider`.
- Fix = paste a valid key in Admin → Conexiones (the bridge clears the memo) or
  set the env and recreate the backend. No restart needed for the bridge path.
- Known latent issue (not changed here): `user_memories.embedding` was created
  as `vector(1024)` while the Prisma schema and the cross-chat writers assume
  1536. The ladder serves both, but the column type should be reconciled in a
  manual schema release.

## Tests
`backend/tests/embedding-provider.test.js` (memo, ladder failover with
normalisation, exact space, cache per space, BM25 degrade in `retrieve()`,
wiring of memory/health/metrics) plus the existing RAG/memory suites.

# Phase 8E.3: Stream Cache Migrated to quick-lru

## Scope

Phase 8E.3 closes the third and final cache identified in the Phase 8E
audit by migrating `backend/src/services/stream-cache.js` from a manual
`Map` plus `setInterval` reaper to the quick-lru instance already
introduced in Phase 8E.2. No new dependencies are added; this is a pure
internal migration.

The stream-cache module backs `GET /api/chats/:chatId/pending-stream`, the
endpoint the chat UI calls to recover a partial answer after a tab reload,
network blip or hard navigation while a stream is in flight.

## Why migrate

- The previous `Map` had no `maxSize`. A producer mistake — for example
  retrying a failing stream in a tight loop — could fill memory with
  orphan stream snapshots until the manual reaper caught them.
- The 60-second `setInterval` reaper held a long-lived timer reference.
  We had to call `.unref()` to keep it from pinning the event loop. With
  quick-lru, expiry is lazy: it happens on `get()` and on bulk `set()`
  pressure, so we can drop the timer entirely.
- quick-lru's `maxAge` matches the 10-minute TTL exactly. We refresh the
  per-entry timer by re-`set()`-ing the same object on every `append`,
  `complete` and `fail`, which preserves the previous sliding-TTL
  behavior with zero extra bookkeeping.

## Dependency

| Package | Version | License | Notes |
|---|---|---|---|
| `quick-lru` | `7.3.0` | MIT | Already added in Phase 8E.2 (`docs/phase-8e2-quick-lru-rerank-cache.md`). No new install. |

## Changes

- `backend/src/services/stream-cache.js`:
  - Replaces the module-level `Map` and the `ensureReaper`/`setInterval`
    reaper with a lazy quick-lru instance configured with
    `{ maxSize: STREAM_CACHE_MAX_ENTRIES (default 1000), maxAge: 10 min }`.
  - `start()` and `resume()` are now `async` to wait for the dynamic ESM
    import once. The handle returned by `start()` exposes synchronous
    `append`, `complete`, `fail` and `forget` methods because the cache
    instance is captured in the closure after the await.
  - `_reset()` and `_size()` test helpers became `async` for symmetry.
  - `ttlMs` is accepted on `start()` for API compatibility but the live
    cache uses an instance-wide `maxAge`. The only consumer of `ttlMs`
    today (`backend/src/routes/ai.js`) does not pass a custom value, so
    behavior is unchanged.
- `backend/src/routes/ai.js`: awaits `streamCache.start(...)` inside the
  existing `async (req, res) => {}` handler at the SSE producer.
- `backend/src/routes/chats.js`: changes the `GET
  /api/chats/:chatId/pending-stream` handler to `async` and awaits
  `streamCache.resume(...)`.
- `backend/.env.example`: documents `STREAM_CACHE_MAX_ENTRIES=1000`.
- `backend/tests/stream-cache.test.js` (new): the prior implementation
  shipped without unit coverage. The new suite locks the contract that
  the SSE handler depends on:
  - start + append + resume returns the partial snapshot
  - complete / fail flip status without dropping content
  - forget evicts; append after forget re-creates the entry
  - distinct (userId, chatId) pairs are isolated
  - the cache hard-caps at the configured maxSize under 2x bulk load.

## Behavior change summary

- The public surface (`start`, `resume`, `_reset`, `_size`) now returns
  Promises. The two production call sites are already in async contexts
  and were updated in the same commit.
- The handle returned by `start()` exposes synchronous `append`,
  `complete`, `fail`, `forget` methods, so the SSE write override in
  `ai.js` still runs synchronously per chunk.
- Sliding TTL is preserved: every `append`/`complete`/`fail` re-`set()`-s
  the entry under the same key, which resets quick-lru's per-entry timer.
- `STREAM_CACHE_MAX_ENTRIES` (default 1000) caps the in-memory snapshot
  count. Older entries are evicted by access order when the cache is
  full.

## Validation

Local:

```bash
cd backend
node --test tests/stream-cache.test.js
node -e "require('./src/routes/chats'); require('./src/routes/ai'); require('./src/services/stream-cache'); console.log('OK')"
cd ..
npm run licenses:check
```

Manual smoke (frontend on :3000, backend on :5000):

1. Start a long answer in `/chat`.
2. Reload the tab while it is streaming.
3. Confirm `GET /api/chats/:chatId/pending-stream` returns the partial
   content snapshot.
4. Stop the stream upstream (kill the backend mid-answer) and reload —
   the snapshot should reflect the last seen content with status
   `streaming` until it ages out.

Production:

- Re-run `npm run licenses:check` and `npm audit --omit=dev
  --audit-level=critical` before merge.
- Confirm GitHub Actions `frontend`, `backend`, `licenses` and
  `CI · required checks passed` are green.
- For multi-instance deploys, raise `STREAM_CACHE_MAX_ENTRIES` per
  instance only if observed concurrent in-flight streams approach the
  default cap. The cache is in-process; clusters do not share state.
  A future phase will swap quick-lru for Redis with the same surface.

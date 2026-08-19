# SSE Resumption Tokens for `/api/ai/generate`

MVP token-based resumption layer for the AI generate SSE stream. Lets a
client recover from a transient network drop without losing already-emitted
tokens.

## Wire-level contract

### First request
- Client `POST /api/ai/generate` with the usual body. No `Last-Event-ID`.
- Server responds with `Content-Type: text/event-stream` and sets:
  - `X-Stream-Id: <uuid>` — opaque resumption token. Persists for 5 minutes
    after the stream ends (TTL configurable via the module constant).
- Server emits SSE frames with an `id:` line:
  ```
  id: <streamId>:<position>
  data: {"content":"hello"}
  ```
  Where `position` is the 1-based count of content frames emitted so far.
- Client SHOULD store the `X-Stream-Id` and the last seen `id:` value.

### Reconnect
- Client retries `POST /api/ai/generate` (same body, fresh AbortController)
  and sets the `Last-Event-ID` request header to the most recent `id:` value.
- Server parses `Last-Event-ID: <streamId>:<position>` and:
  1. Looks up the resume record by `streamId` (Redis L1, in-memory L2).
  2. Replays `chunks.slice(position)` as fresh SSE frames marked
     `{"content": "...", "_resumed": true}` so the client can elide the
     duplicate-write effect on the UI if it wants.
  3. Continues the stream as normal (in this MVP, a new upstream model
     call is initiated — full token-by-token replay-only is not implemented
     because the upstream provider has already moved on).

### Storage
- Backend: Redis when `REDIS_URL` is set (ioredis lazy-loaded). Falls back
  to an in-process `Map` in single-instance deployments / tests.
- Records are JSON: `{ chunks: string[], complete: boolean, error: string|null }`.
- TTL: 5 minutes per record (sliding — every append refreshes EX).
- Hard cap: 4000 chunks per stream (older chunks are dropped silently).
- Best-effort: every Redis call swallows errors. A storage outage downgrades
  to "no resume available"; the live request path is never broken.

## Limitations (MVP)
- The resume only restores **emitted text frames**. Tool calls, usage trailers,
  and artifact frames are not re-issued.
- A single resume per stream is supported; the server doesn't track multiple
  concurrent readers of the same record.
- After a successful `complete()`, the record stays for one TTL window so a
  late reconnect still gets the full content. After TTL it's gone.
- The Last-Event-ID flow currently triggers a fresh upstream model call.
  True mid-stream takeover from the upstream provider would require provider-
  side resumption APIs (not generally available).

## Configuration
- `REDIS_URL` — enables shared resume storage across instances.
- `streamResume.DEFAULT_TTL_SECONDS` — 300 seconds (5 min).
- `streamResume.DEFAULT_MAX_CHUNKS` — 4000.

## Files
- `backend/src/services/ai/stream-resume.js` — storage + helpers.
- `backend/src/routes/ai.js` — wiring (preflight + capture + replay + finally).
- `backend/tests/stream-resume.test.js` — unit tests.

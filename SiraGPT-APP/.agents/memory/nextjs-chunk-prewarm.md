---
name: Next.js chunk timeout prewarm
description: How to prevent Replit proxy timeouts when Next.js compiles lazy chunks (global-error.js, etc.) on first demand
---

## Rule
In Replit's dev environment the proxy has a hard timeout. Next.js compiles `app/global-error.js` (and other lazy chunks) on-demand the **first time** they are requested. That first compilation can take 5-15 seconds — long enough for the proxy to cut the connection and deliver a `ChunkLoadError: timeout` to the browser.

**Why:** Next.js does NOT pre-compile `global-error.js` at dev-server startup; it only compiles it when the browser's webpack runtime issues `import()`. The Replit proxy sees the stalled request and terminates it before the file is served.

**How to apply:**
1. Create `scripts/prewarm-chunks.js` — a Node.js script that:
   - Polls `GET http://localhost:FRONTEND_PORT/` in a loop (3 s interval, 3 min deadline).
   - Once Next.js answers 200, waits 5 s for initial compilation to settle.
   - Then `GET`s each chunk in the `CHUNKS` list with a generous timeout (30 s).
   - Logs `[prewarm] <path> → <status>` for each chunk.
2. Add the prewarm as a third `spawn()` in the workflow's `node -e` inline script, alongside the backend and frontend spawns.
3. The CHUNKS list currently contains `/_next/static/chunks/app/global-error.js`. Add others (e.g. `/error`, layout segments) if new timeout errors appear.

## Important
- Do NOT add `CHUNKS` paths that change on every compile (hashed filenames). These must be stable paths; `app/global-error.js` is stable.
- The prewarm does not block the workflow from serving requests — it runs in background and completes silently.
- The hydration mismatch warning that sometimes appears alongside this error is **separate**: React recovers from it automatically and it does NOT itself cause the chunk timeout.

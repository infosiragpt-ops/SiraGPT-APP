---
name: R2 binary offload architecture
description: How user binary content is offloaded from the VM disk to Cloudflare R2, and the stream-error rule that keeps downloads safe.
---

# R2 binary offload

All user binary content (uploads, generated images, generated videos, generated documents/artifacts) is offloaded from the Reserved VM local disk to Cloudflare R2. Text stays in Postgres. R2 is enabled whenever the four R2 secrets are present (so it is ON in dev too).

- Storage refs are stored as the string `r2:<key>` (see `object-storage.js` `refFromKey`). Consumers branch on the ref prefix; when R2 is disabled the value is a local path instead.
- Generated artifacts (docs): the **binary** is mirrored to R2 fire-and-forget (`startArtifactMirror`) and the local binary unlinked only **after** a successful `putBuffer` (no data-loss race). The **metadata JSON stays local** — it is the source of truth for listings and ownership. Serving route is local-first, then R2 fallback.
- Generated images: provider URLs are copied once into R2 under `uploads/images/...` (a PUBLIC_UPLOAD_PREFIX served by the `/uploads` R2 fallback); on any copy/upload error it falls back to the original provider URL rather than failing.

**Why / critical rule:** When piping an R2 `readStream` to an Express `res`, you MUST attach `stream.on('error', ...)`. A Node Readable that aborts mid-stream emits `error`; with no handler it can crash the request or process. This bit the video download/watch (range + full) routes — the local `streamFile` path was already guarded but the R2 branches were not. If headers are not yet sent, respond 502 (not a silent 404, which misleads ops); if already sent, `res.destroy()`.

**How to apply:** Any new code that does `objectStorage.readStream(ref).stream.pipe(res)` needs the same error handler. Mirror the guarded behavior already in `agent-task.js` `/artifact/:id` and `video.js`.

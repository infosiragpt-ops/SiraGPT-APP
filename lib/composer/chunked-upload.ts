/**
 * Chunked upload planning (pure). Production runs behind a Cloudflare proxy
 * that rejects any single request body above 100 MB, so large media (a
 * lecture recording, a meeting video) must travel in chunks. This module
 * decides which files take that path and how they are split; the transport
 * lives in `lib/api.ts` (`uploadFileChunked`, engine in `./resumable-upload`).
 */

import { isMediaUpload } from "../attachment-ingest"

function envInt(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Files at or above this size never fit a single proxied request. */
export const CHUNKED_UPLOAD_THRESHOLD_BYTES =
  envInt(process.env.NEXT_PUBLIC_CHUNKED_UPLOAD_THRESHOLD_MB, 80) * 1024 * 1024

/**
 * Audio/video go chunked much earlier: a 5 h lecture at 24-32 kbps weighs
 * 54-72 MB, and the chunked path is the one that survives a dropped
 * connection (resume) and reports bytes/speed/ETA.
 */
export const CHUNKED_MEDIA_THRESHOLD_BYTES =
  envInt(process.env.NEXT_PUBLIC_CHUNKED_MEDIA_THRESHOLD_MB, 32) * 1024 * 1024

/** Chunk size: comfortably under the proxy limit, few round-trips. */
export const CHUNKED_UPLOAD_CHUNK_BYTES =
  envInt(process.env.NEXT_PUBLIC_CHUNKED_UPLOAD_CHUNK_MB, 16) * 1024 * 1024

/** Chunks in flight at once (2-3 fill a lossy / high-RTT uplink; capped at 4). */
export const CHUNKED_UPLOAD_PARALLEL =
  Math.min(4, Math.max(1, Math.floor(envInt(process.env.NEXT_PUBLIC_CHUNKED_UPLOAD_PARALLEL, 3))))

export type ChunkPlan = { index: number; start: number; end: number; bytes: number }

export type UploadSizeLike = { size?: number | null; type?: string | null; name?: string | null }

export function shouldUseChunkedUpload(
  file: UploadSizeLike | null | undefined,
  threshold: number = CHUNKED_UPLOAD_THRESHOLD_BYTES,
  mediaThreshold: number = CHUNKED_MEDIA_THRESHOLD_BYTES,
): boolean {
  const size = Number(file?.size)
  if (!Number.isFinite(size)) return false
  if (size >= threshold) return true
  if (!(size >= mediaThreshold)) return false
  return isMediaUpload({ type: file?.type ?? undefined, name: file?.name ?? undefined, size })
}

export function planChunks(totalBytes: number, chunkBytes: number = CHUNKED_UPLOAD_CHUNK_BYTES): ChunkPlan[] {
  const total = Math.max(0, Math.floor(Number(totalBytes) || 0))
  const chunk = Math.max(1, Math.floor(Number(chunkBytes) || CHUNKED_UPLOAD_CHUNK_BYTES))
  const plans: ChunkPlan[] = []
  for (let start = 0, index = 0; start < total; start += chunk, index += 1) {
    const end = Math.min(total, start + chunk)
    plans.push({ index, start, end, bytes: end - start })
  }
  return plans
}

/** 0–100 across the whole file: completed chunks plus the in-flight one. */
export function chunkedUploadPercent(
  totalBytes: number,
  completedBytes: number,
  inFlightLoaded: number = 0,
): number {
  const total = Math.max(1, Number(totalBytes) || 0)
  const done = Math.min(total, Math.max(0, (Number(completedBytes) || 0) + (Number(inFlightLoaded) || 0)))
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
}

/** Transient failures worth a retry on the same chunk. */
export function isRetriableChunkStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 425 || status === 429 || status === 502 || status === 503 || status === 504
}

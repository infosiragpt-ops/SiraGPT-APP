/**
 * Chunked upload planning (pure). Production runs behind a Cloudflare proxy
 * that rejects any single request body above 100 MB, so large media (a
 * lecture recording, a meeting video) must travel in chunks. This module
 * decides which files take that path and how they are split; the transport
 * lives in `lib/api.ts` (`uploadFileChunked`).
 */

function envInt(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Files at or above this size never fit a single proxied request. */
export const CHUNKED_UPLOAD_THRESHOLD_BYTES =
  envInt(process.env.NEXT_PUBLIC_CHUNKED_UPLOAD_THRESHOLD_MB, 80) * 1024 * 1024

/** Chunk size: comfortably under the proxy limit, few round-trips. */
export const CHUNKED_UPLOAD_CHUNK_BYTES =
  envInt(process.env.NEXT_PUBLIC_CHUNKED_UPLOAD_CHUNK_MB, 16) * 1024 * 1024

export type ChunkPlan = { index: number; start: number; end: number; bytes: number }

export type UploadSizeLike = { size?: number | null }

export function shouldUseChunkedUpload(
  file: UploadSizeLike | null | undefined,
  threshold: number = CHUNKED_UPLOAD_THRESHOLD_BYTES,
): boolean {
  const size = Number(file?.size)
  return Number.isFinite(size) && size >= threshold
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

export type ChunkedFileIdentity = { name: string; size: number; mimeType: string; chunkSize: number; chunkHashes: string[] }
export type ResumableChunkSession = ChunkedFileIdentity & { uploadId: string; totalChunks: number; received?: number[]; status?: string; files?: any[] }
export function normalizeUploadChunkBytes(bytes: number): number {
  return Math.min(64 * 1024 * 1024, Math.max(1024 * 1024, Math.floor(Number(bytes) || CHUNKED_UPLOAD_CHUNK_BYTES)))
}
async function sha256(data: ArrayBuffer | Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("No se pudo verificar la identidad del archivo para reanudar la subida.")
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data as BufferSource)
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("")
}
/** Hash one bounded chunk at a time, not a multi-GB recording in RAM. */
export async function identifyChunkedFile(file: File, chunkBytes: number, signal?: AbortSignal): Promise<{ identity: ChunkedFileIdentity; fingerprint: string }> {
  const chunkSize = normalizeUploadChunkBytes(chunkBytes)
  const chunkHashes: string[] = []
  for (const plan of planChunks(file.size, chunkSize)) {
    if (signal?.aborted) throw Object.assign(new Error("Upload aborted"), { name: "AbortError" })
    chunkHashes.push(await sha256(await file.slice(plan.start, plan.end).arrayBuffer()))
  }
  const identity = { name: file.name, size: file.size, mimeType: file.type || "application/octet-stream", chunkSize, chunkHashes }
  return { identity, fingerprint: await sha256(new TextEncoder().encode(JSON.stringify(identity))) }
}
const resumeKey = (ownerId: string, fingerprint: string) => `siragpt:chunked-upload:v1:${encodeURIComponent(ownerId)}:${fingerprint}`
export function readChunkedUploadPointer(ownerId: string, fingerprint: string): string | null {
  try {
    const id = localStorage.getItem(resumeKey(ownerId, fingerprint))
    return id && /^[a-f0-9]{32}$/.test(id) ? id : null
  } catch { return null }
}
export function writeChunkedUploadPointer(ownerId: string, fingerprint: string, uploadId: string | null) {
  try {
    if (uploadId) localStorage.setItem(resumeKey(ownerId, fingerprint), uploadId)
    else localStorage.removeItem(resumeKey(ownerId, fingerprint))
  } catch { /* idempotent server init can recover even without browser storage */ }
}
export function matchesChunkedFileIdentity(session: ResumableChunkSession, identity: ChunkedFileIdentity): boolean {
  return session.name === identity.name && session.size === identity.size && session.mimeType === identity.mimeType
    && session.chunkSize === identity.chunkSize && session.totalChunks === identity.chunkHashes.length
    && Array.isArray(session.chunkHashes) && session.chunkHashes.length === identity.chunkHashes.length
    && session.chunkHashes.every((hash, index) => hash === identity.chunkHashes[index])
}
export function waitForChunkRetry(delay: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(Object.assign(new Error("Upload aborted"), { name: "AbortError" })) }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve() }, delay)
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener("abort", abort, { once: true })
  })
}

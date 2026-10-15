/**
 * Resumable chunked upload engine (transport-agnostic) + the HTTP transport
 * `lib/api.ts` wires for `uploadFileChunked`.
 *
 * A 2-6 GB lecture over a real network meets Wi-Fi switches, a laptop that
 * sleeps, a mobile tab in the background and backend restarts on every
 * deploy. The old loop retried a chunk 3 times over ~7 s and then DELETED the
 * server session, destroying every byte already uploaded. Here:
 *
 *  - 2-3 chunks travel in parallel (XHR, so there is real upload progress),
 *    dispatched in ascending index order;
 *  - a transient failure (network, 408/425/429, 5xx, offline, stall) PAUSES
 *    the upload — capped backoff for up to ~45 min, woken early by `online`
 *    or by the tab becoming visible — then asks the server which chunks it
 *    already has (GET status) and sends only the missing ones;
 *  - the server session is deleted ONLY on a user cancel or a non-retriable
 *    4xx; auth, disk-full and long outages keep it for a later resume;
 *  - `{ uploadId }` is remembered in localStorage under a name+size+
 *    lastModified fingerprint, so re-attaching the same file after a reload
 *    resumes instead of restarting (every storage access is try/catch);
 *  - progress carries bytes, an EMA of bytes/s and an ETA.
 */

import { chunkedUploadPercent, planChunks, type ChunkPlan } from "./chunked-upload"

// ─── Types ─────────────────────────────────────────────────────────────

export type ChunkedUploadSession = {
  uploadId: string
  chunkSize: number
  totalChunks: number
  size?: number
}

export type ChunkedUploadStatus = ChunkedUploadSession & {
  name?: string
  size: number
  received: number[]
  completed?: boolean
  fileId?: string | null
  expiresAt?: string
}

export type ChunkedUploadPhase = "uploading" | "reconnecting" | "completing"

export type ChunkedUploadStats = {
  percent: number
  loaded: number
  total: number
  /** Smoothed throughput (EMA); null until measured or while paused. */
  bytesPerSec: number | null
  /** Seconds left at the current rate; null when unknown. */
  etaSeconds: number | null
  phase: ChunkedUploadPhase
  /** True when this upload continued a previous session (bytes already on the server). */
  resumed: boolean
  /** While reconnecting: delay before the next attempt. */
  retryInMs?: number
  /** Ready-to-show Spanish line («Subiendo 1,2 GB de 4,0 GB · 9 MB/s · quedan 6 min»). */
  label: string
}

export type ChunkedUploadProgressCallback = (
  percent: number,
  loadedBytes: number,
  totalBytes: number,
  stats: ChunkedUploadStats,
) => void

export type ChunkPutInput = {
  uploadId: string
  index: number
  body: Blob
  signal: AbortSignal
  onLoaded: (loadedBytes: number) => void
}

export interface ResumableUploadTransport<TResult = unknown> {
  init(input: { name: string; size: number; mimeType: string; chunkSize: number; sourceChannel?: string | null }, signal?: AbortSignal): Promise<ChunkedUploadSession>
  status(uploadId: string, signal?: AbortSignal): Promise<ChunkedUploadStatus>
  putChunk(input: ChunkPutInput): Promise<void>
  complete(uploadId: string, signal?: AbortSignal): Promise<TResult>
  /** Best-effort: must survive the caller's own signal being aborted. */
  abort(uploadId: string): Promise<void>
}

export type ResumeRecord = {
  uploadId: string
  size: number
  chunkSize: number
  totalChunks: number
  savedAt: number
}

export interface ResumeStore {
  get(fingerprint: string): ResumeRecord | null
  set(fingerprint: string, record: ResumeRecord): void
  remove(fingerprint: string): void
}

export type ResumableTiming = {
  /** Give up a paused upload after this long without progress (default 45 min). */
  maxPauseMs: number
  retryBaseMs: number
  retryMaxMs: number
  /** Cap for a server-provided Retry-After. */
  retryAfterMaxMs: number
  /** Consecutive generic 500s tolerated before failing (a bug, not an outage). */
  serverErrorRetries: number
  progressIntervalMs: number
}

export const DEFAULT_RESUMABLE_TIMING: ResumableTiming = {
  maxPauseMs: 45 * 60_000,
  retryBaseMs: 1_000,
  retryMaxMs: 30_000,
  retryAfterMaxMs: 60_000,
  serverErrorRetries: 6,
  progressIntervalMs: 250,
}

/** The server keeps an unfinished session 48 h; a local record a bit less. */
export const RESUME_RECORD_MAX_AGE_MS = 47 * 60 * 60 * 1000
export const RESUME_STORAGE_KEY = "siragpt:chunked-uploads:v1"
const RESUME_STORE_MAX_ENTRIES = 20

// ─── Errors ────────────────────────────────────────────────────────────

/** HTTP-level failure of one request. `status` 0 = network / stall / offline. */
export class ChunkedUploadHttpError extends Error {
  readonly status: number
  readonly code: string | null
  readonly retryAfterMs: number | null

  constructor(status: number, message: string, opts: { code?: string | null; retryAfterMs?: number | null } = {}) {
    super(message)
    this.name = "ChunkedUploadHttpError"
    this.status = status
    this.code = opts.code ?? null
    this.retryAfterMs = opts.retryAfterMs ?? null
  }
}

/** The upload stopped but its bytes stay on the server: re-attaching the file resumes it. */
export class ChunkedUploadPausedError extends Error {
  readonly resumable = true
  readonly status: number

  constructor(message: string, status = 0) {
    super(message)
    this.name = "ChunkedUploadPausedError"
    this.status = status
  }
}

export function abortError(): Error {
  return Object.assign(new Error("Upload aborted"), { name: "AbortError" })
}

function isAbortLike(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { name?: string }).name === "AbortError")
}

export type ChunkFailureKind = "transient" | "server" | "auth" | "gone" | "missing" | "completed" | "storage" | "fatal"

/**
 * How the engine treats a failed request:
 *  - transient: network / 0 / 408 / 425 / 429 / 502-504 (and other 5xx except
 *    501/505/507) → pause and resume, never delete;
 *  - server: a generic 500 → retried a few times, then stop WITHOUT delete;
 *  - auth: 401/403 → stop, keep the session for after the re-login;
 *  - gone: 404 → the session expired or was swept;
 *  - missing / completed: 409 chunks_missing / upload_completed → resync;
 *  - storage: 507 → the server disk is full, stop and keep the bytes;
 *  - fatal: any other 4xx → delete the server session and stop.
 */
export function classifyChunkFailure(status: number, code?: string | null): ChunkFailureKind {
  if (status === 0 || status === 408 || status === 425 || status === 429) return "transient"
  if (status === 401 || status === 403) return "auth"
  if (status === 404) return "gone"
  if (status === 409 && code === "chunks_missing") return "missing"
  if (status === 409 && code === "upload_completed") return "completed"
  if (status === 507) return "storage"
  if (status === 500) return "server"
  if (status === 501 || status === 505) return "fatal"
  if (status >= 500) return "transient"
  return "fatal"
}

// ─── Formatting (Spanish chip copy) ────────────────────────────────────

const KB = 1024
const MB = 1024 * KB
const GB = 1024 * MB

function decimalEs(value: number, digits: number): string {
  return value.toFixed(digits).replace(".", ",")
}

export function formatBytesEs(bytes: number): string {
  const n = Math.max(0, Number(bytes) || 0)
  if (n >= GB) return `${decimalEs(n / GB, 1)} GB`
  if (n >= MB) return `${Math.round(n / MB)} MB`
  if (n >= KB) return `${Math.round(n / KB)} KB`
  return `${Math.round(n)} B`
}

export function formatRateEs(bytesPerSec: number | null): string | null {
  if (bytesPerSec === null || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return null
  if (bytesPerSec >= 10 * MB) return `${Math.round(bytesPerSec / MB)} MB/s`
  if (bytesPerSec >= MB) return `${decimalEs(bytesPerSec / MB, 1).replace(/,0$/, "")} MB/s`
  return `${Math.max(1, Math.round(bytesPerSec / KB))} KB/s`
}

export function formatEtaEs(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null
  const s = Math.ceil(seconds)
  if (s < 60) return `quedan ${Math.max(1, s)} s`
  const minutes = Math.round(s / 60)
  if (minutes < 60) return `quedan ${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `quedan ${h} h ${m} min` : `quedan ${h} h`
}

export function describeChunkedUploadProgress(stats: Omit<ChunkedUploadStats, "label">): string {
  if (stats.phase === "reconnecting") return "Conexión perdida — reanudando"
  if (stats.phase === "completing") return "Terminando la subida…"
  const parts = [`Subiendo ${formatBytesEs(stats.loaded)} de ${formatBytesEs(stats.total)}`]
  const rate = formatRateEs(stats.bytesPerSec)
  if (rate) parts.push(rate)
  const eta = formatEtaEs(stats.etaSeconds)
  if (eta) parts.push(eta)
  return parts.join(" · ")
}

// ─── Throughput ────────────────────────────────────────────────────────

/** EMA of bytes/s over ≥ `minSampleMs` windows; reset after a pause. */
export function createThroughputMeter(opts: { alpha?: number; minSampleMs?: number } = {}) {
  const alpha = opts.alpha ?? 0.3
  const minSampleMs = opts.minSampleMs ?? 500
  let last: { t: number; bytes: number } | null = null
  let ema: number | null = null
  return {
    sample(t: number, bytes: number): number | null {
      if (!last) {
        last = { t, bytes }
        return ema
      }
      const dt = t - last.t
      if (bytes < last.bytes) {
        // An in-flight chunk failed and its partial bytes left the total.
        last = { t, bytes }
        return ema
      }
      if (dt < minSampleMs) return ema
      const inst = ((bytes - last.bytes) / dt) * 1000
      ema = ema === null ? inst : ema + alpha * (inst - ema)
      last = { t, bytes }
      return ema
    },
    /** A pause must not count as "0 B/s" nor bridge the gap into one sample. */
    resetBaseline(): void {
      last = null
    },
    get rate(): number | null {
      return ema
    },
  }
}

// ─── Resume store (localStorage, all access try/catch) ─────────────────

export function fingerprintFile(file: { name?: string; size?: number; lastModified?: number } | null | undefined): string | null {
  const name = String(file?.name || "")
  const size = Number(file?.size)
  const lastModified = Number(file?.lastModified)
  if (!name || !Number.isFinite(size) || size <= 0 || !Number.isFinite(lastModified) || lastModified <= 0) return null
  return `${name}|${size}|${lastModified}`
}

function defaultStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null
  } catch {
    return null
  }
}

export function createLocalResumeStore(
  opts: { storage?: () => Storage | null; now?: () => number; maxAgeMs?: number } = {},
): ResumeStore {
  const getStorage = opts.storage ?? defaultStorage
  const now = opts.now ?? (() => Date.now())
  const maxAgeMs = opts.maxAgeMs ?? RESUME_RECORD_MAX_AGE_MS

  const read = (): Record<string, ResumeRecord> => {
    try {
      const raw = getStorage()?.getItem(RESUME_STORAGE_KEY)
      if (!raw) return {}
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
      const fresh: Record<string, ResumeRecord> = {}
      for (const [key, value] of Object.entries(parsed as Record<string, ResumeRecord>)) {
        if (!value || typeof value.uploadId !== "string" || !Number.isFinite(value.savedAt)) continue
        if (now() - value.savedAt > maxAgeMs) continue
        fresh[key] = value
      }
      return fresh
    } catch {
      return {}
    }
  }
  const write = (records: Record<string, ResumeRecord>) => {
    try {
      const storage = getStorage()
      if (!storage) return
      const entries = Object.entries(records).sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, RESUME_STORE_MAX_ENTRIES)
      if (entries.length === 0) storage.removeItem(RESUME_STORAGE_KEY)
      else storage.setItem(RESUME_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
    } catch {
      /* quota / blocked storage: resume simply is not available */
    }
  }
  return {
    get(fingerprint) {
      return read()[fingerprint] ?? null
    },
    set(fingerprint, record) {
      const records = read()
      records[fingerprint] = record
      write(records)
    },
    remove(fingerprint) {
      const records = read()
      if (!(fingerprint in records)) return
      delete records[fingerprint]
      write(records)
    },
  }
}

// ─── Waiting (backoff woken early by `online` / visibility) ─────────────

export type WakeReason = "timer" | "online" | "visible"

export function waitForWake(ms: number, signal?: AbortSignal): Promise<WakeReason> {
  return new Promise<WakeReason>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const hasWindow = typeof window !== "undefined" && typeof window.addEventListener === "function"
    const hasDocument = typeof document !== "undefined" && typeof document.addEventListener === "function"
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (hasWindow) window.removeEventListener("online", onOnline)
      if (hasDocument) document.removeEventListener("visibilitychange", onVisible)
      signal?.removeEventListener("abort", onAbort)
    }
    const onOnline = () => { cleanup(); resolve("online") }
    const onVisible = () => {
      if (document.visibilityState !== "visible") return
      cleanup()
      resolve("visible")
    }
    const onAbort = () => { cleanup(); reject(abortError()) }
    timer = setTimeout(() => { cleanup(); resolve("timer") }, Math.max(0, ms))
    if (hasWindow) window.addEventListener("online", onOnline)
    if (hasDocument) document.addEventListener("visibilitychange", onVisible)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

// ─── Engine ────────────────────────────────────────────────────────────

export type ResumableFile = Blob & { name: string; lastModified?: number; type: string }

export type RunResumableUploadOptions<TResult> = {
  file: ResumableFile
  transport: ResumableUploadTransport<TResult>
  chunkBytes: number
  parallel?: number
  signal?: AbortSignal
  onProgress?: ChunkedUploadProgressCallback
  sourceChannel?: string | null
  /** null disables resume across reloads (the in-call pause/resume still works). */
  resumeStore?: ResumeStore | null
  timing?: Partial<ResumableTiming>
  now?: () => number
  wait?: (ms: number, signal?: AbortSignal) => Promise<unknown>
  random?: () => number
}

const MESSAGES = {
  paused: "La conexión no volvió en 45 minutos. Lo que ya se subió se conserva en el servidor: vuelve a adjuntar el mismo archivo para continuar donde quedó.",
  auth: "Tu sesión expiró durante la subida. Inicia sesión de nuevo y vuelve a adjuntar el archivo: continuará donde quedó.",
  storage: "No hay espacio suficiente en el servidor para guardar este archivo. Inténtalo más tarde o avisa al administrador.",
  server: "El servidor no pudo guardar una parte del archivo. Vuelve a adjuntarlo más tarde: continuará donde quedó.",
  gone: "La subida caducó en el servidor. Vuelve a adjuntar el archivo.",
  missing: "El servidor no recibió todas las partes del archivo. Vuelve a adjuntarlo.",
}

function backoffMs(attempt: number, timing: ResumableTiming, retryAfterMs: number | null, random: () => number): number {
  const exp = Math.min(timing.retryMaxMs, timing.retryBaseMs * 2 ** Math.min(attempt, 16))
  const jittered = Math.round(exp * (0.8 + 0.4 * random()))
  const hinted = retryAfterMs !== null && Number.isFinite(retryAfterMs) ? Math.min(timing.retryAfterMaxMs, Math.max(0, retryAfterMs)) : 0
  return Math.max(jittered, hinted)
}

function asHttpError(err: unknown): ChunkedUploadHttpError {
  if (err instanceof ChunkedUploadHttpError) return err
  const message = err instanceof Error && err.message ? err.message : "Error de red durante la subida."
  return new ChunkedUploadHttpError(0, message)
}

export async function runResumableUpload<TResult>(opts: RunResumableUploadOptions<TResult>): Promise<TResult> {
  const { file, transport, signal, onProgress } = opts
  const timing: ResumableTiming = { ...DEFAULT_RESUMABLE_TIMING, ...(opts.timing || {}) }
  const now = opts.now ?? (() => Date.now())
  const wait = opts.wait ?? waitForWake
  const random = opts.random ?? Math.random
  const parallel = Math.max(1, Math.min(6, Math.floor(opts.parallel ?? 3)))
  const resumeStore = opts.resumeStore === undefined ? createLocalResumeStore() : opts.resumeStore
  const total = file.size
  const fingerprint = fingerprintFile(file)
  const saved = fingerprint && resumeStore ? resumeStore.get(fingerprint) : null

  const throwIfAborted = () => {
    if (signal?.aborted) throw abortError()
  }

  let session: ChunkedUploadSession | null = null
  const activeUploadId = (): string => {
    if (!session) throw new ChunkedUploadHttpError(404, MESSAGES.gone, { code: "upload_not_found" })
    return session.uploadId
  }
  let plans: ChunkPlan[] = []
  let received = new Set<number>()
  let resumed = false
  const inflight = new Map<number, number>()
  const meter = createThroughputMeter()
  let lastEmit = 0
  let lastPhase: ChunkedUploadPhase | null = null

  const confirmedBytes = () => {
    let sum = 0
    for (const plan of plans) if (received.has(plan.index)) sum += plan.bytes
    return sum
  }
  const loadedBytes = () => {
    let sum = confirmedBytes()
    for (const loaded of inflight.values()) sum += loaded
    return Math.min(total, sum)
  }
  const emit = (phase: ChunkedUploadPhase, extra: { force?: boolean; retryInMs?: number } = {}) => {
    if (!onProgress) return
    const t = now()
    const loaded = phase === "completing" ? total : loadedBytes()
    const rate = phase === "uploading" ? meter.sample(t, loaded) : null
    if (!extra.force && phase === lastPhase && t - lastEmit < timing.progressIntervalMs) return
    lastEmit = t
    lastPhase = phase
    const bytesPerSec = phase === "uploading" && rate !== null && rate > 0 ? rate : null
    const etaSeconds = bytesPerSec ? Math.max(0, (total - loaded) / bytesPerSec) : null
    const base = {
      percent: chunkedUploadPercent(total, loaded),
      loaded,
      total,
      bytesPerSec,
      etaSeconds,
      phase,
      resumed,
      ...(extra.retryInMs !== undefined ? { retryInMs: extra.retryInMs } : {}),
    }
    const stats: ChunkedUploadStats = { ...base, label: describeChunkedUploadProgress(base) }
    try {
      onProgress(stats.percent, stats.loaded, stats.total, stats)
    } catch {
      /* a consumer's setState after unmount must not break the upload */
    }
  }

  const adopt = (next: ChunkedUploadSession, receivedIndexes: number[] = []) => {
    session = next
    plans = planChunks(total, next.chunkSize)
    received = new Set(receivedIndexes.filter((i) => Number.isInteger(i) && i >= 0 && i < plans.length))
  }
  const remember = () => {
    if (!fingerprint || !resumeStore || !session) return
    resumeStore.set(fingerprint, {
      uploadId: session.uploadId,
      size: total,
      chunkSize: session.chunkSize,
      totalChunks: session.totalChunks,
      savedAt: now(),
    })
  }
  const forget = () => {
    if (fingerprint && resumeStore) resumeStore.remove(fingerprint)
  }
  const abortServerSession = async () => {
    if (!session) return
    try { await transport.abort(session.uploadId) } catch { /* best effort */ }
  }

  let outage: { since: number; attempt: number } | null = null
  let serverErrors = 0
  const progressed = () => {
    outage = null
    serverErrors = 0
  }

  const uploadPending = async () => {
    const uploadId = activeUploadId()
    const pending = plans.filter((plan) => !received.has(plan.index))
    if (pending.length === 0) return
    const run = new AbortController()
    const onAbort = () => run.abort()
    signal?.addEventListener("abort", onAbort, { once: true })
    let next = 0
    let failure: unknown = null
    const worker = async () => {
      while (failure === null && next < pending.length) {
        if (signal?.aborted) {
          failure = abortError()
          return
        }
        const plan = pending[next]
        next += 1
        inflight.set(plan.index, 0)
        try {
          await transport.putChunk({
            uploadId,
            index: plan.index,
            body: file.slice(plan.start, plan.end),
            signal: run.signal,
            onLoaded: (loaded) => {
              if (!inflight.has(plan.index)) return
              inflight.set(plan.index, Math.max(0, Math.min(plan.bytes, loaded)))
              emit("uploading")
            },
          })
          inflight.delete(plan.index)
          received.add(plan.index)
          progressed()
          emit("uploading")
        } catch (err) {
          inflight.delete(plan.index)
          if (failure === null) failure = err
          return
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(parallel, pending.length) }, () => worker()))
    } finally {
      signal?.removeEventListener("abort", onAbort)
    }
    if (failure !== null) throw failure
  }

  type Step = "resume" | "init" | "sync" | "upload" | "complete"
  let step: Step = saved ? "resume" : "init"
  let restarts = 0
  let resyncs = 0

  throwIfAborted()
  emit("uploading", { force: true })

  for (;;) {
    try {
      throwIfAborted()
      if (step === "resume" && saved) {
        const status = await transport.status(saved.uploadId, signal)
        const sameFile = Number(status.size) === total
          && Number(status.chunkSize) === saved.chunkSize
          && (!status.name || String(status.name).trim() === String(file.name).trim())
        if (!sameFile) {
          forget()
          step = "init"
          continue
        }
        adopt({ uploadId: saved.uploadId, chunkSize: status.chunkSize, totalChunks: status.totalChunks }, status.received)
        resumed = received.size > 0 || Boolean(status.completed)
        progressed()
        meter.resetBaseline()
        emit("uploading", { force: true })
        step = status.completed ? "complete" : "upload"
        continue
      }
      if (step === "init" || (step === "resume" && !saved)) {
        const created = await transport.init({
          name: file.name,
          size: total,
          mimeType: file.type || "application/octet-stream",
          chunkSize: opts.chunkBytes,
          sourceChannel: opts.sourceChannel ?? null,
        }, signal)
        adopt(created)
        remember()
        progressed()
        step = "upload"
        continue
      }
      if (step === "sync") {
        const status = await transport.status(activeUploadId(), signal)
        received = new Set((status.received || []).filter((i) => Number.isInteger(i) && i >= 0 && i < plans.length))
        progressed()
        meter.resetBaseline()
        emit("uploading", { force: true })
        step = status.completed ? "complete" : "upload"
        continue
      }
      if (step === "upload") {
        await uploadPending()
        step = "complete"
        continue
      }
      // step === "complete"
      emit("completing", { force: true })
      const result = await transport.complete(activeUploadId(), signal)
      forget()
      return result
    } catch (rawErr) {
      if (isAbortLike(rawErr) || signal?.aborted) {
        // User cancel: free the server bytes (keepalive DELETE) and forget.
        await abortServerSession()
        forget()
        throw abortError()
      }
      const err = asHttpError(rawErr)
      const kind = classifyChunkFailure(err.status, err.code)
      if (kind === "transient" || (kind === "server" && serverErrors < timing.serverErrorRetries)) {
        if (kind === "server") serverErrors += 1
        if (!outage) outage = { since: now(), attempt: 0 }
        if (now() - outage.since >= timing.maxPauseMs) {
          throw new ChunkedUploadPausedError(MESSAGES.paused, err.status)
        }
        const delay = backoffMs(outage.attempt, timing, err.retryAfterMs, random)
        outage.attempt += 1
        emit("reconnecting", { force: true, retryInMs: delay })
        try {
          await wait(delay, signal)
        } catch (waitErr) {
          if (isAbortLike(waitErr) || signal?.aborted) {
            await abortServerSession()
            forget()
            throw abortError()
          }
        }
        meter.resetBaseline()
        // Chunks may have landed with their responses lost: ask before resending.
        if (step === "upload") step = "sync"
        continue
      }
      if (kind === "server") throw new ChunkedUploadPausedError(MESSAGES.server, err.status)
      if (kind === "auth") throw new ChunkedUploadPausedError(MESSAGES.auth, err.status)
      if (kind === "storage") throw new ChunkedUploadPausedError(err.message || MESSAGES.storage, err.status)
      if (kind === "completed") {
        step = "complete"
        continue
      }
      if (kind === "missing" && resyncs < 3) {
        resyncs += 1
        step = "sync"
        continue
      }
      if (kind === "gone") {
        forget()
        if (step === "resume") {
          step = "init"
          continue
        }
        if (restarts < 1 && step !== "complete") {
          // The session expired or was swept mid-upload: its bytes are gone
          // anyway, so start once more from a fresh session.
          restarts += 1
          session = null
          received = new Set()
          step = "init"
          continue
        }
        throw new ChunkedUploadHttpError(404, err.message || MESSAGES.gone, { code: err.code })
      }
      // Non-retriable 4xx (bad chunk, size mismatch, policy, …): the session
      // is unusable, so its bytes are freed on the server.
      await abortServerSession()
      forget()
      throw new ChunkedUploadHttpError(err.status, err.message || MESSAGES.missing, { code: err.code })
    }
  }
}

// ─── HTTP transport (XHR chunk PUTs with progress) ─────────────────────

export type XhrLike = {
  open(method: string, url: string, async?: boolean): void
  setRequestHeader(name: string, value: string): void
  send(body?: Document | XMLHttpRequestBodyInit | null): void
  abort(): void
  status: number
  responseText: string
  withCredentials: boolean
  timeout: number
  upload?: { onprogress: ((ev: ProgressEvent) => void) | null } | null
  onload: (() => void) | null
  onerror: (() => void) | null
  ontimeout: (() => void) | null
  onabort: (() => void) | null
  getResponseHeader(name: string): string | null
}

export type HttpChunkTransportDeps = {
  baseURL: string
  /** Authenticated fetch (bearer/CSRF/refresh), path relative to baseURL. */
  fetch: (path: string, init: RequestInit) => Promise<Response>
  /** Headers (bearer / CSRF) for a request sent outside fetch (XHR). */
  prepare: (url: string, init: RequestInit) => Promise<RequestInit>
  /** Force a fresh CSRF token after a csrf_invalid 403. */
  refreshCsrf?: () => Promise<unknown>
  createXhr?: () => XhrLike
  /** A chunk with no upload progress for this long is a stalled connection. */
  stallMs?: number
}

export function parseRetryAfterHeader(value: string | null | undefined, now: () => number = Date.now): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - now()) : null
}

function bodyFields(text: string): { error?: string; code?: string } {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; code?: unknown }
    return {
      error: typeof parsed?.error === "string" ? parsed.error : undefined,
      code: typeof parsed?.code === "string" ? parsed.code : undefined,
    }
  } catch {
    return {}
  }
}

async function responseError(res: Response, fallback: string): Promise<ChunkedUploadHttpError> {
  let fields: { error?: string; code?: string } = {}
  try { fields = bodyFields(await res.text()) } catch { /* empty body */ }
  return new ChunkedUploadHttpError(res.status, fields.error || fallback, {
    code: fields.code ?? null,
    retryAfterMs: parseRetryAfterHeader(res.headers?.get?.("Retry-After") ?? null),
  })
}

type XhrResult = { status: number; text: string; retryAfter: string | null }

function sendXhr(
  createXhr: () => XhrLike,
  url: string,
  headers: Headers,
  body: Blob,
  signal: AbortSignal,
  onLoaded: (loaded: number) => void,
  stallMs: number,
): Promise<XhrResult> {
  return new Promise<XhrResult>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    const xhr = createXhr()
    let settled = false
    let stalled = false
    let watchdog: ReturnType<typeof setTimeout> | null = null
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      if (watchdog) clearTimeout(watchdog)
      signal.removeEventListener("abort", onAbort)
      fn()
    }
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        stalled = true
        try { xhr.abort() } catch { /* already done */ }
        finish(() => reject(new ChunkedUploadHttpError(0, "La conexión se quedó detenida durante la subida.")))
      }, stallMs)
    }
    const onAbort = () => {
      try { xhr.abort() } catch { /* already done */ }
      finish(() => reject(abortError()))
    }
    xhr.open("PUT", url, true)
    headers.forEach((value, name) => xhr.setRequestHeader(name, value))
    xhr.withCredentials = true
    if (xhr.upload) {
      xhr.upload.onprogress = (ev: ProgressEvent) => {
        armWatchdog()
        if (ev && Number.isFinite(ev.loaded)) onLoaded(ev.loaded)
      }
    }
    xhr.onload = () => finish(() => resolve({ status: xhr.status, text: xhr.responseText || "", retryAfter: xhr.getResponseHeader("Retry-After") }))
    xhr.onerror = () => finish(() => reject(new ChunkedUploadHttpError(0, "Error de red durante la subida.")))
    xhr.ontimeout = () => finish(() => reject(new ChunkedUploadHttpError(0, "La subida tardó demasiado en responder.")))
    xhr.onabort = () => {
      if (stalled) return
      finish(() => reject(abortError()))
    }
    signal.addEventListener("abort", onAbort, { once: true })
    armWatchdog()
    xhr.send(body)
  })
}

export function createHttpChunkTransport<TResult>(deps: HttpChunkTransportDeps): ResumableUploadTransport<TResult> {
  const base = deps.baseURL.replace(/\/+$/, "")
  const createXhr = deps.createXhr ?? (() => new XMLHttpRequest() as unknown as XhrLike)
  const stallMs = deps.stallMs ?? 120_000
  const network = (err: unknown): never => {
    if (isAbortLike(err)) throw err
    throw new ChunkedUploadHttpError(0, "Error de red durante la subida.")
  }

  return {
    async init(input, signal) {
      const res = await deps.fetch("/files/upload/chunked/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal,
      }).catch(network)
      if (!res.ok) throw await responseError(res, `HTTP ${res.status}`)
      return await res.json() as ChunkedUploadSession
    },
    async status(uploadId, signal) {
      const res = await deps.fetch(`/files/upload/chunked/${encodeURIComponent(uploadId)}`, { method: "GET", signal }).catch(network)
      if (!res.ok) throw await responseError(res, `HTTP ${res.status}`)
      return await res.json() as ChunkedUploadStatus
    },
    async putChunk({ uploadId, index, body, signal, onLoaded }) {
      const url = `${base}/files/upload/chunked/${encodeURIComponent(uploadId)}/${index}`
      for (let attempt = 0; ; attempt += 1) {
        const prepared = await deps.prepare(url, { method: "PUT", headers: { "Content-Type": "application/octet-stream" } })
        const result = await sendXhr(createXhr, url, new Headers(prepared.headers), body, signal, onLoaded, stallMs)
        if (result.status >= 200 && result.status < 300) return
        const fields = bodyFields(result.text)
        if (attempt === 0 && result.status === 401) {
          // Let the shared transport refresh the session (single-flight) on a
          // cheap GET, then resend the chunk with the new credentials.
          const probe = await deps.fetch(`/files/upload/chunked/${encodeURIComponent(uploadId)}`, { method: "GET", signal }).catch(network)
          if (probe.ok) continue
          throw await responseError(probe, fields.error || `HTTP ${probe.status}`)
        }
        if (attempt === 0 && result.status === 403 && (fields.error === "csrf_invalid" || fields.code === "csrf_invalid") && deps.refreshCsrf) {
          await deps.refreshCsrf()
          continue
        }
        throw new ChunkedUploadHttpError(result.status, fields.error || `HTTP ${result.status}`, {
          code: fields.code ?? null,
          retryAfterMs: parseRetryAfterHeader(result.retryAfter),
        })
      }
    },
    async complete(uploadId, signal) {
      const res = await deps.fetch(`/files/upload/chunked/${encodeURIComponent(uploadId)}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal,
      }).catch(network)
      if (!res.ok) throw await responseError(res, `HTTP ${res.status}`)
      return await res.json() as TResult
    },
    async abort(uploadId) {
      // keepalive: a cancel right before the tab closes still frees the bytes.
      await deps.fetch(`/files/upload/chunked/${encodeURIComponent(uploadId)}`, { method: "DELETE", keepalive: true }).catch(() => undefined)
    },
  }
}

/**
 * lib/upload-with-progress.ts
 *
 * Lightweight XMLHttpRequest-based upload wrapper that surfaces:
 *   • Per-file (and aggregate) progress events
 *   • Cancellation via AbortSignal
 *   • A consistent { status, body } resolution shape
 *
 * `fetch()` has no upload progress events in Safari/Firefox (late-2025),
 * so XHR remains the only cross-browser path for real-time upload UI.
 *
 * Two flavours are exported:
 *   • uploadOneWithProgress(file, opts)        — single file, one XHR
 *   • uploadFilesWithProgress(files, opts)     — N files, sequential or
 *                                                parallel, aggregated progress
 *
 * The wrapper is intentionally framework-agnostic — it can be reused by
 * `apiClient.uploadFiles`, drop-zone components, and future bulk-upload UIs.
 */

export type UploadFileStatus =
  | "pending"
  | "uploading"
  | "done"
  | "failed"
  | "aborted"

export interface FileProgress {
  /** Original index in the input list */
  index: number
  /** Original File.name (already sanitized by caller if needed) */
  name: string
  /** Status of this particular file */
  status: UploadFileStatus
  /** 0–100 */
  percent: number
  /** Bytes uploaded so far */
  loaded: number
  /** Total bytes for this file */
  total: number
  /** Filled in once the upload resolves */
  response?: unknown
  /** Filled in if the upload fails */
  error?: string
}

export interface UploadAggregateProgress {
  /** Files in `done` status */
  doneCount: number
  /** Files in `failed` status */
  failedCount: number
  /** Files attempted (uploading|done|failed|aborted) */
  startedCount: number
  /** Total files in the batch */
  totalCount: number
  /** 0–100 across the whole batch (size-weighted when possible) */
  percent: number
  /** Bytes uploaded across all files */
  loaded: number
  /** Total bytes across all files */
  total: number
}

export interface UploadProgressOptions {
  url: string
  /** Field name used in the FormData (defaults to "files") */
  fieldName?: string
  /** Extra fields to append to the FormData */
  extraFields?: Record<string, string>
  /** Additional headers (Content-Type is reserved — XHR sets it) */
  headers?: Record<string, string>
  /** Cookie credentials — defaults to true (matches apiClient behaviour) */
  withCredentials?: boolean
  /** Abort the whole batch (or single upload) */
  signal?: AbortSignal
  /** Per-file callback fired on every progress tick */
  onFileProgress?: (file: FileProgress) => void
  /** Aggregate callback fired whenever any file makes progress */
  onAggregateProgress?: (agg: UploadAggregateProgress) => void
  /**
   * Concurrency cap for `uploadFilesWithProgress` (default: 3). Setting
   * to 1 yields strictly sequential uploads. Setting to `files.length`
   * fans out fully in parallel.
   */
  concurrency?: number
  /**
   * How many times to retry a file that fails for a *transient* reason
   * (network drop, timeout, or a 5xx from the server). 4xx responses and
   * user aborts are never retried. Defaults to 2 (i.e. up to 3 attempts).
   */
  maxRetries?: number
}

/**
 * A failure is transient — and therefore worth retrying — when it is a
 * network error / timeout (status 0, not a user abort) or a 5xx server
 * error. 4xx (validation, type rejected, too large, auth) is permanent.
 */
function isTransientFailure(res: UploadResult<unknown>): boolean {
  if (res.aborted) return false
  if (res.ok) return false
  if (res.status === 0) return true
  return res.status >= 500 && res.status < 600
}

/**
 * Upload a single file with bounded retries on transient failures.
 * Uses exponential backoff with jitter between attempts. Aborts short
 * circuit immediately. Each attempt re-emits progress through the caller's
 * onFileProgress so the UI reflects the retry.
 */
async function uploadOneWithRetry<T = unknown>(
  file: File,
  opts: UploadProgressOptions,
  index: number,
): Promise<UploadResult<T>> {
  const maxRetries = Math.max(0, opts.maxRetries ?? 2)
  let last: UploadResult<T> = {
    ok: false,
    status: 0,
    body: null,
    error: "Upload not attempted",
  }
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (opts.signal?.aborted) {
      return { ok: false, status: 0, body: null, aborted: true, error: "Upload aborted" }
    }
    if (attempt > 0) {
      const delay = Math.min(8000, 500 * 2 ** (attempt - 1)) * (0.5 + Math.random() * 0.5)
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((r) => setTimeout(r, delay))
      if (opts.signal?.aborted) {
        return { ok: false, status: 0, body: null, aborted: true, error: "Upload aborted" }
      }
    }
    // eslint-disable-next-line no-await-in-loop
    last = await uploadOneWithProgress<T>(file, opts, index)
    if (!isTransientFailure(last)) return last
  }
  return last
}

export interface UploadResult<T = unknown> {
  ok: boolean
  status: number
  body: T | null
  error?: string
  aborted?: boolean
}

/* ------------------------------------------------------------------ */
/* uploadOneWithProgress                                              */
/* ------------------------------------------------------------------ */

export function uploadOneWithProgress<T = unknown>(
  file: File,
  opts: UploadProgressOptions,
  /** Index — used so callers can correlate progress with their list */
  index = 0,
): Promise<UploadResult<T>> {
  return new Promise<UploadResult<T>>((resolve) => {
    if (typeof XMLHttpRequest === "undefined") {
      resolve({
        ok: false,
        status: 0,
        body: null,
        error: "XMLHttpRequest is not available in this environment",
      })
      return
    }

    const xhr = new XMLHttpRequest()
    const fieldName = opts.fieldName ?? "files"
    const fd = new FormData()
    fd.append(fieldName, file, file.name)
    if (opts.extraFields) {
      for (const [k, v] of Object.entries(opts.extraFields)) {
        fd.append(k, v)
      }
    }

    let resolved = false
    const finish = (result: UploadResult<T>) => {
      if (resolved) return
      resolved = true
      try { opts.signal?.removeEventListener("abort", onAbort) } catch { /* noop */ }
      resolve(result)
    }

    const total = file.size || 0
    const fileState: FileProgress = {
      index,
      name: file.name,
      status: "pending",
      percent: 0,
      loaded: 0,
      total,
    }

    const emit = (patch: Partial<FileProgress>) => {
      Object.assign(fileState, patch)
      try { opts.onFileProgress?.({ ...fileState }) } catch { /* noop */ }
    }

    try {
      xhr.open("POST", opts.url, true)
    } catch (err) {
      finish({
        ok: false,
        status: 0,
        body: null,
        error: err instanceof Error ? err.message : "Failed to open XHR",
      })
      return
    }

    if (opts.withCredentials !== false) xhr.withCredentials = true
    if (opts.headers) {
      for (const [k, v] of Object.entries(opts.headers)) {
        // Browsers forbid setting Content-Type for multipart — skip it.
        if (k.toLowerCase() === "content-type") continue
        try { xhr.setRequestHeader(k, v) } catch { /* unsafe header — ignore */ }
      }
    }

    if (xhr.upload) {
      xhr.upload.onprogress = (ev) => {
        if (!ev.lengthComputable) return
        const pct = ev.total > 0 ? Math.round((ev.loaded / ev.total) * 100) : 0
        emit({
          status: "uploading",
          percent: Math.min(99, pct),
          loaded: ev.loaded,
          total: ev.total,
        })
      }
      xhr.upload.onloadstart = () => emit({ status: "uploading" })
    }

    xhr.onload = () => {
      const ok = xhr.status >= 200 && xhr.status < 300
      let body: T | null = null
      let parseErr: string | undefined
      const raw = xhr.responseText
      if (raw) {
        try {
          body = JSON.parse(raw) as T
        } catch {
          // Non-JSON response — surface the raw text via cast.
          body = raw as unknown as T
          if (!ok) parseErr = raw.slice(0, 200)
        }
      }
      const error = ok
        ? undefined
        : (body && typeof body === "object" && (body as any).error) ||
          parseErr ||
          `HTTP ${xhr.status}`
      emit({
        status: ok ? "done" : "failed",
        percent: 100,
        loaded: total,
        total,
        response: ok ? body ?? undefined : undefined,
        error: ok ? undefined : String(error),
      })
      finish({ ok, status: xhr.status, body, error: ok ? undefined : String(error) })
    }

    xhr.onerror = () => {
      emit({ status: "failed", error: "Network error during upload" })
      finish({ ok: false, status: 0, body: null, error: "Network error during upload" })
    }
    xhr.ontimeout = () => {
      emit({ status: "failed", error: "Upload timed out" })
      finish({ ok: false, status: 0, body: null, error: "Upload timed out" })
    }
    xhr.onabort = () => {
      emit({ status: "aborted", error: "Upload aborted" })
      finish({ ok: false, status: 0, body: null, aborted: true, error: "Upload aborted" })
    }

    const onAbort = () => {
      try { xhr.abort() } catch { /* noop */ }
    }
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort()
        return
      }
      opts.signal.addEventListener("abort", onAbort, { once: true })
    }

    try {
      xhr.send(fd)
    } catch (err) {
      finish({
        ok: false,
        status: 0,
        body: null,
        error: err instanceof Error ? err.message : "Failed to send XHR",
      })
    }
  })
}

/* ------------------------------------------------------------------ */
/* uploadFilesWithProgress                                            */
/* ------------------------------------------------------------------ */

/**
 * Upload an array of files, emitting per-file and aggregate progress.
 * Files are uploaded one-XHR-each (so we get a real progress signal
 * per file even when the backend accepts a single multipart batch).
 *
 * If the backend exposes a single multipart endpoint that accepts many
 * files at once and the caller doesn't need per-file progress fidelity,
 * use `apiClient.uploadFiles` instead.
 */
export async function uploadFilesWithProgress<T = unknown>(
  files: File[],
  opts: UploadProgressOptions,
): Promise<Array<UploadResult<T>>> {
  const total = files.length
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, total || 1))
  const results: Array<UploadResult<T>> = new Array(total)

  // Track per-file state for aggregation
  const states: FileProgress[] = files.map((f, i) => ({
    index: i,
    name: f.name,
    status: "pending",
    percent: 0,
    loaded: 0,
    total: f.size || 0,
  }))
  const totalBytes = states.reduce((acc, s) => acc + (s.total || 0), 0)

  const emitAggregate = () => {
    if (!opts.onAggregateProgress) return
    let loaded = 0
    let doneCount = 0
    let failedCount = 0
    let startedCount = 0
    for (const s of states) {
      loaded += s.loaded
      if (s.status === "done") doneCount++
      else if (s.status === "failed" || s.status === "aborted") failedCount++
      if (s.status !== "pending") startedCount++
    }
    const percent =
      totalBytes > 0
        ? Math.round((loaded / totalBytes) * 100)
        : total > 0
          ? Math.round((doneCount / total) * 100)
          : 0
    try {
      opts.onAggregateProgress({
        doneCount,
        failedCount,
        startedCount,
        totalCount: total,
        percent: Math.min(100, percent),
        loaded,
        total: totalBytes,
      })
    } catch {
      /* noop */
    }
  }

  // Wrap the per-file progress emitter so we can update aggregate state.
  const wrappedOnFileProgress = (fp: FileProgress) => {
    states[fp.index] = fp
    try { opts.onFileProgress?.(fp) } catch { /* noop */ }
    emitAggregate()
  }

  let cursor = 0
  const workers: Array<Promise<void>> = []
  const launch = async () => {
    while (true) {
      const i = cursor++
      if (i >= total) break
      if (opts.signal?.aborted) {
        results[i] = {
          ok: false,
          status: 0,
          body: null,
          aborted: true,
          error: "Upload aborted",
        }
        states[i] = { ...states[i], status: "aborted" }
        wrappedOnFileProgress(states[i])
        continue
      }
      // eslint-disable-next-line no-await-in-loop
      const res = await uploadOneWithRetry<T>(
        files[i],
        { ...opts, onFileProgress: wrappedOnFileProgress },
        i,
      )
      results[i] = res
    }
  }

  for (let w = 0; w < concurrency; w++) workers.push(launch())
  await Promise.all(workers)
  emitAggregate()
  return results
}

/* ------------------------------------------------------------------ */
/* Filename sanitization                                              */
/* ------------------------------------------------------------------ */

/**
 * Strip path traversal characters and control bytes from a filename
 * before sending it to the server. Keeps unicode (CJK, emoji) intact
 * so the user's original filename is recognisable.
 */
export function sanitizeFilename(name: string): string {
  if (!name) return "file"
  // Take the last segment (defends against path-style names like "../etc/passwd")
  const lastSlash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"))
  let cleaned = lastSlash >= 0 ? name.slice(lastSlash + 1) : name
  // Drop traversal markers and control chars (0x00–0x1F, 0x7F)
  // eslint-disable-next-line no-control-regex
  const controlChars = new RegExp("[\\x00-\\x1F\\x7F]", "g")
  cleaned = cleaned
    .replace(controlChars, "")
    .replace(/\.\.+/g, ".") // collapse ".." → "."
    .replace(/[<>:"|?*]/g, "_") // illegal on Windows
    .trim()
  if (!cleaned || cleaned === "." || cleaned === "..") return "file"
  // Cap at 255 bytes (most filesystems' NAME_MAX)
  if (cleaned.length > 255) cleaned = cleaned.slice(0, 255)
  return cleaned
}

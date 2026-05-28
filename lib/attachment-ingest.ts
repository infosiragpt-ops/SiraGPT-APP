/**
 * Multimodal-ingestion utility — single entry point for every way the
 * user can hand a file to the chat bar.
 *
 * Sources covered (the canonical browser-supported channels):
 *   • file picker            (input[type=file])
 *   • drag-and-drop          (DataTransfer.files / DataTransfer.items)
 *   • clipboard paste        (ClipboardEvent.clipboardData — files,
 *                             screenshot blobs, mixed text+files)
 *   • mobile share-sheet     (the OS hands a File via the picker)
 *   • camera capture         (input capture=user — also a File)
 *
 * Three exports the composer wires up:
 *   extractFilesFromDataTransfer(dt)  — drop / drag handlers
 *   extractFilesFromClipboard(cb)     — onPaste / global clipboard
 *   validateFile(file, opts)          — per-file allowlist + size gate
 *
 * The composer itself owns upload + chip-rendering + state — this
 * utility is pure data extraction so it can be unit-tested in isolation
 * and reused from any other surface (settings → bulk import, GPT
 * builder → knowledge files, etc.).
 */

// ─── Allowlist (mirror of backend/src/middleware/upload.js) ──────────
// Keep these two sources in sync — every type listed here must be
// accepted by the backend, otherwise the user sees an upload error
// after the chip has already rendered (bad UX).
const ALLOWED_MIMES = new Set<string>([
  // Images
  "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp",
  "image/bmp", "image/tiff", "image/svg+xml",
  "image/heic", "image/heif",
  // Documents
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "text/plain", "text/csv", "text/tab-separated-values", "text/markdown",
  "text/html", "text/xml", "application/xml",
  "application/json",
  "application/rtf", "text/rtf",
  "message/rfc822",
  "application/vnd.ms-outlook",
])

const ALLOWED_EXTENSIONS = new Set<string>([
  // Images
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff",
  "svg", "heic", "heif",
  // Office / OpenDocument
  "pdf", "doc", "docx", "xlsx", "ppt", "pptx",
  "odt", "ods", "odp",
  // Text
  "txt", "md", "markdown", "csv", "tsv", "rtf",
  // Web/structured
  "html", "htm", "json", "xml",
  // Email
  "eml", "msg",
])

// No client-side size cap — the product accepts arbitrarily large
// uploads. Real-world ceilings (browser memory while reading the
// blob, server disk space, OpenAI Files API at 512 MB) still apply
// downstream and surface their own errors when they bite, but the
// composer no longer pre-rejects on size.
const DEFAULT_MAX_BYTES = Number.POSITIVE_INFINITY
const DEFAULT_MAX_COUNT = 10                // matches backend `files: 10`

export type IngestSource =
  | "picker"            // input[type=file]
  | "drop"              // drag from desktop / external app
  | "drop-internal"     // drag inside the browser (image dragged out of a tab)
  | "paste-files"       // OS-clipboard files (Cmd+C in Finder → Cmd+V here)
  | "paste-image"       // screenshot or copied image (Cmd+Shift+4 → Cmd+V)
  | "paste-long-text"   // long pasted text compiled into a text document chip
  | "mobile-share"      // share-sheet → opened via picker
  | "camera"            // input capture
  | "unknown"

export interface IngestValidation {
  ok: boolean
  /** Localized, user-facing reason if !ok. */
  reason?: string
  /** Programmatic error code for telemetry. */
  code?: "type_not_allowed" | "size_exceeded" | "empty_file" | "count_exceeded" | "office_temp_lock_file"
}

export interface IngestResult {
  /** Files ready to upload (already validated against allowlist + size). */
  files: File[]
  /** Files that were rejected with the reason — caller surfaces a toast. */
  rejected: Array<{ file: File; reason: string; code: string }>
  /** Plain text extracted from the clipboard alongside files (if any).
   *  The composer should append this to the input, not into a chip. */
  text: string | null
  /** Sanitized HTML — only present when caller opts in via includeHtml. */
  html: string | null
  /** Source channel for telemetry. */
  source: IngestSource
}

// ─── Helpers ─────────────────────────────────────────────────────────

function extOf(file: File): string {
  const i = file.name.lastIndexOf(".")
  if (i < 0) return ""
  return file.name.slice(i + 1).toLowerCase()
}

const OFFICE_LOCK_EXTENSIONS = new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx"])

function isOfficeTemporaryLockFile(file: File): boolean {
  const name = (file.name || "").trim()
  return name.startsWith("~$") && OFFICE_LOCK_EXTENSIONS.has(extOf(file))
}

/**
 * Per-file allowlist + size validation. Pure function — caller decides
 * what to do with rejections (toast, persistent banner, etc.).
 */
export function validateFile(
  file: File,
  opts: { maxBytes?: number } = {}
): IngestValidation {
  const max = opts.maxBytes ?? DEFAULT_MAX_BYTES
  if (!file || file.size === 0) {
    return { ok: false, reason: "El archivo está vacío", code: "empty_file" }
  }
  if (isOfficeTemporaryLockFile(file)) {
    return {
      ok: false,
      reason: 'Ese archivo es temporal de Microsoft Office (empieza con "~$"). Cierra Word/Excel/PowerPoint y sube el documento original.',
      code: "office_temp_lock_file",
    }
  }
  // The default cap is Infinity, so this branch only fires when a
  // caller explicitly opts into a size limit (none do today). Kept
  // for callers that may want a per-surface ceiling later.
  if (Number.isFinite(max) && file.size > max) {
    const mb = Math.round(max / (1024 * 1024))
    return {
      ok: false,
      reason: `El archivo supera el máximo de ${mb} MB`,
      code: "size_exceeded",
    }
  }
  const mime = (file.type || "").toLowerCase()
  const ext = extOf(file)
  if (!ALLOWED_MIMES.has(mime) && !ALLOWED_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      reason: `Tipo no permitido: ${mime || ext || "desconocido"}`,
      code: "type_not_allowed",
    }
  }
  return { ok: true }
}

/**
 * Convert an arbitrary Blob into a File with a sensible name. Used for
 * clipboard image paste (Cmd+Shift+4 → Cmd+V) where the blob has no
 * filename — without a name the upload would fail extension validation.
 */
export function blobToFile(blob: Blob, hint?: string): File {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const ext = guessExtFromMime(blob.type) || "bin"
  const name = hint || `pasted-${ts}.${ext}`
  return new File([blob], name, { type: blob.type || "application/octet-stream" })
}

function guessExtFromMime(mime: string): string | null {
  if (!mime) return null
  const m = mime.toLowerCase()
  if (m === "image/png") return "png"
  if (m === "image/jpeg" || m === "image/jpg") return "jpg"
  if (m === "image/gif") return "gif"
  if (m === "image/webp") return "webp"
  if (m === "image/bmp") return "bmp"
  if (m === "image/tiff") return "tif"
  if (m === "image/svg+xml") return "svg"
  if (m === "image/heic") return "heic"
  if (m === "image/heif") return "heif"
  if (m === "application/pdf") return "pdf"
  if (m === "text/plain") return "txt"
  if (m === "text/markdown") return "md"
  if (m === "text/csv") return "csv"
  if (m === "text/tab-separated-values") return "tsv"
  if (m === "text/html") return "html"
  if (m === "application/json") return "json"
  if (m === "application/xml" || m === "text/xml") return "xml"
  return null
}

/**
 * Extract files from a DataTransfer (drag & drop / paste). Reads BOTH
 * `.files` and `.items` — older Edge and some Linux Firefox builds only
 * expose dragged files via `.items[i].getAsFile()`, while macOS Safari
 * sometimes only exposes them on `.files`. Belt-and-suspenders.
 */
export function extractFilesFromDataTransfer(
  dt: DataTransfer | null
): File[] {
  if (!dt) return []
  const out: File[] = []
  const seen = new Set<string>()

  // Path 1: .files (most reliable when present)
  if (dt.files && dt.files.length) {
    for (const f of Array.from(dt.files)) {
      const key = `${f.name}:${f.size}:${f.lastModified}`
      if (!seen.has(key)) { seen.add(key); out.push(f) }
    }
  }

  // Path 2: .items — picks up files that browsers expose only here.
  // `.kind === "file"` filter is critical: items also include text/html
  // and other kinds we handle separately.
  if (dt.items && dt.items.length) {
    for (const item of Array.from(dt.items)) {
      if (item.kind !== "file") continue
      const f = item.getAsFile()
      if (!f) continue
      const key = `${f.name}:${f.size}:${f.lastModified}`
      if (!seen.has(key)) { seen.add(key); out.push(f) }
    }
  }
  return out
}

/**
 * Extract everything useful from a paste event:
 *   - files (OS-clipboard files, screenshot blobs)
 *   - plain text (default behavior — caller decides whether to insert)
 *   - sanitized HTML (opt-in; off by default to avoid injection risk)
 *
 * Screenshots arrive as image blobs WITHOUT a filename — we synthesize
 * one in `blobToFile` so the backend's extension check accepts them.
 */
export function extractFromClipboardEvent(
  e: ClipboardEvent,
  opts: { includeHtml?: boolean } = {}
): { files: File[]; text: string | null; html: string | null } {
  const cd = e.clipboardData
  if (!cd) return { files: [], text: null, html: null }

  const files: File[] = []
  const seen = new Set<string>()

  // 1) Real files — DataTransferItemList lets us get image blobs that
  //    don't appear in `.files` (Chrome paste of a copied screenshot is
  //    a famous case).
  if (cd.items && cd.items.length) {
    for (const item of Array.from(cd.items)) {
      if (item.kind !== "file") continue
      const blob = item.getAsFile()
      if (!blob) continue
      // Synthesize a filename for nameless blobs (clipboard screenshots).
      const f = blob.name
        ? blob
        : blobToFile(blob, `pasted.${guessExtFromMime(blob.type) || "bin"}`)
      const key = `${f.name}:${f.size}:${f.lastModified}`
      if (!seen.has(key)) { seen.add(key); files.push(f) }
    }
  }

  // 2) Backstop: cd.files (some browsers don't populate items for files)
  if (cd.files && cd.files.length) {
    for (const f of Array.from(cd.files)) {
      const key = `${f.name}:${f.size}:${f.lastModified}`
      if (!seen.has(key)) { seen.add(key); files.push(f) }
    }
  }

  const text = cd.getData("text/plain") || null
  const rawHtml = opts.includeHtml ? cd.getData("text/html") : ""
  const html = rawHtml ? sanitizeHtml(rawHtml) : null

  return { files, text, html }
}

/**
 * Minimal HTML sanitizer for pasted clipboard HTML. Strips scripts,
 * event handlers, javascript: URLs, and style attributes — keeps tag
 * structure (tables, lists, links, basic formatting) so Word/Excel/
 * Google Docs paste preserves layout.
 *
 * For full XSS protection on a server-rendered surface, run the result
 * through DOMPurify or sanitize-html. This client-side pass is enough
 * for the controlled context of "render in our own composer" because
 * we never inject the HTML directly into the message DOM — we only
 * extract structured text from it.
 */
export function sanitizeHtml(input: string): string {
  if (!input) return ""
  return input
    // Strip <script> tags entirely.
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    // Strip <style> tags (would inject CSS into the host page).
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    // Strip inline event handlers (onclick=, onerror=, etc.).
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    // Strip javascript: URLs.
    .replace(/(href|src)\s*=\s*"javascript:[^"]*"/gi, '$1="#"')
    .replace(/(href|src)\s*=\s*'javascript:[^']*'/gi, "$1='#'")
    // Strip style attributes (avoids ::before { content: url(…) } tricks).
    .replace(/\sstyle\s*=\s*"[^"]*"/gi, "")
    .replace(/\sstyle\s*=\s*'[^']*'/gi, "")
}

/**
 * Run a list of files through validation, splitting into accepted vs
 * rejected. Caller can present the rejected ones in a single toast
 * batch instead of per-file noise.
 */
export function validateBatch(
  files: File[],
  opts: { maxBytes?: number; maxCount?: number; existingCount?: number } = {}
): { accepted: File[]; rejected: Array<{ file: File; reason: string; code: string }> } {
  const accepted: File[] = []
  const rejected: Array<{ file: File; reason: string; code: string }> = []
  const maxCount = opts.maxCount ?? DEFAULT_MAX_COUNT
  const existing = opts.existingCount ?? 0

  for (const f of files) {
    if (accepted.length + existing >= maxCount) {
      rejected.push({
        file: f,
        reason: `Máximo ${maxCount} archivos por mensaje`,
        code: "count_exceeded",
      })
      continue
    }
    const v = validateFile(f, opts)
    if (v.ok) accepted.push(f)
    else rejected.push({ file: f, reason: v.reason!, code: v.code! })
  }
  return { accepted, rejected }
}

/**
 * Telemetry helper — single entry point so wiring an observability
 * backend (PostHog, Segment, etc.) means changing one function instead
 * of every call site.
 */
export function logIngest(event: {
  source: IngestSource
  count: number
  total_bytes: number
  rejected_count?: number
  rejected_codes?: string[]
  /** When the user pasted both text and files together. */
  had_text?: boolean
  user_agent?: string
}): void {
  if (typeof window === "undefined") return
  if (process.env.NODE_ENV === "production") {
    // Hook to real analytics here.
    return
  }
  // eslint-disable-next-line no-console
  console.log("[attachment_ingest]", {
    ...event,
    user_agent: event.user_agent ?? navigator.userAgent.slice(0, 60),
  })
}

/**
 * Convert a File[] into a synthetic FileList — needed because
 * `apiClient.uploadFiles` expects a FileList (browser-native shape).
 *
 * Uses DataTransfer constructor under the hood; falls back to a
 * minimal FileList polyfill on browsers that disallow it (older iOS).
 */
export function filesToFileList(files: File[]): FileList {
  if (typeof DataTransfer !== "undefined") {
    try {
      const dt = new DataTransfer()
      files.forEach(f => dt.items.add(f))
      return dt.files
    } catch {
      /* fall through to the polyfill */
    }
  }
  // Polyfill: an array with a `.item()` method satisfies the structural
  // type that consumers rely on. Not a *real* FileList but matches the
  // surface area `Array.from(filelist)` uses.
  const list: any = files.slice()
  list.item = (i: number) => list[i] ?? null
  return list as FileList
}

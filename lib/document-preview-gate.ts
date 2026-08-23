/**
 * Document preview readiness gate.
 *
 * The composer chip's combined bar is dual-phase (HTTP upload 0–50, then
 * server RAG processing 50–100). ~80% is typically extracting/chunking
 * AFTER the server already has a stable file.id. Preview must:
 *   - stay closed while HTTP upload is still in flight (temp id only)
 *   - allow the original bytes once the object is persisted, even if
 *     RAG is still indexing
 *   - show a professional skeleton while LibreOffice converts to PDF
 */

export type PreviewGatePhase = "uploading" | "indexing" | "converting" | "ready" | "failed"

export interface PreviewGateInput {
  id?: string | null
  url?: string | null
  status?: string | null
  uploadProgress?: number | null
  processingStage?: string | null
  file?: unknown
}

export interface PreviewGate {
  /** True when the right pane may render original bytes / start conversion. */
  ready: boolean
  phase: PreviewGatePhase
  progress: number
  label: string
}

const TEMP_ID_RE = /^temp(?:[-_]|$)/i
const LOCAL_ONLY_URL_RE = /^(?:blob:|data:)/i
const INDEXING_STAGES = new Set([
  "uploaded",
  "validating",
  "extracting",
  "chunking",
  "embedding",
  "indexing",
  "processing",
])

export const CONVERSION_LOADING_LABEL = "Generando vista previa…"
export const INDEXING_STATUS_LABEL = "Subido · preparando índice…"
export const UPLOAD_STATUS_LABEL = "Subiendo…"
export const PREVIEW_LOADING_LABEL = CONVERSION_LOADING_LABEL

export function clampPreviewProgress(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, n))
}

export function isStableServerFileId(id?: string | null): boolean {
  const value = String(id || "").trim()
  if (!value) return false
  return !TEMP_ID_RE.test(value)
}

export function hasServerBackedPreviewUrl(url?: string | null): boolean {
  const value = String(url || "").trim()
  if (!value) return false
  return !LOCAL_ONLY_URL_RE.test(value)
}

export function isRetryablePreviewHttpStatus(status: number): boolean {
  return status === 409 || status === 425 || status === 423
}

export function isRetryablePreviewError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const candidate = error as { retryable?: unknown; message?: unknown }
  if (candidate.retryable === true) return true
  const message = String(candidate.message || "")
  return /preview-object-not-ready|not-ready|http-409|http-425|http-423/i.test(message)
}

/**
 * Chip click / openComposerDocumentPreview gate.
 * HTTP upload must be finished (stable file.id). RAG indexing does not block.
 */
export function canOpenComposerPreview(input: PreviewGateInput = {}): boolean {
  const status = String(input.status || "").toLowerCase()
  if (status === "failed" || status === "uploading") return false
  return isStableServerFileId(input.id) || hasServerBackedPreviewUrl(input.url)
}

export function isPreviewObjectReady(input: PreviewGateInput): boolean {
  return resolvePreviewGate(input).ready
}

export function resolvePreviewGate(input: PreviewGateInput = {}): PreviewGate {
  const status = String(input.status || "").toLowerCase()
  const stage = String(input.processingStage || "").toLowerCase()
  const progress = clampPreviewProgress(input.uploadProgress)
  const stableId = isStableServerFileId(input.id)
  const serverUrl = hasServerBackedPreviewUrl(input.url)
  const persisted = stableId || serverUrl

  if (status === "failed") {
    return {
      ready: false,
      phase: "failed",
      progress,
      label: "No se pudo subir el documento",
    }
  }

  const uploadInFlight = status === "uploading" || (!persisted && status !== "ready")

  if (uploadInFlight) {
    const shown = progress > 0 ? Math.min(99, Math.round(progress)) : 1
    return {
      ready: false,
      phase: "uploading",
      progress: shown,
      label: UPLOAD_STATUS_LABEL,
    }
  }

  if (status === "processing" || INDEXING_STAGES.has(stage)) {
    return {
      ready: true,
      phase: "indexing",
      progress: 100,
      label: INDEXING_STATUS_LABEL,
    }
  }

  return {
    ready: true,
    phase: "ready",
    progress: 100,
    label: "",
  }
}

/**
 * Document preview readiness gate.
 *
 * The composer can open the right-pane viewer while bytes are still
 * leaving the browser. Rendering from the in-memory File in that window
 * produces a "finished" PDF-style page (docx-preview / mammoth) while
 * the chip is still at 80–90%. This module is the single decision for
 * "show professional loading" vs "the server has the full object".
 */

export type PreviewGatePhase = "uploading" | "converting" | "ready" | "failed"

export interface PreviewGateInput {
  id?: string | null
  url?: string | null
  status?: string | null
  uploadProgress?: number | null
  file?: unknown
}

export interface PreviewGate {
  ready: boolean
  phase: PreviewGatePhase
  progress: number
  label: string
}

const TEMP_ID_RE = /^temp(?:[-_]|$)/i
const LOCAL_ONLY_URL_RE = /^(?:blob:|data:)/i

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
 * True once the HTTP upload finished AND the server persisted a real
 * file row (stable id and/or /uploads URL). Local File blobs do not
 * count — they exist before the server has the object.
 */
export function isPreviewObjectReady(input: PreviewGateInput): boolean {
  return resolvePreviewGate(input).ready
}

export function resolvePreviewGate(input: PreviewGateInput = {}): PreviewGate {
  const status = String(input.status || "").toLowerCase()
  const progress = clampPreviewProgress(input.uploadProgress)
  const stableId = isStableServerFileId(input.id)
  const serverUrl = hasServerBackedPreviewUrl(input.url)

  if (status === "failed") {
    return {
      ready: false,
      phase: "failed",
      progress,
      label: "No se pudo subir el documento",
    }
  }

  const uploadInFlight =
    status === "uploading" ||
    (!stableId && !serverUrl && (status === "" || progress < 100))

  if (uploadInFlight) {
    const shown = progress > 0 ? Math.min(99, progress) : 1
    return {
      ready: false,
      phase: "uploading",
      progress: shown,
      label: "Preparando vista previa…",
    }
  }

  if (!stableId && !serverUrl) {
    return {
      ready: false,
      phase: "uploading",
      progress: progress > 0 ? Math.min(99, progress) : 1,
      label: "Preparando vista previa…",
    }
  }

  if (status === "processing") {
    return {
      ready: true,
      phase: "converting",
      progress: Math.max(progress, 100),
      label: "Preparando vista previa…",
    }
  }

  return {
    ready: true,
    phase: "ready",
    progress: 100,
    label: "",
  }
}

export const PREVIEW_LOADING_LABEL = "Preparando vista previa…"

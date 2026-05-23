/**
 * file-processing-vocab — pure-function vocabulary for the per-File
 * processing state machine. Lives outside the React tree on purpose:
 * the hook (`useFileProcessingStatus`), the badge component, and any
 * future surface (admin panel, message bubble, audit viewer) all
 * read these labels so the UI stays consistent and the strings are
 * unit-testable without spinning up React.
 *
 * Source of truth for the state machine itself is
 * `docs/architecture/STATE_MACHINE.md`. When you add a stage there,
 * add it here too — the type + the describeStage switch are
 * intentionally exhaustive so TypeScript flags missing branches.
 */

export type FileProcessingStage =
  | "uploaded"
  | "validating"
  | "extracting"
  | "chunking"
  | "embedding"
  | "indexing"
  | "ready"
  | "failed"

/**
 * Stages from which the pipeline never leaves. Consumers (the polling
 * hook, the badge, etc.) stop polling and unhook listeners once the
 * stage hits one of these.
 */
export const TERMINAL_STAGES: ReadonlySet<FileProcessingStage> = new Set(["ready", "failed"])

export function isTerminalStage(stage: FileProcessingStage | null | undefined): boolean {
  if (!stage) return false
  return TERMINAL_STAGES.has(stage)
}

/**
 * Returns `true` only on a real non-ready → ready edge — the moment
 * worth surfacing a "Documento listo" toast. Carefully NOT firing on:
 *   - the initial poll (`prev` is null) when the row was already
 *     `ready` before the consumer mounted (legacy / already-indexed
 *     file would otherwise flash a misleading toast)
 *   - back-to-back ready states from re-renders
 *   - any other stage on either side
 *
 * Used by `FileProcessingBadge`'s onReady plumbing — extracted into
 * the vocab so the rule can be unit-tested without React.
 */
export function shouldFireReadyTransition(
  previous: FileProcessingStage | null | undefined,
  current: FileProcessingStage | null | undefined,
): boolean {
  if (current !== "ready") return false
  if (!previous) return false
  if (previous === "ready") return false
  return true
}

/**
 * Map the stage-prefixed `processingError` reasons we write in the
 * backend (see STATE_MACHINE.md §7) to short, user-facing Spanish
 * labels. Non-technical users shouldn't have to read "processing:
 * ENOENT: no such file" to know what went wrong; support staff
 * still get the raw reason via the badge tooltip.
 */
export function friendlyFailureLabel(error: string | null | undefined): string {
  const raw = (error || "").trim()
  if (!raw) return "Error de procesamiento"
  if (/^magic_byte_mismatch/i.test(raw)) return "Tipo de archivo no permitido"
  if (/^processing/i.test(raw)) return "No se pudo procesar el documento"
  if (/^rag_indexing/i.test(raw)) return "Error al indexar el documento"
  if (/^db_create_failed/i.test(raw)) return "No se pudo registrar el archivo"
  // Anything else: keep the raw reason. It's already short by
  // construction (1000-char ceiling) and may carry the real signal
  // the user needs (e.g. an OCR "Out of memory" message verbatim).
  return raw
}

export type StageTone = "neutral" | "progress" | "success" | "error"

export interface StageDescription {
  label: string
  tone: StageTone
}

/**
 * Localised label + tone for a stage. Centralised here so every
 * surface that reads stage data — chip in composer, chip in sent
 * message, future admin panel — shares one Spanish vocabulary.
 */
export function describeStage(
  stage: FileProcessingStage | null,
  error?: string | null,
): StageDescription {
  if (!stage) return { label: "Pendiente", tone: "neutral" }
  switch (stage) {
    case "uploaded":
      return { label: "Subido", tone: "progress" }
    case "validating":
      return { label: "Validando", tone: "progress" }
    case "extracting":
      return { label: "Extrayendo texto", tone: "progress" }
    case "chunking":
      return { label: "Fragmentando", tone: "progress" }
    case "embedding":
      return { label: "Indexando", tone: "progress" }
    case "indexing":
      return { label: "Indexando", tone: "progress" }
    case "ready":
      return { label: "Listo", tone: "success" }
    case "failed":
      return { label: friendlyFailureLabel(error), tone: "error" }
    default:
      // Compile-time exhaustiveness: TypeScript flags a missing
      // branch above. Runtime fallback is a defensive label so a
      // future stage added by the backend doesn't crash old clients.
      return { label: String(stage), tone: "neutral" }
  }
}

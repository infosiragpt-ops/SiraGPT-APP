import { isActiveProcessingStage, type FileProcessingStage } from "../file-processing-vocab"
import { getLongPasteMetadata, type LongPasteMetadata } from "../long-paste"

type ComposerFileRecord = {
  id?: unknown
  fileId?: unknown
  attachmentId?: unknown
  file?: unknown
  url?: unknown
  extractedText?: unknown
  status?: unknown
  processingStage?: unknown
  stage?: unknown
  name?: unknown
  originalName?: unknown
  filename?: unknown
  mimeType?: unknown
  type?: unknown
  contentType?: unknown
  size?: unknown
  openaiFileId?: unknown
  sourceChannel?: unknown
  isLongPasteDocument?: unknown
  longPasteTitle?: unknown
  longPastePreview?: unknown
}

export type AgentFileMetadata = {
  id: string
  name: string
  originalName: string
  filename: string
  mimeType: unknown
  type: unknown
  size: unknown
  url: unknown
  openaiFileId: unknown
  sourceChannel: unknown
  isLongPasteDocument: boolean
  longPasteTitle: string | null
  longPastePreview: string | null
  longPasteMeta: SafeLongPasteMetadata | null
}

export type SafeLongPasteMetadata = Pick<
  LongPasteMetadata,
  | "kind"
  | "title"
  | "filename"
  | "preview"
  | "originalCharCount"
  | "originalWordCount"
  | "originalLineCount"
  | "createdAt"
> & { text?: never }

function asComposerFile(file: unknown): ComposerFileRecord | null {
  return file && typeof file === "object" ? file as ComposerFileRecord : null
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return normalized || null
}

export function resolveUploadFileId(file: unknown): string | null {
  if (typeof file === "string") return optionalString(file)
  const candidate = asComposerFile(file)
  if (!candidate) return null
  return optionalString(candidate.id)
    || optionalString(candidate.fileId)
    || optionalString(candidate.attachmentId)
}

export function collectUploadFileIds(files: readonly unknown[] = []): string[] {
  return files.map(resolveUploadFileId).filter((id): id is string => Boolean(id))
}

export function attachmentHasPreviewSource(attachment: unknown): boolean {
  const candidate = asComposerFile(attachment)
  return Boolean(candidate?.file || candidate?.url || candidate?.extractedText)
}

export function previewAttachmentKey(attachment: unknown): string {
  const candidate = asComposerFile(attachment)
  return String(candidate?.id || candidate?.url || candidate?.name || "")
}

export function isComposerFileUploadPending(file: unknown): boolean {
  const candidate = asComposerFile(file)
  return Boolean(candidate && candidate.status === "uploading" && !resolveUploadFileId(candidate))
}

const PROCESSING_CONTEXT_EXT_RE = /\.(?:pdf|docx?|xlsx?|csv|pptx?|txt|md|markdown|rtf|odt|ods|odp)$/i
const PROCESSING_CONTEXT_MIME_RE =
  /(?:application\/(?:pdf|msword|vnd\.openxmlformats-officedocument|vnd\.ms-|vnd\.oasis\.opendocument|rtf)|text\/(?:plain|markdown|csv|tab-separated-values|html|xml)|application\/(?:json|xml))/i

export function shouldWaitForDocumentProcessing(file: unknown): boolean {
  const candidate = asComposerFile(file)
  if (!candidate || !resolveUploadFileId(candidate)) return false
  const name = String(candidate.name || candidate.originalName || candidate.filename || "")
  const mime = String(candidate.mimeType || candidate.type || candidate.contentType || "")
  return PROCESSING_CONTEXT_EXT_RE.test(name) || PROCESSING_CONTEXT_MIME_RE.test(mime)
}

export function getFileProcessingStage(file: unknown): FileProcessingStage | null {
  const candidate = asComposerFile(file)
  const stage = candidate?.processingStage || candidate?.stage || null
  return typeof stage === "string" ? stage as FileProcessingStage : null
}

export function isComposerFileProcessingPending(file: unknown): boolean {
  return shouldWaitForDocumentProcessing(file) && isActiveProcessingStage(getFileProcessingStage(file))
}

export function isComposerFileUploadFailed(file: unknown): boolean {
  const candidate = asComposerFile(file)
  return Boolean(candidate && (candidate.status === "failed" || getFileProcessingStage(candidate) === "failed"))
}

export function sanitizeLongPasteMetaForMessage(meta: LongPasteMetadata | null): SafeLongPasteMetadata | null {
  if (!meta || meta.kind !== "long_paste_document") return null
  return {
    kind: "long_paste_document",
    title: meta.title,
    filename: meta.filename,
    preview: meta.preview,
    originalCharCount: meta.originalCharCount,
    originalWordCount: meta.originalWordCount,
    originalLineCount: meta.originalLineCount,
    createdAt: meta.createdAt,
  }
}

export function buildAgentFileMetadata(files: readonly unknown[] = []): AgentFileMetadata[] {
  return files.flatMap((file) => {
    const candidate = asComposerFile(file)
    const id = resolveUploadFileId(candidate)
    if (!candidate || !id) return []

    const safeLongPasteMeta = sanitizeLongPasteMetaForMessage(getLongPasteMetadata(file))
    const displayName = String(
      safeLongPasteMeta?.title
      || candidate.longPasteTitle
      || candidate.originalName
      || candidate.name
      || candidate.filename
      || "archivo",
    )

    return [{
      id,
      name: displayName,
      originalName: displayName,
      filename: String(candidate.filename || candidate.name || displayName),
      mimeType: candidate.mimeType || candidate.type || candidate.contentType || null,
      type: candidate.type || candidate.mimeType || candidate.contentType || null,
      size: candidate.size ?? null,
      url: candidate.url || null,
      openaiFileId: candidate.openaiFileId || null,
      sourceChannel: candidate.sourceChannel || null,
      isLongPasteDocument: Boolean(candidate.isLongPasteDocument || safeLongPasteMeta),
      longPasteTitle: safeLongPasteMeta?.title || optionalString(candidate.longPasteTitle),
      longPastePreview: safeLongPasteMeta?.preview || optionalString(candidate.longPastePreview),
      longPasteMeta: safeLongPasteMeta,
    }]
  })
}

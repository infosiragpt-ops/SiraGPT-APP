import { isActiveProcessingStage, type FileProcessingStage } from "../file-processing-vocab"
import { getLongPasteMetadata, type LongPasteMetadata } from "../long-paste"

type ComposerFileRecord = {
  id?: unknown
  fileId?: unknown
  attachmentId?: unknown
  file?: unknown
  url?: unknown
  preview?: unknown
  objectUrl?: unknown
  imageUrl?: unknown
  path?: unknown
  thumbnailUrl?: unknown
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
  tempId?: unknown
  mediaMeta?: unknown
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

export function parseMessageFiles(files: unknown): unknown[] {
  if (!files) return []
  if (Array.isArray(files)) return files
  if (typeof files === "string") {
    try {
      const parsed = JSON.parse(files)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

export function collectMessageFileIds(files: unknown): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const file of parseMessageFiles(files)) {
    const id = resolveUploadFileId(file)
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

export function attachmentHasPreviewSource(attachment: unknown): boolean {
  const candidate = asComposerFile(attachment)
  return Boolean(
    candidate?.file
    || candidate?.url
    || candidate?.extractedText
    || candidate?.preview
    || candidate?.objectUrl,
  )
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

/**
 * Attachments the composer must keep polling until the backend reports a
 * terminal stage: anything still flagged as processing that already has a
 * server id. Chip variants that render no status poller (the "PEGADO" long
 * paste card) otherwise stay "processing" forever and block the send.
 */
export function collectProcessingFileIds(files: readonly unknown[] = []): string[] {
  const ids: string[] = []
  for (const file of files) {
    const candidate = asComposerFile(file)
    if (!candidate) continue
    const id = resolveUploadFileId(candidate)
    if (!id) continue
    const stillProcessing = isComposerFileProcessingPending(candidate)
      || (candidate.status === "processing" && !isTerminalProcessingStage(getFileProcessingStage(candidate)))
    if (stillProcessing && !ids.includes(id)) ids.push(id)
  }
  return ids
}

function isTerminalProcessingStage(stage: FileProcessingStage | null): boolean {
  return stage === "ready" || stage === "failed"
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

const AUDIO_EXT_RE = /\.(?:mp3|wav|m4a|aac|ogg|oga|flac|opus|wma|aiff?)$/i
const VIDEO_EXT_RE = /\.(?:mp4|m4v|mov|webm|mkv|avi|mpeg|mpg|ogv|3gp)$/i

export type AttachmentMediaMeta = {
  durationSeconds?: number
  peaks?: number[]
  thumbnailDataUrl?: string | null
}

export type MessageFileSnapshot = {
  id: string | null
  tempId: string | null
  name: string
  originalName: string
  filename: string
  mimeType: string | null
  type: string | null
  size: number | null
  url: string | null
  preview: string | null
  thumbnailUrl: string | null
  path: string | null
  extractedText: string | null
  mediaMeta: AttachmentMediaMeta | null
  sourceChannel: unknown
  isLongPasteDocument: boolean
  longPasteTitle: string | null
  longPastePreview: string | null
  longPasteMeta: SafeLongPasteMetadata | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function isDurableUrl(value: unknown): boolean {
  const url = optionalString(value)
  return Boolean(url && !url.startsWith("blob:"))
}

function snapshotMediaMeta(value: unknown): AttachmentMediaMeta | null {
  const record = asRecord(value)
  if (!record) return null
  const durationSeconds = optionalNumber(record.durationSeconds)
  const peaks = Array.isArray(record.peaks)
    ? record.peaks.filter((peak): peak is number => typeof peak === "number" && Number.isFinite(peak))
    : []
  const thumbnailDataUrl = optionalString(record.thumbnailDataUrl)
  if (durationSeconds == null && peaks.length === 0 && !thumbnailDataUrl) return null
  return {
    ...(durationSeconds != null ? { durationSeconds } : {}),
    ...(peaks.length > 0 ? { peaks } : {}),
    ...(thumbnailDataUrl ? { thumbnailDataUrl } : {}),
  }
}

function attachmentDisplayName(file: ComposerFileRecord, fallback = "archivo"): string {
  return String(
    file.longPasteTitle
    || file.originalName
    || file.name
    || file.filename
    || fallback,
  )
}

function attachmentMime(file: ComposerFileRecord): string {
  return String(file.mimeType || file.type || file.contentType || "").toLowerCase()
}

export function isAudioComposerFile(file: unknown): boolean {
  const candidate = asComposerFile(file)
  if (!candidate) return false
  const mime = attachmentMime(candidate)
  if (mime.startsWith("audio/")) return true
  if (mime.startsWith("video/")) return false
  return AUDIO_EXT_RE.test(attachmentDisplayName(candidate, ""))
}

export function getAudioMediaMeta(file: unknown): AttachmentMediaMeta | null {
  const record = asRecord(file)
  return snapshotMediaMeta(record?.mediaMeta)
}

export function isVideoComposerFile(file: unknown): boolean {
  const candidate = asComposerFile(file)
  if (!candidate) return false
  const mime = attachmentMime(candidate)
  if (mime.startsWith("video/")) return true
  if (mime.startsWith("audio/") || mime.startsWith("image/")) return false
  return VIDEO_EXT_RE.test(attachmentDisplayName(candidate, ""))
}

/**
 * True when the picker File (or a composer chip) should get an instant
 * blob preview + <video>/<audio> player — including WhatsApp/Safari
 * picks that arrive as application/octet-stream with a .mp4/.m4a name.
 */
export function shouldCreateLocalMediaPreview(file: unknown): boolean {
  if (!file) return false
  if (typeof File !== "undefined" && file instanceof File) {
    return isVideoComposerFile({ name: file.name, type: file.type })
      || isAudioComposerFile({ name: file.name, type: file.type })
      || String(file.type || "").toLowerCase().startsWith("image/")
  }
  return isVideoComposerFile(file) || isAudioComposerFile(file)
}

function isDurableMediaSrc(value: unknown): boolean {
  const url = optionalString(value)
  return Boolean(url && !url.startsWith("blob:"))
}

export function resolveComposerMediaSrc(file: unknown): string {
  const candidate = asComposerFile(file)
  if (!candidate) return ""
  const durable = [
    candidate.url,
    candidate.path,
    candidate.imageUrl,
  ].map(optionalString).find((value): value is string => isDurableMediaSrc(value))
  if (durable) return durable
  return optionalString(candidate.preview)
    || optionalString(candidate.objectUrl)
    || optionalString(candidate.url)
    || optionalString(candidate.path)
    || optionalString(candidate.imageUrl)
    || ""
}

/**
 * Plain JSON snapshot of composer attachments for the optimistic user bubble.
 * Drops the native File/blob handle (JSON.stringify throws or {}s it) while
 * keeping name, mime, url, and already-computed audio waveform/duration.
 */
export function snapshotComposerFilesForMessage(files: readonly unknown[] = []): MessageFileSnapshot[] {
  return files.flatMap((file) => {
    if (typeof file === "string") {
      const id = optionalString(file)
      if (!id) return []
      return [{
        id,
        tempId: null,
        name: "archivo",
        originalName: "archivo",
        filename: "archivo",
        mimeType: null,
        type: null,
        size: null,
        url: null,
        preview: null,
        thumbnailUrl: null,
        path: null,
        extractedText: null,
        mediaMeta: null,
        sourceChannel: null,
        isLongPasteDocument: false,
        longPasteTitle: null,
        longPastePreview: null,
        longPasteMeta: null,
      }]
    }

    const candidate = asComposerFile(file)
    if (!candidate) return []
    const record = asRecord(file) || {}
    const safeLongPasteMeta = sanitizeLongPasteMetaForMessage(getLongPasteMetadata(file))
    const displayName = attachmentDisplayName({
      ...candidate,
      longPasteTitle: candidate.longPasteTitle || safeLongPasteMeta?.title,
    })
    const mimeType = optionalString(attachmentMime(candidate))
    const extracted = optionalString(candidate.extractedText)

    return [{
      id: resolveUploadFileId(candidate),
      tempId: optionalString(candidate.tempId),
      name: displayName,
      originalName: String(candidate.originalName || displayName),
      filename: String(candidate.filename || candidate.name || displayName),
      mimeType,
      type: mimeType || optionalString(typeof candidate.type === "string" ? candidate.type : null),
      size: optionalNumber(candidate.size),
      url: optionalString(candidate.url) || optionalString(candidate.imageUrl),
      preview: optionalString(candidate.preview) || optionalString(candidate.objectUrl),
      thumbnailUrl: optionalString(candidate.thumbnailUrl),
      path: optionalString(candidate.path),
      extractedText: extracted && extracted.length <= 4000 ? extracted : null,
      mediaMeta: snapshotMediaMeta(record.mediaMeta),
      sourceChannel: candidate.sourceChannel || null,
      isLongPasteDocument: Boolean(candidate.isLongPasteDocument || safeLongPasteMeta),
      longPasteTitle: safeLongPasteMeta?.title || optionalString(candidate.longPasteTitle),
      longPastePreview: safeLongPasteMeta?.preview || optionalString(candidate.longPastePreview),
      longPasteMeta: safeLongPasteMeta,
    }]
  })
}

function mergeOneMessageFile(incoming: unknown, local: unknown): unknown {
  if (!local || typeof local !== "object") return incoming
  if (!incoming || typeof incoming !== "object") return local
  const incomingRecord = incoming as Record<string, unknown>
  const localRecord = local as Record<string, unknown>
  const incomingUrl = optionalString(incomingRecord.url) || optionalString(incomingRecord.path)
  const localUrl = optionalString(localRecord.url) || optionalString(localRecord.preview)
  const url = isDurableUrl(incomingUrl) ? incomingUrl : (isDurableUrl(localUrl) ? localUrl : incomingUrl || localUrl)
  const incomingMeta = snapshotMediaMeta(incomingRecord.mediaMeta)
  const localMeta = snapshotMediaMeta(localRecord.mediaMeta)
  return {
    ...localRecord,
    ...incomingRecord,
    id: resolveUploadFileId(incoming) || resolveUploadFileId(local) || incomingRecord.id || localRecord.id || null,
    name: incomingRecord.name || localRecord.name,
    originalName: incomingRecord.originalName || localRecord.originalName,
    filename: incomingRecord.filename || localRecord.filename,
    mimeType: incomingRecord.mimeType || localRecord.mimeType || incomingRecord.type || localRecord.type || null,
    type: incomingRecord.type || localRecord.type || incomingRecord.mimeType || localRecord.mimeType || null,
    size: incomingRecord.size ?? localRecord.size ?? null,
    url,
    preview: isDurableUrl(incomingRecord.preview) ? incomingRecord.preview : (localRecord.preview || incomingRecord.preview || null),
    thumbnailUrl: incomingRecord.thumbnailUrl || localRecord.thumbnailUrl || null,
    path: incomingRecord.path || localRecord.path || null,
    mediaMeta: incomingMeta || localMeta,
    extractedText: incomingRecord.extractedText || localRecord.extractedText || null,
  }
}

/**
 * Graft the locally visible attachment records onto a later server payload.
 * Canonical URLs from the server replace blob previews without dropping
 * name / duration / waveform that the optimistic chip already showed.
 */
export function mergeMessageFileLists(incoming: unknown, local: unknown): unknown[] {
  const incomingFiles = parseMessageFiles(incoming)
  const localFiles = parseMessageFiles(local)
  if (localFiles.length === 0) return incomingFiles
  if (incomingFiles.length === 0) return localFiles

  const localById = new Map<string, unknown>()
  for (const file of localFiles) {
    const id = resolveUploadFileId(file)
    if (id && !localById.has(id)) localById.set(id, file)
  }

  const usedLocalIds = new Set<string>()
  const merged = incomingFiles.map((incomingFile, index) => {
    const id = resolveUploadFileId(incomingFile)
    const localMatch = (id && localById.get(id)) || localFiles[index]
    if (id) usedLocalIds.add(id)
    return mergeOneMessageFile(incomingFile, localMatch)
  })

  for (const [id, file] of localById) {
    if (!usedLocalIds.has(id)) merged.push(file)
  }
  return merged
}

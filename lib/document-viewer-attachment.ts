export interface DocumentViewerAttachment {
  id?: string | null
  name: string
  mimeType?: string | null
  size?: number | null
  file?: File | null
  url?: string | null
  extractedText?: string | null
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = nonEmptyString(value)
    if (normalized) return normalized
  }
  return null
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return null
}

export function isFileLike(value: unknown): value is File {
  if (!value || typeof value !== "object") return false
  if (typeof File !== "undefined" && value instanceof File) return true
  const candidate = value as {
    name?: unknown
    size?: unknown
    type?: unknown
    text?: unknown
    arrayBuffer?: unknown
  }
  return (
    typeof candidate.name === "string" &&
    typeof candidate.text === "function" &&
    typeof candidate.arrayBuffer === "function" &&
    (typeof candidate.size === "number" || typeof candidate.type === "string")
  )
}

export function getAttachmentLocalFile(source: unknown): File | null {
  if (isFileLike(source)) return source
  if (!source || typeof source !== "object") return null
  const record = source as Record<string, unknown>
  const candidates = [
    record.file,
    record.originalFile,
    record.blob,
    record.nativeFile,
  ]
  for (const candidate of candidates) {
    if (isFileLike(candidate)) return candidate
  }
  return null
}

function normalizeAttachmentPath(value: unknown): string | null {
  const raw = nonEmptyString(value)
  if (!raw) return null
  if (/^(https?:|data:|blob:)/i.test(raw)) return raw

  const normalized = raw.replace(/\\/g, "/")
  const uploadsMatch = normalized.match(/(?:^|\/)(uploads\/.+)$/)
  if (uploadsMatch) return `/${uploadsMatch[1]}`
  if (normalized.startsWith("/") || normalized.startsWith("api/")) return normalized
  return normalized
}

export function toDocumentViewerAttachment(
  source: unknown,
  fallbackName = "archivo",
): DocumentViewerAttachment {
  const record = source && typeof source === "object"
    ? source as Record<string, any>
    : {}
  const localFile = getAttachmentLocalFile(source)

  const name = firstString(
    record.longPasteTitle,
    record.longPasteMeta?.title,
    record.longPasteMetadata?.title,
    record.originalName,
    record.name,
    record.filename,
    localFile?.name,
    fallbackName,
  ) || fallbackName

  return {
    id: firstString(record.id, record.fileId, record.attachmentId, record.tempId),
    name,
    mimeType: firstString(record.mimeType, record.type, record.contentType, localFile?.type),
    size: firstNumber(record.size, localFile?.size),
    file: localFile,
    url: normalizeAttachmentPath(firstString(
      record.url,
      record.downloadUrl,
      record.previewUrl,
      record.dataUrl,
      record.fileUrl,
      record.imageUrl,
      record.path,
    )),
    extractedText: firstString(record.extractedText, record.text, record.content),
  }
}

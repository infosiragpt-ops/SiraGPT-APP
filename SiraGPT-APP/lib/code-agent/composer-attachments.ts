export type CodeComposerAttachment = {
  tempId: string
  id?: string
  fileId?: string
  attachmentId?: string
  name: string
  originalName?: string
  filename?: string
  type?: string
  mimeType?: string
  size?: number
  url?: string
  preview?: string | null
  file?: File
  sourceChannel?: string
  status: "uploading" | "ready" | "failed"
  uploadError?: string
}

export function codeAttachmentId(file: CodeComposerAttachment): string {
  return String(file.id || file.tempId || file.name)
}

export function codeAttachmentFileId(file: CodeComposerAttachment): string | null {
  return file.id || file.fileId || file.attachmentId || null
}

export function codeAttachmentName(
  file: Pick<CodeComposerAttachment, "name" | "originalName" | "filename">,
): string {
  return String(file.originalName || file.name || file.filename || "archivo")
}

export function codeAttachmentType(
  file: Pick<CodeComposerAttachment, "type" | "mimeType">,
): string {
  return String(file.mimeType || file.type || "application/octet-stream")
}

export function formatCodeAttachmentBytes(size?: number): string {
  const bytes = Number(size || 0)
  if (!Number.isFinite(bytes) || bytes <= 0) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
}

export function buildCodeAttachmentPromptBlock(files: readonly CodeComposerAttachment[]): string {
  const ready = files.filter((file) => file.status === "ready")
  if (ready.length === 0) return ""

  const rows = ready.map((file, index) => {
    const id = file.id ? `id=${file.id}` : `temp=${file.tempId}`
    const url = file.url ? `, url=${file.url}` : ""
    const size = formatCodeAttachmentBytes(file.size)
    return `- ${index + 1}. ${codeAttachmentName(file)} (${codeAttachmentType(file)}${size ? `, ${size}` : ""}, ${id}${url})`
  })

  return [
    "Archivos adjuntos del usuario para este turno de APPS:",
    ...rows,
    "Usa estas referencias como contexto visual/documental del cambio. Si son imagenes, analiza lo que muestran antes de modificar el software. Si necesitas contenido interno que no este disponible en el workspace, indicalo explicitamente.",
  ].join("\n")
}

export function composeCodePromptWithAttachments(
  input: string,
  files: readonly CodeComposerAttachment[],
): string {
  const text = input.trim()
  const block = buildCodeAttachmentPromptBlock(files)
  if (!block) return text
  return [
    text || "Revisa los archivos adjuntos y aplicalos al proyecto de APPS.",
    "",
    block,
  ].join("\n")
}

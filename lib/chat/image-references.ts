import { describeAttachmentKind } from "../attachment-kinds"
import { resolveUploadFileId } from "./composer-files"

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/** Select actual image attachments, never a document's generated thumbnail. */
export function collectImageUploadFileIds(files: readonly unknown[] = []): string[] {
  const ids = new Set<string>()
  for (const value of files) {
    if (!value || typeof value !== "object") continue
    const file = value as Record<string, unknown>
    if (file.deletedAt) continue
    const id = resolveUploadFileId(file)
    if (!id) continue
    const name = text(file.originalName) || text(file.name) || text(file.filename)
      || text(file.url) || text(file.imageUrl)
    const mime = text(file.mimeType) || text(file.contentType) || text(file.type)
    const kind = describeAttachmentKind({
      name: name.split(/[?#]/, 1)[0],
      type: mime === "image" ? "image/*" : mime,
    })
    if (kind.family === "image") ids.add(id)
  }
  // Keep the reply/edit target first and preserve all subsequent references.
  return [...ids]
}

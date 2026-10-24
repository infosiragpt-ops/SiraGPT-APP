/** A folder path is display/context metadata, never a server filesystem path. */
export function normalizeAttachmentRelativePath(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 1024) return null
  if (/[\\\u0000-\u001f\u007f]/.test(value) || value.startsWith("/") || /^[a-z]:/i.test(value)) return null
  const segments = value.split("/")
  if (segments.length < 2 || segments.length > 64 || segments.some((part) => !part || part === "." || part === "..")) return null
  return value
}

export function getAttachmentRelativePath(file: unknown): string | null {
  if (!file || typeof file !== "object") return null
  const record = file as { relativePath?: unknown; webkitRelativePath?: unknown; file?: unknown }
  const nativeFile = record.file && typeof record.file === "object"
    ? record.file as { webkitRelativePath?: unknown } : null
  return normalizeAttachmentRelativePath(record.relativePath)
    || normalizeAttachmentRelativePath(record.webkitRelativePath)
    || normalizeAttachmentRelativePath(nativeFile?.webkitRelativePath)
}

/** Keep the native File objects: copying them discards webkitRelativePath. */
export function prepareFolderSelection(files: readonly File[]): { files: File[]; skipped: number } {
  const accepted: File[] = []
  let skipped = 0
  for (const file of files) {
    const relativePath = getAttachmentRelativePath(file)
    const segments = relativePath?.split("/") || []
    // Folder picking may include hidden credentials and macOS resource forks.
    // Explicit single-file selection remains unchanged.
    if (!relativePath || segments[segments.length - 1] !== file.name
      || segments.some((part) => part.startsWith(".") || part === "__MACOSX")) {
      skipped += 1
      continue
    }
    accepted.push(file)
  }
  return { files: accepted, skipped }
}

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

const IGNORED_FOLDER_SEGMENTS = new Set([
  "__MACOSX",
  "node_modules",
  ".next",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".turbo",
  ".cache",
])

const IGNORED_FOLDER_FILENAMES = new Set([
  ".ds_store",
  "thumbs.db",
  "desktop.ini",
])

export function isIgnoredFolderSegment(segment: string): boolean {
  if (!segment) return true
  if (segment.startsWith(".")) return true
  return IGNORED_FOLDER_SEGMENTS.has(segment)
}

/** Keep the native File objects: copying them discards webkitRelativePath. */
export function prepareFolderSelection(files: readonly File[]): { files: File[]; skipped: number } {
  const accepted: File[] = []
  let skipped = 0
  for (const file of files) {
    const relativePath = getAttachmentRelativePath(file)
    const segments = relativePath?.split("/") || []
    const lowerName = String(file.name || "").toLowerCase()
    // Folder picking may include hidden credentials, macOS resource forks, and build/dependency caches.
    // Explicit single-file selection remains unchanged.
    if (
      !relativePath
      || segments[segments.length - 1] !== file.name
      || IGNORED_FOLDER_FILENAMES.has(lowerName)
      || segments.some(isIgnoredFolderSegment)
    ) {
      skipped += 1
      continue
    }
    accepted.push(file)
  }
  return { files: accepted, skipped }
}

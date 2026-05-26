"use client"

import { CodeFiles, languageForPath, normalizePath } from "./code-workspace-utils"

const MAX_FILES = 160
const MAX_FILE_BYTES = 768 * 1024
const MAX_TOTAL_BYTES = 5 * 1024 * 1024

const IGNORED_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".vercel",
  ".idea",
  ".vscode",
  ".husky",
  ".orchestration",
  ".cursor",
  ".test-dist",
  "test-results",
  "output",
  "playwright-report",
])

const TEXT_EXTENSIONS = new Set([
  "astro",
  "bash",
  "c",
  "cpp",
  "cs",
  "css",
  "csv",
  "go",
  "h",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "less",
  "md",
  "mdx",
  "mjs",
  "php",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
])

const TEXT_FILENAMES = new Set([
  ".env",
  ".env.example",
  ".gitignore",
  ".prettierrc",
  "dockerfile",
  "makefile",
  "readme",
])

type DirectoryHandleLike = any
type FileHandleLike = any

let linkedRootHandle: DirectoryHandleLike | null = null
let linkedRootName = ""
const linkedFileHandles = new Map<string, FileHandleLike>()

export type LocalWorkspaceImport = {
  rootName: string
  files: CodeFiles
  fileCount: number
  skippedCount: number
}

export function canOpenLocalDirectory(): boolean {
  if (typeof window === "undefined") return false
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function"
}

export function hasLinkedLocalFolder(): boolean {
  return Boolean(linkedRootHandle)
}

export function getLinkedLocalFolderName(): string {
  return linkedRootName
}

export async function openLocalDirectoryWorkspace(): Promise<LocalWorkspaceImport> {
  if (typeof window === "undefined") {
    throw new Error("El selector de carpetas solo está disponible en el navegador.")
  }

  const picker = (window as unknown as { showDirectoryPicker?: (opts?: { id?: string; mode?: string; startIn?: string }) => Promise<DirectoryHandleLike> }).showDirectoryPicker
  if (typeof picker !== "function") {
    throw new Error("Tu navegador no permite abrir carpetas locales. Usa Chrome o Edge para editar una carpeta del escritorio.")
  }

  let rootHandle: DirectoryHandleLike
  try {
    rootHandle = await picker({
      id: "siragpt-code-workspace",
      mode: "readwrite",
      startIn: "desktop",
    })
  } catch (error) {
    if ((error as Error)?.name === "TypeError") {
      rootHandle = await picker({ id: "siragpt-code-workspace", mode: "readwrite" })
    } else {
      throw error
    }
  }

  const files: CodeFiles = {}
  const stats = { count: 0, bytes: 0, skipped: 0 }
  linkedFileHandles.clear()

  await walkDirectory(rootHandle, "", files, stats)

  if (Object.keys(files).length === 0) {
    throw new Error("No se encontraron archivos de texto compatibles en esa carpeta.")
  }

  linkedRootHandle = rootHandle
  linkedRootName = String(rootHandle.name || "Carpeta local")

  return {
    rootName: linkedRootName,
    files,
    fileCount: Object.keys(files).length,
    skippedCount: stats.skipped,
  }
}

export async function saveLinkedWorkspaceFile(path: string, content: string): Promise<void> {
  const normalized = normalizePath(path)
  if (!normalized) throw new Error("Ruta de archivo inválida.")
  if (!linkedRootHandle) throw new Error("No hay una carpeta local vinculada.")

  const handle = linkedFileHandles.get(normalized) || await createFileHandle(normalized)
  await ensureWritablePermission(handle)

  const writable = await handle.createWritable()
  await writable.write(content)
  await writable.close()
  linkedFileHandles.set(normalized, handle)
}

async function walkDirectory(
  directoryHandle: DirectoryHandleLike,
  basePath: string,
  files: CodeFiles,
  stats: { count: number; bytes: number; skipped: number },
) {
  if (!directoryHandle?.entries) return

  for await (const [name, handle] of directoryHandle.entries()) {
    if (stats.count >= MAX_FILES || stats.bytes >= MAX_TOTAL_BYTES) {
      stats.skipped++
      continue
    }

    if (handle.kind === "directory") {
      if (IGNORED_DIRS.has(String(name).toLowerCase())) {
        stats.skipped++
        continue
      }
      const nextBase = basePath ? `${basePath}/${name}` : name
      await walkDirectory(handle, nextBase, files, stats)
      continue
    }

    if (handle.kind !== "file" || !isTextLikeFile(name)) {
      stats.skipped++
      continue
    }

    try {
      const file = await handle.getFile()
      if (file.size > MAX_FILE_BYTES || stats.bytes + file.size > MAX_TOTAL_BYTES) {
        stats.skipped++
        continue
      }
      const content = await file.text()
      if (content.includes("\u0000")) {
        stats.skipped++
        continue
      }
      const path = normalizePath(basePath ? `${basePath}/${name}` : name)
      files[path] = {
        path,
        language: languageForPath(path),
        content,
        updatedAt: file.lastModified || Date.now(),
      }
      linkedFileHandles.set(path, handle)
      stats.count++
      stats.bytes += file.size
    } catch {
      stats.skipped++
    }
  }
}

function isTextLikeFile(name: string): boolean {
  const lower = String(name || "").toLowerCase()
  if (TEXT_FILENAMES.has(lower)) return true
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : ""
  return TEXT_EXTENSIONS.has(ext)
}

async function createFileHandle(path: string): Promise<FileHandleLike> {
  const parts = normalizePath(path).split("/").filter(Boolean)
  const filename = parts.pop()
  if (!filename || !linkedRootHandle) throw new Error("No se pudo resolver el archivo local.")

  let current = linkedRootHandle
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create: true })
  }
  return current.getFileHandle(filename, { create: true })
}

async function ensureWritablePermission(handle: FileHandleLike) {
  if (!handle?.queryPermission || !handle?.requestPermission) return
  const current = await handle.queryPermission({ mode: "readwrite" })
  if (current === "granted") return
  const requested = await handle.requestPermission({ mode: "readwrite" })
  if (requested !== "granted") throw new Error("Permiso de escritura denegado para esta carpeta.")
}

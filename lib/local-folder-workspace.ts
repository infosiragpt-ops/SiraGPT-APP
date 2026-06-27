"use client"

import { CodeFiles, languageForPath, normalizePath } from "./code-workspace-utils"
import {
  CODEX_UPDATED_EVENT,
  codexIdForLocalFolder,
  upsertCodexProject,
} from "./codex-projects"

// Must stay in sync with CodeWorkspaceProvider (lib/code-workspace-context.tsx):
// per-folder editor state lives at `${WORKSPACE_STORAGE_KEY}:${codexId}` and the
// active folder pointer at ACTIVE_FOLDER_KEY.
const WORKSPACE_STORAGE_KEY = "code-workspace:v1"
const ACTIVE_FOLDER_KEY = "code-workspace:active-folder"

const MAX_FILES = 400
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
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.dist",
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

  // Las carpetas vacías (o sin archivos de texto compatibles) SON válidas: se
  // abren como un workspace en blanco al que luego se le crean archivos o lo
  // genera el agente. La carpeta queda enlazada (linkedRootHandle) para escribir
  // de vuelta en disco. No bloqueamos por falta de archivos.
  linkedRootHandle = rootHandle
  linkedRootName = String(rootHandle.name || "Carpeta local")

  return {
    rootName: linkedRootName,
    files,
    fileCount: Object.keys(files).length,
    skippedCount: stats.skipped,
  }
}

export type LocalFolderRegistration = {
  codexId: string
  name: string
  fileCount: number
  skippedCount: number
}

function pickInitialTabs(paths: string[]): string[] {
  const preferred = [
    "README.md",
    "readme.md",
    "package.json",
    "index.html",
    "src/app.tsx",
    "app/page.tsx",
  ]
  const sorted = [...paths].sort((a, b) => a.localeCompare(b))
  const picked: string[] = []
  for (const candidate of preferred) {
    const found = sorted.find((p) => p.toLowerCase() === candidate.toLowerCase())
    if (found && !picked.includes(found)) picked.push(found)
  }
  for (const path of sorted) {
    if (picked.length >= 3) break
    if (!picked.includes(path)) picked.push(path)
  }
  return picked
}

/**
 * Open the OS folder picker, import the selected local code folder, and
 * register it as a Codex workspace — persisted under the same localStorage
 * keys the /code workspace provider reads, so navigating to /code hydrates it.
 *
 * MUST be called directly from a user gesture (e.g. a click handler) so the
 * browser allows showDirectoryPicker(). Navigating first and then opening the
 * picker asynchronously drops the user-activation and the picker is blocked.
 */
export async function importLocalFolderAsWorkspace(): Promise<LocalFolderRegistration> {
  const imported = await openLocalDirectoryWorkspace()
  const codexId = codexIdForLocalFolder(imported.rootName)
  const paths = Object.keys(imported.files)
  const openTabs = pickInitialTabs(paths)
  const activePath = openTabs[0] ?? paths[0] ?? null

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        `${WORKSPACE_STORAGE_KEY}:${codexId}`,
        JSON.stringify({ files: imported.files, openTabs, activePath }),
      )
      window.localStorage.setItem(
        ACTIVE_FOLDER_KEY,
        JSON.stringify({ id: codexId, name: imported.rootName }),
      )
    } catch {
      /* quota — fail soft; /code can re-link via the + button */
    }
  }

  upsertCodexProject({
    id: codexId,
    name: imported.rootName,
    kind: "local-folder",
    displayPath: `~/Desktop/${imported.rootName}`,
    fileCount: imported.fileCount,
  })

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CODEX_UPDATED_EVENT))
  }

  return {
    codexId,
    name: imported.rootName,
    fileCount: imported.fileCount,
    skippedCount: imported.skippedCount,
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

    // Never import local secret files — credentials must stay on the user's
    // machine and never get copied into the in-app workspace.
    if (isSecretEnvFile(name)) {
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

// Local secret files we must NEVER import — credentials stay on the user's
// machine. Matches `.env` and variants like `.env.local` / `.env.production`,
// but allows non-secret templates (`.env.example`, `.env.sample`, `.env.template`).
const ENV_TEMPLATE_SUFFIXES = new Set(["example", "sample", "template", "dist"])
function isSecretEnvFile(name: string): boolean {
  const lower = String(name || "").toLowerCase()
  if (lower !== ".env" && !lower.startsWith(".env.")) return false
  const suffix = lower.startsWith(".env.") ? lower.slice(".env.".length) : ""
  return !ENV_TEMPLATE_SUFFIXES.has(suffix)
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

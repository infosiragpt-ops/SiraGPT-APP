/**
 * Codex project registry — tracks recently opened code workspaces
 * (local folders + cloud projects) so the sidebar can list several
 * entries like the design grid does for visual projects.
 */

export type CodexProjectKind = "local-folder" | "project"

export type CodexProjectEntry = {
  id: string
  name: string
  kind: CodexProjectKind
  /** Shown in the Codex picker (e.g. ~/Desktop/siraGPT). */
  displayPath?: string
  fileCount?: number
  updatedAt: number
}

const STORAGE_KEY = "code-workspace:codex-registry"
const MAX_ENTRIES = 12

export const CODEX_UPDATED_EVENT = "siragpt:codex-projects-updated"

function storage(): Storage | null {
  try {
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis) {
      return globalThis.localStorage as Storage
    }
  } catch {
    /* private mode / denied */
  }
  return null
}

function safeParse(raw: string | null): CodexProjectEntry[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (row): row is CodexProjectEntry =>
        Boolean(row)
        && typeof row.id === "string"
        && typeof row.name === "string"
        && (row.kind === "local-folder" || row.kind === "project")
        && typeof row.updatedAt === "number",
    )
  } catch {
    return []
  }
}

export function listCodexProjects(): CodexProjectEntry[] {
  const store = storage()
  if (!store) return []
  const rows = safeParse(store.getItem(STORAGE_KEY))
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function upsertCodexProject(entry: Omit<CodexProjectEntry, "updatedAt"> & { updatedAt?: number }): CodexProjectEntry[] {
  const store = storage()
  if (!store) return []
  const next: CodexProjectEntry = {
    ...entry,
    updatedAt: entry.updatedAt ?? Date.now(),
  }
  const without = listCodexProjects().filter((row) => row.id !== next.id)
  const merged = [next, ...without].slice(0, MAX_ENTRIES)
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(merged))
  } catch {
    /* quota — fail soft */
  }
  return merged
}

export function removeCodexProject(id: string): CodexProjectEntry[] {
  const store = storage()
  if (!store) return []
  const merged = listCodexProjects().filter((row) => row.id !== id)
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(merged))
  } catch {
    /* fail soft */
  }
  return merged
}

export function codexIdForLocalFolder(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  return `local:${slug || "folder"}`
}

export function codexIdForProject(projectId: string): string {
  return `project:${projectId}`
}

/** Human-readable path for the Cursor-style folder picker. */
export function codexEntryDisplayPath(entry: CodexProjectEntry): string {
  if (entry.displayPath?.trim()) return entry.displayPath.trim()
  if (entry.kind === "local-folder") return `~/Desktop/${entry.name}`
  return entry.name
}

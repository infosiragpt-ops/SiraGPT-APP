/**
 * document-versions — pure, dependency-injected orchestrator for the /chat
 * document editor's version history ("Historial") tab.
 *
 * Mirrors the style of lib/chat/document-editor.ts: every function takes its
 * collaborators as arguments (apiClient, fetcher) so unit tests can stub them,
 * and nothing here imports server-only modules or performs a raw fetch.
 *
 * Endpoints consumed (all via the injected apiClient, which routes through
 * lib/api.ts → authenticatedFetch):
 *   - GET  /files/:id/versions                       (list, limit/offset)
 *   - GET  /files/:id/versions/:versionId/content    (diff left side)
 *   - POST /files/:id/versions/:versionId/restore    (restore)
 */

export type DocumentVersionRecord = {
  id: string
  version: number
  filename: string
  summary?: string | null
  validationPassed: boolean
  createdAt: string
  /** editPlan.type from the backend — "manual_edit" | "restore" | surgical… */
  editPlanType?: string | null
  /** Chat that produced the version, when known. */
  createdByChatId?: string | null
  /** True when the row carries editable Markdown (manual chat edits). */
  hasContent?: boolean
  downloadUrl?: string | null
}

export type DocumentVersionsPage = {
  fileId: string
  total: number
  versions: DocumentVersionRecord[]
}

/** Minimal shape of the apiClient surface this module needs. */
export type VersionsApiClient = {
  getFileVersions?: (fileId: string) => Promise<{ fileId?: string; versions?: DocumentVersionRecord[] }>
  restoreFileVersion?: (fileId: string, versionId: string, chatId?: string) => Promise<{
    sourceVersion?: number
    version?: Partial<DocumentVersionRecord>
  }>
  request?: (endpoint: string, options?: Record<string, unknown>) => Promise<unknown>
}

const PAGE_SIZE = 20

export const DOCUMENT_VERSIONS_PAGE_SIZE = PAGE_SIZE

function fallbackApiClient(client: unknown): VersionsApiClient {
  return (client || {}) as VersionsApiClient
}

function asError(err: unknown, fallback: string): Error {
  if (err instanceof Error && err.message) return err
  return new Error(fallback)
}

/**
 * List one page of versions (newest first). Uses the apiClient's typed helper
 * when present; falls back to the raw `request` transport otherwise.
 */
export async function listDocumentVersions(
  options: { apiClient: unknown; fileId: string },
): Promise<DocumentVersionsPage> {
  const { fileId } = options
  const client = fallbackApiClient(options.apiClient)

  let payload: unknown
  if (typeof client.getFileVersions === "function") {
    payload = await client.getFileVersions(fileId).catch((err: unknown) => {
      throw asError(err, "No se pudo cargar el historial de versiones")
    })
  } else if (typeof client.request === "function") {
    payload = await client
      .request(`/files/${encodeURIComponent(fileId)}/versions`)
      .catch((err: unknown) => {
        throw asError(err, "No se pudo cargar el historial de versiones")
      })
  } else {
    return { fileId, total: 0, versions: [] }
  }

  const record = (payload ?? {}) as Record<string, unknown>
  const versionsRaw = Array.isArray(record.versions) ? record.versions : []
  const total = typeof record.total === "number" ? record.total : versionsRaw.length
  const versions: DocumentVersionRecord[] = versionsRaw.map((entry) => {
    const v = (entry ?? {}) as Record<string, unknown>
    return {
      id: String(v.id ?? ""),
      version: Number(v.version ?? 0),
      filename: String(v.filename ?? "documento"),
      summary: typeof v.summary === "string" ? v.summary : null,
      validationPassed: v.validationPassed !== false,
      createdAt: String(v.createdAt ?? new Date().toISOString()),
      editPlanType: typeof v.editPlanType === "string" ? v.editPlanType : null,
      createdByChatId: typeof v.createdByChatId === "string" ? v.createdByChatId : null,
      hasContent: v.hasContent === true,
      downloadUrl: typeof v.downloadUrl === "string" ? v.downloadUrl : null,
    }
  })

  return { fileId, total, versions }
}

/**
 * Client-side windowing over the full newest-first list: page N is
 * `[offset, offset + pageSize)` of that list, matching the backend's
 * limit/offset contract. The panel keeps appending pages until
 * `versions.length >= total`.
 */
export function sliceVersionPage(
  list: DocumentVersionRecord[],
  offset: number,
  pageSize: number = PAGE_SIZE,
): DocumentVersionRecord[] {
  return list.slice(offset, offset + Math.max(pageSize, 1))
}

/** True when more pages may exist beyond the loaded window. */
export function hasMoreVersions(loadedCount: number, total: number): boolean {
  return loadedCount < Math.max(total, 0)
}

export type RestoreResult = {
  sourceVersion: number
  restored: DocumentVersionRecord
}

/**
 * Restore an earlier version as a NEW head (non-destructive). The caller is
 * responsible for reloading content + history afterwards.
 */
export async function restoreDocumentVersion(options: {
  apiClient: unknown
  fileId: string
  versionId: string
  chatId?: string
}): Promise<RestoreResult> {
  const { fileId, versionId, chatId } = options
  const client = fallbackApiClient(options.apiClient)

  let payload: unknown
  if (typeof client.restoreFileVersion === "function") {
    payload = await client.restoreFileVersion(fileId, versionId, chatId).catch((err: unknown) => {
      throw asError(err, "No se pudo restaurar la versión")
    })
  } else if (typeof client.request === "function") {
    payload = await client
      .request(`/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}/restore`, {
        method: "POST",
        body: JSON.stringify(chatId ? { chatId } : {}),
      })
      .catch((err: unknown) => {
        throw asError(err, "No se pudo restaurar la versión")
      })
  } else {
    throw new Error("No se pudo restaurar la versión")
  }

  const record = (payload ?? {}) as Record<string, unknown>
  const restoredRaw = (record.version ?? {}) as Record<string, unknown>
  if (!restoredRaw || typeof restoredRaw !== "object" || restoredRaw.id === undefined) {
    throw new Error("La respuesta de restauración no es válida")
  }
  return {
    sourceVersion: Number(record.sourceVersion ?? 0),
    restored: {
      id: String(restoredRaw.id),
      version: Number(restoredRaw.version ?? 0),
      filename: String(restoredRaw.filename ?? "documento"),
      summary: typeof restoredRaw.summary === "string" ? restoredRaw.summary : null,
      validationPassed: restoredRaw.validationPassed !== false,
      createdAt: String(restoredRaw.createdAt ?? new Date().toISOString()),
      editPlanType: "restore",
      createdByChatId: chatId ?? null,
      hasContent: false,
      downloadUrl: typeof restoredRaw.downloadUrl === "string" ? restoredRaw.downloadUrl : null,
    },
  }
}

// ---------------------------------------------------------------------------
// Draft invalidation (localStorage)
// ---------------------------------------------------------------------------

// The autosave front stores editor drafts under this prefix keyed by
// (userId, fileId): `sira:doc-draft:<userId|__anon__>:<fileId>`. Restoring an
// older version makes any surviving draft stale, so after a successful restore
// we drop every draft entry pointing at the same fileId regardless of user scope.
const DOC_DRAFT_PREFIX = "sira:doc-draft:"

/** Remove the localStorage draft for this fileId (best-effort, never throws). */
export function clearDocumentDraft(fileId: string): void {
  if (typeof window === "undefined" || !fileId) return
  try {
    const toRemove: string[] = []
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (!key || !key.startsWith(DOC_DRAFT_PREFIX)) continue
      // Key shape: sira:doc-draft:<userId>:<fileId> — match on the trailing
      // segment so any user scope for THIS file is invalidated.
      const tail = key.slice(DOC_DRAFT_PREFIX.length)
      const separator = tail.lastIndexOf(":")
      if ((separator >= 0 ? tail.slice(separator + 1) : tail) === fileId) toRemove.push(key)
    }
    for (const key of toRemove) window.localStorage.removeItem(key)
  } catch {
    /* private mode / quota — best-effort only */
  }
}

// ---------------------------------------------------------------------------
// Line diff (LCS) — read-only comparison between a historical version and the
// current content. ~80 lines of textbook dynamic programming, no dependency:
// documents here can reach thousands of lines but not millions, and O(n*m)
// with short rows collapses to fine interactive performance. Inputs are
// hard-capped defensively below.
// ---------------------------------------------------------------------------

const MAX_DIFF_LINES = 20_000
const MAX_DIFF_CELLS = 4_000_000

export type DiffLineType = "equal" | "added" | "removed"

export type DiffLine = {
  type: DiffLineType
  text: string
}

/** Split into lines normalizing CRLF, like contentToMarkdown does upstream. */
function splitLines(text: string): string[] {
  return String(text ?? "").replace(/\r\n?/g, "\n").split("\n")
}

/**
 * LCS line diff of `oldText` → `newText`. Removed lines come from oldText,
 * added lines from newText, equal lines are shared context.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  if (a.length > MAX_DIFF_LINES) a.length = MAX_DIFF_LINES
  if (b.length > MAX_DIFF_LINES) b.length = MAX_DIFF_LINES

  const n = a.length
  const m = b.length
  // Degenerate cases first (also keeps the DP table allocation honest).
  if (n === 0 && m === 0) return []
  if (n === 0) return b.map((text) => ({ type: "added" as const, text }))
  if (m === 0) return a.map((text) => ({ type: "removed" as const, text }))
  if (n * m > MAX_DIFF_CELLS) {
    // Extremely large pair — fall back to a coarse block-level diff instead
    // of freezing the tab.
    return [
      ...a.map((text) => ({ type: "removed" as const, text })),
      ...b.map((text) => ({ type: "added" as const, text })),
    ]
  }

  // LCS length table (row-major), Uint32 keeps a 2000×2000 diff at ~16 MB max.
  const width = m + 1
  const table = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }

  // Walk the table to emit the unified sequence.
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "equal", text: a[i] })
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      out.push({ type: "removed", text: a[i] })
      i += 1
    } else {
      out.push({ type: "added", text: b[j] })
      j += 1
    }
  }
  while (i < n) {
    out.push({ type: "removed", text: a[i] })
    i += 1
  }
  while (j < m) {
    out.push({ type: "added", text: b[j] })
    j += 1
  }
  return out
}

export type DiffStats = { additions: number; deletions: number }

export function diffStats(lines: DiffLine[]): DiffStats {
  let additions = 0
  let deletions = 0
  for (const line of lines) {
    if (line.type === "added") additions += 1
    else if (line.type === "removed") deletions += 1
  }
  return { additions, deletions }
}

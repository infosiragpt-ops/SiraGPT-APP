/**
 * Canonical identity for the /code workspace.
 *
 * Cloud Project ids are Prisma CUIDs (and older data can contain UUIDs), while
 * the sidebar and chat-session store use `project:<id>`. Local folders keep
 * their `local:` namespace. Direct CodexProject workspaces use `codex:<id>` so
 * they cannot be mistaken for the separate Project model. Unknown legacy
 * workspace keys are preserved so a migration never strands existing browser
 * sessions.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CUID_RE = /^c[a-z0-9]{20,}$/i

export function isLocalCodexWorkspaceId(value: string | null | undefined): boolean {
  return String(value || "").trim().startsWith("local:")
}

export function codexProjectIdFromWorkspaceId(
  value: string | null | undefined,
  options?: { assumeProject?: boolean },
): string | null {
  const raw = String(value || "").trim()
  if (!raw || isLocalCodexWorkspaceId(raw) || raw.startsWith("codex:")) return null
  if (raw.startsWith("project:")) return raw.slice("project:".length).trim() || null
  if (options?.assumeProject || UUID_RE.test(raw) || CUID_RE.test(raw)) return raw
  return null
}

export function codexWorkspaceIdForProject(projectId: string | null | undefined): string | null {
  const id = codexProjectIdFromWorkspaceId(projectId, { assumeProject: true })
  return id ? `project:${id}` : null
}

/**
 * Treat a raw Project id and its canonical `project:` workspace id as the same
 * owner. Local folders and direct `codex:` workspaces only match exactly.
 */
export function isSameCodexWorkspace(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftId = String(left || "").trim()
  const rightId = String(right || "").trim()
  if (!leftId || !rightId) return false
  if (leftId === rightId) return true

  const leftProjectId = codexProjectIdFromWorkspaceId(leftId, { assumeProject: true })
  const rightProjectId = codexProjectIdFromWorkspaceId(rightId, { assumeProject: true })
  return Boolean(leftProjectId && rightProjectId && leftProjectId === rightProjectId)
}

export function canonicalCodexWorkspaceId(
  value: string | null | undefined,
  options?: { kind?: "local-folder" | "project" },
): string {
  const raw = String(value || "").trim()
  if (!raw) return "__default__"
  if (options?.kind === "local-folder" || isLocalCodexWorkspaceId(raw)) return raw
  if (raw.startsWith("codex:")) return raw
  if (options?.kind === "project") return codexWorkspaceIdForProject(raw) || "__default__"
  const projectId = codexProjectIdFromWorkspaceId(raw)
  return projectId ? `project:${projectId}` : raw
}


/** OLA200_WAVE_G FE-056 — stable per-workspace tab lock; two tabs cannot both own writes. */
const TAB_LOCK_PREFIX = "siragpt:ws-lock:"
export function workspaceTabLockKey(workspaceId: string | null | undefined): string {
  return TAB_LOCK_PREFIX + canonicalCodexWorkspaceId(workspaceId)
}
export function claimWorkspaceTabLock(workspaceId: string | null | undefined, ownerId: string, now = Date.now(), ttlMs = 15000, storage?: Pick<Storage, "getItem" | "setItem"> | null): boolean {
  const store = storage ?? (typeof globalThis !== "undefined" && "localStorage" in globalThis ? (globalThis.localStorage as Storage) : null)
  if (!store || !ownerId) return true
  const key = workspaceTabLockKey(workspaceId)
  try {
    const raw = store.getItem(key)
    if (raw) { const parsed = JSON.parse(raw) as { ownerId?: string; until?: number }; if (parsed.ownerId && parsed.ownerId !== ownerId && Number(parsed.until) > now) return false }
    store.setItem(key, JSON.stringify({ ownerId, until: now + ttlMs }))
    return true
  } catch { return true }
}
export function releaseWorkspaceTabLock(workspaceId: string | null | undefined, ownerId: string, storage?: Pick<Storage, "getItem" | "removeItem"> | null): void {
  const store = storage ?? (typeof globalThis !== "undefined" && "localStorage" in globalThis ? (globalThis.localStorage as Storage) : null)
  if (!store) return
  const key = workspaceTabLockKey(workspaceId)
  try { const raw = store.getItem(key); if (!raw) return; const parsed = JSON.parse(raw) as { ownerId?: string }; if (parsed.ownerId === ownerId) store.removeItem(key) } catch { /* ignore */ }
}


export function desktopRuntimeProjectId(value: string | null | undefined): string | null {
  const raw = String(value || "").trim()
  if (!raw) return null
  if (raw.startsWith("codex:")) return raw.slice("codex:".length).trim() || null
  if (isLocalCodexWorkspaceId(raw)) return null
  return codexProjectIdFromWorkspaceId(raw, { assumeProject: true })
}

export function readStoredWorkspaceProjectId(): string | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem("code-workspace:active-folder")
    if (!raw) return null
    const parsed = JSON.parse(raw) as { id?: unknown }
    return desktopRuntimeProjectId(typeof parsed?.id === "string" ? parsed.id : null)
  } catch {
    return null
  }
}

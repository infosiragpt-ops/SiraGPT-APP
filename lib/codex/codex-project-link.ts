"use client"

const SESSION_PROJECT_PREFIX = "siragpt:codex-project:"
const WORKSPACE_PROJECT_PREFIX = "siragpt:codex-workspace-project:"

function readLink(prefix: string, key: string | null | undefined): string | null {
  if (typeof window === "undefined" || !key) return null
  try {
    const value = window.localStorage.getItem(`${prefix}${key}`)?.trim()
    return value || null
  } catch {
    return null
  }
}

function writeLink(prefix: string, key: string | null | undefined, projectId: string): void {
  if (typeof window === "undefined" || !key || !projectId.trim()) return
  try {
    window.localStorage.setItem(`${prefix}${key}`, projectId.trim())
  } catch {
    // The in-memory project ref still covers the current tab when storage is unavailable.
  }
}

function clearLink(prefix: string, key: string | null | undefined): void {
  if (typeof window === "undefined" || !key) return
  try {
    window.localStorage.removeItem(`${prefix}${key}`)
  } catch {
    // Storage can be disabled; there is nothing else to clear.
  }
}

export function readSessionCodexProject(sessionId: string | null | undefined): string | null {
  return readLink(SESSION_PROJECT_PREFIX, sessionId)
}

export function persistSessionCodexProject(
  sessionId: string | null | undefined,
  projectId: string,
): void {
  writeLink(SESSION_PROJECT_PREFIX, sessionId, projectId)
}

export function clearSessionCodexProject(sessionId: string | null | undefined): void {
  clearLink(SESSION_PROJECT_PREFIX, sessionId)
}

export function readWorkspaceCodexProject(workspaceId: string | null | undefined): string | null {
  return readLink(WORKSPACE_PROJECT_PREFIX, workspaceId)
}

export function persistWorkspaceCodexProject(
  workspaceId: string | null | undefined,
  projectId: string,
): void {
  writeLink(WORKSPACE_PROJECT_PREFIX, workspaceId, projectId)
}

export function clearWorkspaceCodexProject(workspaceId: string | null | undefined): void {
  clearLink(WORKSPACE_PROJECT_PREFIX, workspaceId)
}

export function linkedCodexProject({
  sessionId,
  workspaceId,
}: {
  sessionId?: string | null
  workspaceId?: string | null
}): string | null {
  return readWorkspaceCodexProject(workspaceId) || readSessionCodexProject(sessionId)
}

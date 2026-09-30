export const CODING_WORKSPACE_READY_EVENT = "siragpt:coding-workspace-ready"

export interface CodingWorkspacePayload {
  chatId: string
  projectId: string
  projectName: string
  repositoryUrl?: string | null
}

export interface CodingWorkspaceReadyDetail extends CodingWorkspacePayload {
  userId: string
}

/** The binding comes from the authenticated server, never from a mode toggle. */
export function parseCodingWorkspacePayload(value: unknown): CodingWorkspacePayload | null {
  if (!value || typeof value !== "object") return null
  const input = value as Record<string, unknown>
  const chatId = typeof input.chatId === "string" ? input.chatId.trim() : ""
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : ""
  const projectName = typeof input.projectName === "string" ? input.projectName.trim() : ""
  if (!chatId || !projectId || !projectName) return null
  return { chatId, projectId, projectName, ...(typeof input.repositoryUrl === "string" ? { repositoryUrl: input.repositoryUrl } : {}) }
}

export function emitCodingWorkspaceReady(value: unknown, userId: string, chatId: string): boolean {
  const payload = parseCodingWorkspacePayload(value)
  if (!payload || !userId || payload.chatId !== chatId) return false
  if (typeof window === "undefined") return false
  window.dispatchEvent(new CustomEvent<CodingWorkspaceReadyDetail>(CODING_WORKSPACE_READY_EVENT, {
    detail: { ...payload, userId },
  }))
  return true
}

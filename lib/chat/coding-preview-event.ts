/** A ready signal carries identity only. The iframe URL comes from the owned status API. */
export const CODING_PREVIEW_READY_EVENT = "siragpt:coding-preview-ready"
export type CodingPreviewPayload = { chatId: string; projectId: string }
export type CodingPreviewDetail = CodingPreviewPayload & { userId: string }

export function parseCodingPreviewPayload(value: unknown): CodingPreviewPayload | null {
  if (!value || typeof value !== "object") return null
  const input = value as Record<string, unknown>
  const chatId = typeof input.chatId === "string" ? input.chatId.trim() : ""
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : ""
  return chatId && projectId ? { chatId, projectId } : null
}

export function emitCodingPreviewReady(value: unknown, userId: string, chatId: string): boolean {
  const payload = parseCodingPreviewPayload(value)
  if (!payload || !userId || payload.chatId !== chatId || typeof window === "undefined") return false
  window.dispatchEvent(new CustomEvent<CodingPreviewDetail>(CODING_PREVIEW_READY_EVENT, { detail: { ...payload, userId } }))
  return true
}

/** Never use runner localhost URLs or model-supplied links in the app iframe. */
export function readyCodingPreviewPath(value: unknown, projectId: string): string | null {
  if (!value || typeof value !== "object" || !projectId) return null
  const input = value as Record<string, unknown>
  const state = input.previewStatus && typeof input.previewStatus === "object"
    ? input.previewStatus as Record<string, unknown> : input
  if (state.ready !== true || state.running !== true || state.project !== projectId) return null
  const base = typeof state.basePath === "string" ? state.basePath : typeof input.basePath === "string" ? input.basePath : ""
  const prefix = `/api/codex/projects/${encodeURIComponent(projectId)}/preview/`
  if (!base.startsWith(prefix) || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\/app\/?$/.test(base.slice(prefix.length))) return null
  return state.framework === "next" ? base.replace(/\/$/, "") : base
}

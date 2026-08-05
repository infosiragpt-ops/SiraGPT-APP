type RenderableChatMessage = {
  role?: unknown
  content?: unknown
  files?: unknown
  error?: unknown
  progressStage?: unknown
}

function asRenderableMessage(message: unknown): RenderableChatMessage | null {
  return message && typeof message === "object" ? message as RenderableChatMessage : null
}

export function parseMessageFilesForRender(files: unknown): unknown[] {
  if (!files) return []
  if (Array.isArray(files)) return files
  if (typeof files !== "string") return []

  try {
    const parsed: unknown = JSON.parse(files)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function hasMessageTextForRender(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0
  if (content == null) return false
  return String(content).trim().length > 0
}

export function shouldRenderChatMessage(
  message: unknown,
  allowEmptyStreamingAssistant = false,
): boolean {
  const candidate = asRenderableMessage(message)
  if (!candidate) return false

  const role = String(candidate.role || "").toUpperCase()
  if (role === "USER") return true
  if (candidate.error || candidate.progressStage) return true
  if (hasMessageTextForRender(candidate.content)) return true
  if (parseMessageFilesForRender(candidate.files).length > 0) return true
  return allowEmptyStreamingAssistant && role === "ASSISTANT"
}

export function isAssistantMessage(message: unknown): boolean {
  const candidate = asRenderableMessage(message)
  return String(candidate?.role || "").toUpperCase() === "ASSISTANT"
}

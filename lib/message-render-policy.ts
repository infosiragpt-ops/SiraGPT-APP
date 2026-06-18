export type RenderPolicyMessage = {
  role?: unknown
  content?: unknown
}

const asText = (value: unknown) =>
  typeof value === "string" ? value : value == null ? "" : String(value)

const hasVisibleText = (value: unknown) => asText(value).trim().length > 0

const isAssistantImageUrl = (message: RenderPolicyMessage) => {
  const content = asText(message.content)
  return String(message.role || "").toUpperCase() === "ASSISTANT"
    && /^https?:\/\//i.test(content)
    && (
      content.includes("oaidalleapiprodscus")
      || content.includes("dalle")
      || content.includes("/api/images/")
    )
}

const normalizeImageUrlPath = (value: unknown) => {
  const text = asText(value).trim()
  if (!text || /^data:/i.test(text)) return ""
  try {
    return new URL(text, "http://siragpt.local").pathname
  } catch {
    return text.replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/)[0]
  }
}

const isImageAttachment = (file: unknown) => {
  const f = (file ?? {}) as Record<string, unknown>
  const mimeType = String(f.mimeType || f.contentType || "").toLowerCase()
  const name = String(f.originalName || f.name || f.filename || "").toLowerCase()
  const extension = name.includes(".") ? name.split(".").pop() || "" : ""
  return f.type === "image"
    || mimeType.startsWith("image/")
    || ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "heif"].includes(extension)
}

const isAssistantImageAttachmentUrl = (
  message: RenderPolicyMessage,
  parsedFiles: unknown[],
) => {
  if (String(message.role || "").toUpperCase() !== "ASSISTANT") return false
  if (!Array.isArray(parsedFiles) || !parsedFiles.some(isImageAttachment)) return false

  const contentPath = normalizeImageUrlPath(message.content)
  if (!contentPath) return false

  return parsedFiles.some((file) => {
    if (!isImageAttachment(file)) return false
    const f = (file ?? {}) as Record<string, unknown>
    return [f.url, f.imageUrl, f.path]
      .map(normalizeImageUrlPath)
      .some((candidate) => candidate === contentPath)
  })
}

export function isImageOnlyMessageForRender(
  message: RenderPolicyMessage,
  parsedFiles: unknown[] = [],
) {
  if (isAssistantImageUrl(message)) return true
  if (isAssistantImageAttachmentUrl(message, parsedFiles)) return true
  if (!Array.isArray(parsedFiles) || !parsedFiles.some(isImageAttachment)) return false

  // Critical UI contract: a user turn with an image AND text is not image-only.
  // The text is the instruction ("transcribir", "analiza esto", etc.) and must
  // stay visible after streaming, editing, reloads and backend refreshes.
  return !hasVisibleText(message.content)
}

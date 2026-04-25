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

const isImageAttachment = (file: any) => {
  const mimeType = String(file?.mimeType || file?.contentType || "").toLowerCase()
  const name = String(file?.originalName || file?.name || file?.filename || "").toLowerCase()
  const extension = name.includes(".") ? name.split(".").pop() || "" : ""
  return file?.type === "image"
    || mimeType.startsWith("image/")
    || ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "heif"].includes(extension)
}

export function isImageOnlyMessageForRender(
  message: RenderPolicyMessage,
  parsedFiles: any[] = [],
) {
  if (isAssistantImageUrl(message)) return true
  if (!Array.isArray(parsedFiles) || !parsedFiles.some(isImageAttachment)) return false

  // Critical UI contract: a user turn with an image AND text is not image-only.
  // The text is the instruction ("transcribir", "analiza esto", etc.) and must
  // stay visible after streaming, editing, reloads and backend refreshes.
  return !hasVisibleText(message.content)
}

/**
 * Decide what the /ai/generate SSE client does when the socket is empty
 * or already finished. [DONE] is emitted AFTER persist, so a contentless
 * [DONE] must not spend the 3–4 minute reconnect budget.
 *
 * CSRF first-byte reconnect and mid-stream resume WITH a cursor stay on
 * `retry`. Fail-closed 503 / connection_unavailable never reach here.
 */

export type EmptyGenerateStreamAction = "recover" | "close" | "retry"

export function decideEmptyGenerateStreamAction(options: {
  seenDone?: boolean
  hasDeliveredAnyContent?: boolean
  persistedAssistant?: boolean | null
  hasResumeCursor?: boolean
}): EmptyGenerateStreamAction {
  if (options.hasDeliveredAnyContent) return "close"
  if (options.persistedAssistant === true) return "recover"
  if (options.seenDone) return "close"
  if (options.hasResumeCursor) return "retry"
  return "retry"
}

export function shouldPollPersistedTurnOnStreamClose(options: {
  deliveredContent?: string | null
  seenDone?: boolean
  streamFailed?: boolean
}): boolean {
  if (options.streamFailed) return false
  const content = String(options.deliveredContent || "").trim()
  if (content) return false
  return true
}

export function createChatAbortError(): Error {
  const error = new Error("Request aborted")
  error.name = "AbortError"
  return error
}

export function throwIfChatTurnCancelled(
  signal: AbortSignal,
  isPendingStop: () => boolean = () => false,
): void {
  if (!signal.aborted && !isPendingStop()) return
  throw createChatAbortError()
}

/**
 * Fence a slow preparation step on both sides of its await. Stop may arrive
 * after the server accepted a delete/edit but before its response reaches the
 * browser; the second fence guarantees that no generation is started then.
 */
export async function awaitCancellableChatStep<T>({
  signal,
  isPendingStop,
  run,
}: {
  signal: AbortSignal
  isPendingStop?: () => boolean
  run: () => Promise<T>
}): Promise<T> {
  const pendingStop = isPendingStop || (() => false)
  throwIfChatTurnCancelled(signal, pendingStop)
  const value = await run()
  throwIfChatTurnCancelled(signal, pendingStop)
  return value
}


export async function notifyChatTurnStopped(streamId?: string | null): Promise<void> {
  if (typeof window === "undefined") return
  try {
    const { authenticatedFetch } = await import("../authenticated-fetch")
    const { stopStreamHeaders } = await import("../sse-client")
    await authenticatedFetch("/api/ai/stop-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...stopStreamHeaders() },
      body: JSON.stringify({ streamId: streamId || undefined }),
    })
  } catch {
    /* best-effort */
  }
}

const pendingStops = new Set<string>()

export function markPendingStop(chatId?: string | null): void {
  const id = String(chatId || "").trim()
  if (id) pendingStops.add(id)
}

export function clearPendingStop(chatId?: string | null): void {
  const id = String(chatId || "").trim()
  if (id) pendingStops.delete(id)
  else pendingStops.clear()
}

export function isPendingStopFor(chatId?: string | null): boolean {
  const id = String(chatId || "").trim()
  return Boolean(id && pendingStops.has(id))
}

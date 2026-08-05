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

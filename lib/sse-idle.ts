/**
 * Generate SSE must not wait forever on a half-open socket.
 * Server pings every 5s; if no bytes arrive for GENERATE_STREAM_IDLE_MS,
 * treat it as a transport stall and reconnect / recover the persisted turn.
 */

export const GENERATE_STREAM_CONNECT_MS = 20_000
export const GENERATE_STREAM_IDLE_MS = 20_000

export function createGenerateStreamStallError(kind: "idle" | "connect"): Error {
  const error = new Error(kind === "connect" ? "Stream connect timeout" : "Stream stalled")
  error.name = "TimeoutError"
  ;(error as { code?: string }).code = kind === "connect" ? "stream_connect_timeout" : "stream_stall"
  return error
}

export function isGenerateStreamStall(
  error: { name?: string; message?: string; code?: string } | null | undefined,
): boolean {
  const text = [error?.message, error?.name, error?.code].filter(Boolean).join(" ")
  return /stream stalled|stream_stall|stream connect timeout|stream_connect_timeout/i.test(text)
}

export async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  options: { ms: number; signal?: AbortSignal | null; createError: () => Error },
): Promise<T> {
  const local = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    local.abort()
  }, options.ms)
  const onUserAbort = () => local.abort()
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer)
      const cancelled = new Error("Request aborted")
      cancelled.name = "AbortError"
      throw cancelled
    }
    options.signal.addEventListener("abort", onUserAbort, { once: true })
  }
  try {
    return await work(local.signal)
  } catch (err) {
    if (options.signal?.aborted) throw err
    if (timedOut) throw options.createError()
    throw err
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", onUserAbort)
  }
}

export async function readWithIdle<T>(
  read: () => Promise<T>,
  options: { idleMs: number; signal?: AbortSignal | null },
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(createGenerateStreamStallError("idle"))
    }, options.idleMs)

    const onAbort = () => {
      clearTimeout(timer)
      const cancelled = new Error("Request aborted")
      cancelled.name = "AbortError"
      reject(cancelled)
    }

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener("abort", onAbort, { once: true })
    }

    Promise.resolve()
      .then(read)
      .then((value) => {
        clearTimeout(timer)
        options.signal?.removeEventListener("abort", onAbort)
        resolve(value)
      })
      .catch((err) => {
        clearTimeout(timer)
        options.signal?.removeEventListener("abort", onAbort)
        reject(err)
      })
  })
}

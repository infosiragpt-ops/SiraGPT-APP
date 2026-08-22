import {
  createParser,
  type EventSourceMessage,
  type ParseError,
} from "eventsource-parser"

export interface ParsedSseJsonEvent<T> {
  data: T
  event?: string
  id?: string
}

export interface SseJsonParserOptions<T> {
  ignoreDoneMessage?: boolean
  onDoneMessage?: () => void
  onMalformedMessage?: (rawData: string, error: unknown, message: EventSourceMessage) => void
  onParserError?: (error: ParseError) => void
}

export interface StreamSseJsonOptions<T> extends SseJsonParserOptions<T> {
  signal?: AbortSignal
  stopOnDoneMessage?: boolean
  onChunk?: () => void
  /**
   * Fired when the underlying stream closes WITHOUT a `[DONE]` sentinel and
   * without an explicit in-band error — i.e. the connection was cut mid-
   * response (flaky network, proxy timeout, laptop sleep). Consumers use this
   * to drive resume/retry UX instead of silently keeping a truncated answer.
   */
  onStreamCutShort?: () => void
}

export function createSseJsonParser<T = unknown>(
  options: SseJsonParserOptions<T> = {},
) {
  const ignoreDoneMessage = options.ignoreDoneMessage !== false
  let queue: Array<ParsedSseJsonEvent<T>> = []

  const parser = createParser({
    onEvent(message) {
      const rawData = message.data
      if (!rawData) return
      if (ignoreDoneMessage && rawData.trim() === "[DONE]") {
        options.onDoneMessage?.()
        return
      }

      try {
        queue.push({
          data: JSON.parse(rawData) as T,
          event: message.event,
          id: message.id,
        })
      } catch (error) {
        options.onMalformedMessage?.(rawData, error, message)
      }
    },
    onError(error) {
      options.onParserError?.(error)
    },
  })

  return {
    feed(chunk: string): Array<ParsedSseJsonEvent<T>> {
      parser.feed(chunk)
      const parsed = queue
      queue = []
      return parsed
    },
    reset(opts?: { consume?: boolean }) {
      parser.reset(opts)
      queue = []
    },
  }
}

export async function* streamSseJson<T = unknown>(
  body: ReadableStream<Uint8Array>,
  options: StreamSseJsonOptions<T> = {},
): AsyncGenerator<T> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let doneMessageSeen = false
  const parser = createSseJsonParser<T>({
    ...options,
    onDoneMessage() {
      doneMessageSeen = true
      options.onDoneMessage?.()
    },
  })
  const abortReader = () => {
    try {
      reader.cancel(options.signal?.reason ?? "aborted").catch(() => {})
    } catch {
      /* noop */
    }
  }

  if (options.signal) {
    if (options.signal.aborted) abortReader()
    else options.signal.addEventListener("abort", abortReader, { once: true })
  }

  let streamCutShort = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      options.onChunk?.()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      for (const event of parser.feed(chunk)) {
        yield event.data
      }
      if (doneMessageSeen && options.stopOnDoneMessage) {
        try {
          await reader.cancel("done")
        } catch {
          /* noop */
        }
        break
      }
    }

    const trailing = decoder.decode()
    if (trailing) {
      for (const event of parser.feed(trailing)) {
        yield event.data
      }
    }
    // Anomalous end: the socket closed cleanly from the reader's point of
    // view but the server never sent the `[DONE]` terminator. The answer is
    // truncated — surface it so the consumer can resume instead of leaving
    // the user with a silently cut-off reply.
    if (!doneMessageSeen && !options.signal?.aborted) {
      streamCutShort = true
      options.onStreamCutShort?.()
    }
  } finally {
    if (options.signal) options.signal.removeEventListener("abort", abortReader)
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
  }
  return streamCutShort
}

/**
 * Pure retry decision for a cut-off SSE chat stream. Kept free of I/O and
 * framework deps so vitest can pin the policy:
 *
 *   - A user abort is never retried.
 *   - A stream that ended with the `[DONE]` sentinel (or an in-band error
 *     frame) completed normally — no retry, no partial-recovery UX.
 *   - A stream cut short mid-answer is retried while attempts remain
 *     (`attempt` is 1-based); once exhausted the caller must show the
 *     honest "connection lost" state with manual actions.
 */
export interface SseRetryDecisionInput {
  /** 1-based index of the attempt that just failed. */
  attempt: number
  /** Total attempts allowed (initial try included). */
  maxAttempts: number
  /** The socket closed before `[DONE]`. */
  cutShort: boolean
  /** User pressed Stop — always wins. */
  aborted?: boolean
}

export type SseRetryDecision =
  | { action: "retry"; nextAttempt: number; delayMs: number }
  | { action: "give_up" }
  | { action: "completed" }

export const SSE_RETRY_DELAYS_MS = [1000, 3000] as const

export function decideSseStreamRetry(input: SseRetryDecisionInput): SseRetryDecision {
  const { attempt, maxAttempts, cutShort, aborted } = input
  if (aborted) return { action: "give_up" }
  if (!cutShort) return { action: "completed" }
  if (attempt >= maxAttempts) return { action: "give_up" }
  const nextAttempt = attempt + 1
  const delayMs = SSE_RETRY_DELAYS_MS[Math.min(attempt - 1, SSE_RETRY_DELAYS_MS.length - 1)]
  return { action: "retry", nextAttempt, delayMs }
}

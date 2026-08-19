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
  } finally {
    if (options.signal) options.signal.removeEventListener("abort", abortReader)
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
  }
}

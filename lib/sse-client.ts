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
  onEventId?: (id: string) => void
}

export function fetchResumeHeaders(lastEventId?: string | null): Record<string, string> {
  const id = String(lastEventId || "").trim()
  return id ? { "Last-Event-ID": id } : {}
}

/** 3H5-FE — fresh POST generate: never-cache; do not send Last-Event-ID (new run). */
export function freshGenerateHeaders(): Record<string, string> {
  return { "Cache-Control": "no-store" }
}

/** 3H5-FE leftover candado: clamp leftover OpenRouter/gpt-4o ids to DeepSeek Flash/Pro. */
export function clampDeepSeekModel(model?: string | null): string | undefined {
  const raw = String(model || "").trim()
  if (!raw) return undefined
  const bare = (raw.includes("/") ? raw.split("/").pop() : raw)!.toLowerCase()
  if (bare.includes("pro") && !bare.includes("flash")) return "deepseek-v4-pro"
  return "deepseek-v4-flash"
}

export function appendLastEventId(url: string, lastEventId?: string | null, param = "lastEventId"): string {
  const id = String(lastEventId || "").trim()
  if (!id) return url
  try {
    const u = new URL(url, typeof window !== "undefined" ? window.location.origin : "http://localhost")
    if (!u.searchParams.has(param)) u.searchParams.set(param, id)
    return `${u.pathname}${u.search}${u.hash}`
  } catch {
    return url
  }
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
        if (event.id) options.onEventId?.(event.id)
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
        if (event.id) options.onEventId?.(event.id)
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


/** 3H-FE-005/006 — Last-Event-ID for remaining agent-task and code/codex streams. */
export function agentTaskResumeHeaders(lastEventId?: string | null): Record<string, string> {
  return fetchResumeHeaders(lastEventId)
}
export function codeStreamResumeHeaders(lastEventId?: string | null): Record<string, string> {
  return fetchResumeHeaders(lastEventId)
}
export function persistLastEventId(storageKey: string, eventId: string | null | undefined): void {
  if (typeof sessionStorage === "undefined" || !eventId) return
  try { sessionStorage.setItem(storageKey, String(eventId)) } catch { /* quota */ }
}
export function readLastEventId(storageKey: string): string | null {
  if (typeof sessionStorage === "undefined") return null
  try { return sessionStorage.getItem(storageKey) } catch { return null }
}


/** 3H2-FE-002 leftover Last-Event-ID for remaining /chat /code generate streams. */
export function docStreamResumeHeaders(lastEventId?: string | null): Record<string, string> {
  return fetchResumeHeaders(lastEventId)
}
export function searchStreamResumeHeaders(lastEventId?: string | null): Record<string, string> {
  return fetchResumeHeaders(lastEventId)
}
export function uploadProgressResumeHeaders(lastEventId?: string | null): Record<string, string> {
  return fetchResumeHeaders(lastEventId)
}
export function gatewayAbortHeaders(): Record<string, string> {
  return { "Cache-Control": "no-store" }
}


/** 3H3-FE-002 leftover Last-Event-ID for remaining /chat /code streams. */
export function answerStreamResumeHeaders(lastEventId?: string | null): Record<string, string> {
  return fetchResumeHeaders(lastEventId)
}
export function mathStreamResumeHeaders(lastEventId?: string | null): Record<string, string> {
  return fetchResumeHeaders(lastEventId)
}
export function researchStreamResumeHeaders(lastEventId?: string | null): Record<string, string> {
  return fetchResumeHeaders(lastEventId)
}
export function goalsStreamResumeHeaders(lastEventId?: string | null): Record<string, string> {
  return fetchResumeHeaders(lastEventId)
}
export function planStreamResumeHeaders(lastEventId?: string | null): Record<string, string> {
  return fetchResumeHeaders(lastEventId)
}
export function artifactStreamResumeHeaders(lastEventId?: string | null): Record<string, string> {
  return fetchResumeHeaders(lastEventId)
}
export function voiceStreamResumeHeaders(lastEventId?: string | null): Record<string, string> {
  return fetchResumeHeaders(lastEventId)
}
export function docAgentStreamResumeHeaders(lastEventId?: string | null): Record<string, string> {
  return fetchResumeHeaders(lastEventId)
}
export function stopStreamHeaders(): Record<string, string> {
  return { "Cache-Control": "no-store" }
}

/** 3H6-FE leftover: plan generate is a fresh POST — no Last-Event-ID, no-store, DeepSeek clamp. */
export function planGenerateHeaders(): Record<string, string> {
  return freshGenerateHeaders()
}


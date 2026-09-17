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

const FLASH = "deepseek-v4-flash"
const PRO = "deepseek-v4-pro"

/**
 * Leftover mixer / obsolete ids from older clients. Only these are remapped
 * to the DeepSeek pair — and only when they are NOT in the live catalog.
 *
 * User-selected Gemini / Claude / GPT / Kimi / Mini / Sira pair ids must
 * pass through unchanged so generate hits that row's own provider API.
 */
const LEFTOVER_OPENROUTER_RE = /^openrouter\//i
const OBSOLETE_LEFTOVER_RE =
  /^(gpt-4o(-mini)?|gpt-4\.1([.-].*)?|gpt-5|o1(-mini|-preview)?|o3(-mini)?|o4-mini)$/i

function bareModelName(raw: string): string {
  return (raw.includes("/") ? raw.split("/").pop() : raw)!.toLowerCase()
}

function normalizeCatalogId(name: string): string {
  return String(name || "").trim().toLowerCase()
}

/** First-party catalog families that must never be remapped to DeepSeek. */
export function isFirstPartyCatalogModel(model?: string | null): boolean {
  const raw = String(model || "").trim()
  if (!raw) return false
  const lower = raw.toLowerCase()
  const bare = bareModelName(lower)
  if (/sira[-_ ]?(gpt[-_ ]?)?mini|siragpt[-_ ]?mini|moondream/.test(lower)) return true
  if (/gemini/.test(lower) || lower.startsWith("google/")) return true
  if (/claude/.test(lower) || lower.startsWith("anthropic/")) return true
  if (/kimi|moonshot/.test(lower)) return true
  if (/terra/.test(lower) || /gpt-5\.\d/.test(lower)) return true
  if (/\bgrok\b/.test(lower) || lower.includes("x-ai/") || lower.includes("xai/")) return true
  if (bare === FLASH || bare === PRO) return true
  if (/^deepseek[-/_\s]?v?4[-/_\s]?(flash|pro)$/.test(bare)) return true
  return false
}

function isObsoleteLeftoverId(raw: string, bare: string): boolean {
  if (LEFTOVER_OPENROUTER_RE.test(raw)) return true
  return OBSOLETE_LEFTOVER_RE.test(bare) || OBSOLETE_LEFTOVER_RE.test(raw)
}

function catalogHasId(catalogNames: string[] | undefined, raw: string, bare: string): boolean {
  if (!Array.isArray(catalogNames) || catalogNames.length === 0) return false
  const wanted = new Set(catalogNames.map(normalizeCatalogId).filter(Boolean))
  return wanted.has(normalizeCatalogId(raw)) || wanted.has(bare)
}

/**
 * Clamp leftover OpenRouter / obsolete ids to DeepSeek Flash/Pro.
 * Catalog Gemini/Claude/GPT/Kimi/Mini ids pass through unchanged.
 */
export function clampDeepSeekModel(
  model?: string | null,
  catalogNames?: string[],
): string | undefined {
  const raw = String(model || "").trim()
  if (!raw) return undefined
  const lower = raw.toLowerCase()
  const bare = bareModelName(lower)
  if (bare === PRO || /^(deepseek[-/_\s]?v?4[-/_\s]?pro)$/i.test(bare)) return PRO
  if (bare === FLASH || /^(deepseek[-/_\s]?v?4[-/_\s]?flash)$/i.test(bare)) return FLASH
  if (isFirstPartyCatalogModel(raw)) return raw
  if (catalogHasId(catalogNames, raw, bare)) return raw
  if (isObsoleteLeftoverId(lower, bare)) {
    if (bare.includes("pro") && !bare.includes("flash")) return PRO
    return FLASH
  }
  return raw
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


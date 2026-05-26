/**
 * lib/sse-reconnect.ts
 *
 * Thin wrapper around the browser `EventSource` that adds:
 *
 *   • Exponential-backoff reconnects (default base 500 ms, factor 2)
 *   • Hard retry cap (default 5)
 *   • Last-Event-ID resume — the wrapper tracks `event.lastEventId`
 *     and appends it to the next reconnect URL so the server can
 *     resume the stream (consumers that do not implement
 *     `Last-Event-ID` semantics simply ignore it).
 *   • A `reconnecting` lifecycle hook so the UI can render a hint.
 *
 * The wrapper exposes the *same* surface area as a regular EventSource
 * (`onmessage`, `onerror`, `onopen`, `addEventListener`,
 * `removeEventListener`, `close`, `readyState`) so it can be dropped
 * in as a replacement.
 *
 * NOTE: For long-running streams that use POST bodies (e.g. the chat
 * /api/ai/generate stream, /api/research-agent/stream) the existing
 * fetch-based reader in `lib/sse-client.ts` is still the right tool.
 * This wrapper targets GET-based EventSource consumers.
 */

export type SseReconnectState = "connecting" | "open" | "reconnecting" | "closed"

export interface SseReconnectOptions {
  /** Initial reconnect delay in ms (default 500) */
  baseDelayMs?: number
  /** Cap for backoff in ms (default 15_000) */
  maxDelayMs?: number
  /** Backoff growth factor (default 2) */
  factor?: number
  /** Max reconnect attempts before giving up (default 5) */
  maxRetries?: number
  /** Forward to the underlying EventSource */
  withCredentials?: boolean
  /**
   * Query-param name used to forward `lastEventId` on reconnect. Set
   * to `null` to disable. Default: "lastEventId".
   */
  lastEventIdParam?: string | null
  /** Optional logger — defaults to console.debug in dev */
  log?: (msg: string, meta?: Record<string, unknown>) => void
  /** Called whenever the wrapper's state changes */
  onStateChange?: (state: SseReconnectState, info?: { attempt?: number; delay?: number }) => void
}

type Listener = (ev: MessageEvent) => void

export class ReconnectingEventSource {
  readonly url: string
  readonly options: SseReconnectOptions
  private es: EventSource | null = null
  private attempt = 0
  private lastEventId: string | null = null
  private listeners = new Map<string, Set<Listener>>()
  private state: SseReconnectState = "connecting"
  private closed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null

  constructor(url: string, options: SseReconnectOptions = {}) {
    this.url = url
    this.options = {
      baseDelayMs: 500,
      maxDelayMs: 15_000,
      factor: 2,
      maxRetries: 5,
      lastEventIdParam: "lastEventId",
      ...options,
    }
    this.connect()
  }

  get readyState(): number {
    if (this.closed) return 2 // CLOSED
    return this.es?.readyState ?? 0
  }

  get currentState(): SseReconnectState {
    return this.state
  }

  get retryAttempt(): number {
    return this.attempt
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
    this.es?.addEventListener(type, listener as EventListener)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
    this.es?.removeEventListener(type, listener as EventListener)
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    try { this.es?.close() } catch { /* noop */ }
    this.es = null
    this.setState("closed")
  }

  /** Build the URL for the next connect attempt, appending lastEventId */
  private buildUrl(): string {
    const param = this.options.lastEventIdParam
    if (!param || !this.lastEventId) return this.url
    try {
      const u = new URL(this.url, typeof window !== "undefined" ? window.location.origin : "http://localhost")
      // Only append if the server hasn't already set this param.
      if (!u.searchParams.has(param)) u.searchParams.set(param, this.lastEventId)
      // If url was relative, return the path+search to preserve relativity.
      if (/^https?:/i.test(this.url)) return u.toString()
      return u.pathname + (u.search || "") + (u.hash || "")
    } catch {
      const sep = this.url.includes("?") ? "&" : "?"
      return `${this.url}${sep}${encodeURIComponent(param)}=${encodeURIComponent(this.lastEventId)}`
    }
  }

  private setState(s: SseReconnectState, info?: { attempt?: number; delay?: number }) {
    if (this.state === s) return
    this.state = s
    try { this.options.onStateChange?.(s, info) } catch { /* noop */ }
  }

  private connect() {
    if (this.closed) return
    if (typeof EventSource === "undefined") {
      // Server-side or unsupported environment.
      this.setState("closed")
      return
    }

    const url = this.buildUrl()
    let es: EventSource
    try {
      es = new EventSource(url, { withCredentials: !!this.options.withCredentials })
    } catch (err) {
      this.options.log?.("EventSource constructor failed", { err: String(err) })
      this.scheduleReconnect()
      return
    }
    this.es = es

    // Re-attach custom listeners
    for (const [type, set] of this.listeners) {
      for (const l of set) es.addEventListener(type, l as EventListener)
    }

    es.onopen = (ev) => {
      this.attempt = 0
      this.setState("open")
      try { this.onopen?.(ev) } catch { /* noop */ }
    }

    es.onmessage = (ev) => {
      if (ev.lastEventId) this.lastEventId = ev.lastEventId
      try { this.onmessage?.(ev) } catch { /* noop */ }
    }

    es.onerror = (ev) => {
      try { this.onerror?.(ev) } catch { /* noop */ }
      // CONNECTING(0) means the browser is already retrying internally —
      // we still wrap it because we want capped retries.
      if (this.closed) return
      try { es.close() } catch { /* noop */ }
      this.es = null
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    if (this.closed) return
    if (this.attempt >= (this.options.maxRetries ?? 5)) {
      this.options.log?.("SSE max reconnect attempts reached", { url: this.url, attempt: this.attempt })
      this.close()
      return
    }
    this.attempt += 1
    const base = this.options.baseDelayMs ?? 500
    const factor = this.options.factor ?? 2
    const cap = this.options.maxDelayMs ?? 15_000
    const raw = base * Math.pow(factor, this.attempt - 1)
    // Full-jitter backoff: random [0, raw)
    const delay = Math.min(cap, Math.max(50, Math.floor(Math.random() * raw)))
    this.setState("reconnecting", { attempt: this.attempt, delay })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }
}

/**
 * Convenience factory mirroring `new EventSource(url, init)`.
 */
export function createReconnectingEventSource(
  url: string,
  options: SseReconnectOptions = {},
): ReconnectingEventSource {
  return new ReconnectingEventSource(url, options)
}

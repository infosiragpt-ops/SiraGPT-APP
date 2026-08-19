"use client"

import { safeUUID } from "./safe-uuid"

/**
 * RequestQueue — queues fetch requests when the backend is
 * unreachable and replays them when connectivity is restored.
 *
 * Each queued item is replayed at most once. On replay failure
 * the request is marked as failed and the original enqueue()
 * promise rejects so callers never hang silently.
 *
 * Usage:
 *   import { requestQueue } from "@/lib/request-queue"
 *
 *   const res = await requestQueue.enqueue(({ signal }) =>
 *     fetch("/api/...", { signal })
 *   )
 */

export type RequestQueueStatus = "queued" | "replaying" | "done" | "failed"
export type RequestQueuePhase = "immediate" | "replay"

export type RequestQueueExecutionContext = {
  signal: AbortSignal
  requestId: string
  phase: RequestQueuePhase
}

type RequestExecutor = (ctx?: RequestQueueExecutionContext) => Promise<Response>

export type QueuedRequest = {
  id: string
  status: RequestQueueStatus
  createdAt: number
  label?: string
  lastError?: string
}

type InternalQueuedRequest = QueuedRequest & {
  executor: RequestExecutor
  resolve: (value: Response) => void
  reject: (err: unknown) => void
  timeoutMs?: number
}

type QueueCallback = (queue: QueuedRequest[]) => void

export type RequestQueueOptions = {
  /** Initial connectivity state. Browser instances default to navigator.onLine. */
  initialOnline?: boolean
  /** Per-item replay timeout. Set 0 to disable. */
  replayTimeoutMs?: number
  /** Number of completed/failed items retained for diagnostics. */
  maxRetention?: number
}

type EnqueueOptions = {
  /** Override the default replay timeout for this request. */
  timeoutMs?: number
}

const DEFAULT_REPLAY_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RETENTION = 50

export class RequestQueueTimeoutError extends Error {
  readonly code = "REQUEST_QUEUE_TIMEOUT"
  readonly timeoutMs: number
  readonly requestId: string

  constructor(timeoutMs: number, requestId: string, label?: string) {
    super(`Queued request${label ? ` "${label}"` : ""} timed out after ${timeoutMs}ms`)
    this.name = "RequestQueueTimeoutError"
    this.timeoutMs = timeoutMs
    this.requestId = requestId
  }
}

export class RequestQueueCancelledError extends Error {
  readonly code = "REQUEST_QUEUE_CANCELLED"

  constructor(label?: string) {
    super(`Queued request${label ? ` "${label}"` : ""} was cancelled`)
    this.name = "RequestQueueCancelledError"
  }
}

class RequestQueue {
  private queue: InternalQueuedRequest[] = []
  private replaying = false
  private listeners = new Set<QueueCallback>()
  private online: boolean
  private readonly replayTimeoutMs: number
  private readonly maxRetention: number

  constructor(options: RequestQueueOptions = {}) {
    this.replayTimeoutMs = Math.max(0, options.replayTimeoutMs ?? DEFAULT_REPLAY_TIMEOUT_MS)
    this.maxRetention = Math.max(1, options.maxRetention ?? DEFAULT_MAX_RETENTION)
    this.online = options.initialOnline ?? (
      typeof navigator !== "undefined" && typeof navigator.onLine === "boolean"
        ? navigator.onLine
        : true
    )

    if (typeof window !== "undefined") {
      // Detect browser online/offline.
      window.addEventListener("online", () => this.setOnline(true))
      window.addEventListener("offline", () => this.setOnline(false))
    }
  }

  get length() {
    return this.queue.filter((r) => r.status === "queued").length
  }

  get items(): readonly QueuedRequest[] {
    return this.snapshot()
  }

  subscribe(cb: QueueCallback): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  setOnline(online: boolean, options: { flush?: boolean } = {}) {
    this.online = online
    this.notify()
    if (online && options.flush !== false) {
      void this.flush()
    }
  }

  private snapshot(): QueuedRequest[] {
    return this.queue.map((item) => ({
      id: item.id,
      status: item.status,
      createdAt: item.createdAt,
      label: item.label,
      lastError: item.lastError,
    }))
  }

  private notify() {
    const snapshot = this.snapshot()
    for (const cb of this.listeners) {
      try {
        cb(snapshot)
      } catch {
        // Swallow listener errors.
      }
    }
  }

  /**
   * Enqueue a request. Returns a promise that resolves when
   * the request completes (immediately if online, or later when
   * replayed).
   */
  enqueue(executor: RequestExecutor, label?: string, options: EnqueueOptions = {}): Promise<Response> {
    return new Promise((resolve, reject) => {
      const item: InternalQueuedRequest = {
        id: safeUUID(),
        executor,
        resolve,
        reject,
        status: "queued",
        createdAt: Date.now(),
        label,
        timeoutMs: options.timeoutMs,
      }

      // Try immediately if online. This keeps the old public behavior,
      // but now the caller's promise is settled through the same guarded
      // execution path used by offline replay.
      if (this.online) {
        item.status = "replaying"
        void this.executeItem(item, "immediate").catch(() => undefined)
        return
      }

      // Offline: queue it and settle the original promise from flush().
      this.queue.push(item)
      this.notify()
    })
  }

  /**
   * Replay all queued requests. Call this when connectivity
   * is restored.
   */
  async flush() {
    if (this.replaying || !this.online) return
    this.replaying = true

    try {
      const pending = this.queue.filter((r) => r.status === "queued")
      for (const item of pending) {
        item.status = "replaying"
        this.notify()
        try {
          await this.executeItem(item, "replay")
        } catch {
          // executeItem already marks the item failed and rejects the
          // original enqueue promise. Continue with the rest of the queue.
        }
        this.notify()
      }
    } finally {
      this.replaying = false
      this.prune()
      this.notify()
    }
  }

  private async executeItem(item: InternalQueuedRequest, phase: RequestQueuePhase): Promise<Response> {
    const timeoutMs = Math.max(0, item.timeoutMs ?? this.replayTimeoutMs)
    const controller = new AbortController()
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        if (!controller.signal.aborted) {
          controller.abort(new RequestQueueTimeoutError(timeoutMs, item.id, item.label))
        }
      }, timeoutMs)
    }

    const abort = this.abortPromise(controller.signal, item)
    const work = Promise.resolve().then(() => item.executor({
      signal: controller.signal,
      requestId: item.id,
      phase,
    }))

    try {
      const response = await Promise.race([work, abort.promise])
      item.status = "done"
      item.lastError = undefined
      item.resolve(response)
      return response
    } catch (error) {
      const finalError = controller.signal.aborted
        ? ((controller.signal as any).reason ?? error)
        : error
      item.status = "failed"
      item.lastError = this.describeError(finalError)
      item.reject(finalError)
      throw finalError
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
      abort.cleanup()
    }
  }

  private abortPromise(signal: AbortSignal, item: InternalQueuedRequest): { promise: Promise<never>; cleanup: () => void } {
    if (signal.aborted) {
      return {
        promise: Promise.reject((signal as any).reason ?? new RequestQueueTimeoutError(this.replayTimeoutMs, item.id, item.label)),
        cleanup: () => undefined,
      }
    }

    let listener: (() => void) | null = null
    const promise = new Promise<never>((_, reject) => {
      listener = () => reject((signal as any).reason ?? new RequestQueueTimeoutError(this.replayTimeoutMs, item.id, item.label))
      signal.addEventListener("abort", listener, { once: true })
    })

    return {
      promise,
      cleanup: () => {
        if (listener) signal.removeEventListener("abort", listener)
        listener = null
      },
    }
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === "string") return error
    return "request failed"
  }

  private prune() {
    if (this.queue.length <= this.maxRetention) return
    // Keep only the most recent items.
    this.queue = this.queue.slice(-this.maxRetention)
  }

  /** Mark all queued items as failed (user-initiated cancel). */
  cancelAll() {
    for (const item of this.queue) {
      if (item.status === "queued") {
        const err = new RequestQueueCancelledError(item.label)
        item.status = "failed"
        item.lastError = err.message
        item.reject(err)
      }
    }
    this.prune()
    this.notify()
  }
}

/** Singleton request queue instance. */
export const requestQueue = new RequestQueue()

/** Export the class for testing. */
export { RequestQueue }

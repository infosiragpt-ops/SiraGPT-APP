"use client"

/**
 * RequestQueue — queues fetch requests when the backend is
 * unreachable and replays them when connectivity is restored.
 *
 * Each queued item is replayed at most once. On replay failure
 * the request is dropped (the user can retry manually).
 *
 * Usage:
 *   import { requestQueue } from "@/lib/request-queue"
 *
 *   // Instead of direct fetch, queue it:
 *   const res = await requestQueue.enqueue(() => fetch("/api/..."))
 */

type QueuedRequest = {
  id: string
  executor: () => Promise<Response>
  status: "queued" | "replaying" | "done" | "failed"
  createdAt: number
  label?: string
}

type QueueCallback = (queue: QueuedRequest[]) => void

const MAX_RETENTION = 50 // keep last N finished items for diagnostics

class RequestQueue {
  private queue: QueuedRequest[] = []
  private replaying = false
  private listeners = new Set<QueueCallback>()
  private online = true

  get length() {
    return this.queue.filter((r) => r.status === "queued").length
  }

  get items(): readonly QueuedRequest[] {
    return this.queue
  }

  constructor() {
    if (typeof window !== "undefined") {
      // Detect browser online/offline
      window.addEventListener("online", () => {
        this.online = true
        this.flush()
      })
      window.addEventListener("offline", () => {
        this.online = false
      })
    }
  }

  subscribe(cb: QueueCallback): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notify() {
    for (const cb of this.listeners) {
      try {
        cb([...this.queue])
      } catch {
        // Swallow listener errors
      }
    }
  }

  /**
   * Enqueue a request. Returns a promise that resolves when
   * the request completes (immediately if online, or later when
   * replayed).
   */
  enqueue(executor: () => Promise<Response>, label?: string): Promise<Response> {
    return new Promise((resolve, reject) => {
      const item: QueuedRequest = {
        id: crypto.randomUUID(),
        executor,
        status: "queued",
        createdAt: Date.now(),
        label,
      }

      // Try immediately if online
      if (this.online) {
        item.status = "replaying"
        this.notify()
        executor()
          .then(resolve)
          .catch(reject)
          .finally(() => {
            item.status = "done"
            this.prune()
            this.notify()
          })
        return
      }

      // Offline: queue it
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

    const pending = this.queue.filter((r) => r.status === "queued")
    for (const item of pending) {
      item.status = "replaying"
      this.notify()
      try {
        await item.executor()
        item.status = "done"
      } catch {
        item.status = "failed"
      }
      this.notify()
    }

    this.prune()
    this.replaying = false
  }

  private prune() {
    if (this.queue.length <= MAX_RETENTION) return
    // Keep only the most recent MAX_RETENTION items
    this.queue = this.queue.slice(-MAX_RETENTION)
  }

  /** Mark all queued items as failed (user-initiated cancel) */
  cancelAll() {
    for (const item of this.queue) {
      if (item.status === "queued") {
        item.status = "failed"
      }
    }
    this.notify()
  }
}

/** Singleton request queue instance */
export const requestQueue = new RequestQueue()

/** Export the class for testing */
export { RequestQueue }

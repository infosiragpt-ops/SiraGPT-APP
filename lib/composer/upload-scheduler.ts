/**
 * Parallel upload scheduler (pure). The composer used to send its upload
 * sub-batches one after another: 100 recordings meant 100 serial uploads,
 * each filling only a fraction of the uplink. This module runs a FIFO queue
 * of jobs with a bounded number in flight, keeps the start order stable, lets
 * the caller cancel one job (pending or running) or all of them, and reports
 * the outcomes in input order. No DOM, no network: the job itself does the
 * upload (the chunked transport already parallelises the parts of one file).
 */

export type UploadJob<T> = {
  /** Stable id (the sub-batch index or a temp chip id). */
  id: string
  /** The upload; it must honour `signal` (abort → reject with an abort-shaped error). */
  run: (signal: AbortSignal) => Promise<T>
}

export type UploadOutcome<T> =
  | { id: string; status: "fulfilled"; value: T }
  | { id: string; status: "rejected"; reason: unknown }
  | { id: string; status: "cancelled" }

export type UploadQueueOptions = {
  /** Jobs in flight at once (1–6; default DEFAULT_PARALLEL_UPLOADS). */
  concurrency?: number
  /** Aborting it cancels every pending job and aborts the running ones. */
  signal?: AbortSignal
  onStart?: (id: string) => void
  onSettle?: (outcome: UploadOutcome<unknown>) => void
}

export type UploadQueueHandle<T> = {
  /** Resolves when every job settled (never rejects). Outcomes are in input order. */
  done: Promise<UploadOutcome<T>[]>
  /** Cancel one job: a pending one never starts, a running one is aborted. */
  cancel: (id: string) => boolean
  /** Cancel everything that has not settled. */
  cancelAll: () => void
  /** Ids running right now. */
  running: () => string[]
}

function envInt(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * Files uploaded at once. Each chunked upload already keeps 3 parts in
 * flight, so 2 files × 3 parts ≈ the browser's per-host budget on HTTP/1.1
 * and well within HTTP/2; the uplink, not the count, is the limit.
 */
export const DEFAULT_PARALLEL_UPLOADS = Math.min(
  6,
  Math.max(1, envInt(process.env.NEXT_PUBLIC_COMPOSER_PARALLEL_UPLOADS, 2)),
)

export function isAbortLike(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const e = err as { name?: unknown; code?: unknown; message?: unknown }
  return e.name === "AbortError" || e.code === "ABORT_ERR" || /abort/i.test(String(e.message || ""))
}

/**
 * How many jobs to run at once for a batch: a single job needs no scheduler
 * (1), a batch of large media benefits from the full budget, and a batch of
 * small documents (already grouped into few multipart requests) too.
 */
export function uploadConcurrencyFor(jobCount: number, concurrency: number = DEFAULT_PARALLEL_UPLOADS): number {
  const n = Math.max(1, Math.min(6, Math.floor(concurrency) || 1))
  return Math.max(1, Math.min(n, Math.floor(jobCount) || 1))
}

/**
 * Start the queue. Jobs start in input order as slots free up; `done`
 * resolves with one outcome per job, in input order, once every job settled.
 */
export function runUploadQueue<T>(jobs: UploadJob<T>[], options: UploadQueueOptions = {}): UploadQueueHandle<T> {
  const concurrency = uploadConcurrencyFor(jobs.length, options.concurrency ?? DEFAULT_PARALLEL_UPLOADS)
  const outcomes: UploadOutcome<T>[] = new Array(jobs.length)
  const controllers = new Map<string, AbortController>()
  const cancelledPending = new Set<string>()
  const indexById = new Map<string, number>()
  jobs.forEach((job, index) => indexById.set(job.id, index))
  let next = 0
  let active = 0
  let settled = 0
  let finished = false
  let resolveDone: (value: UploadOutcome<T>[]) => void = () => {}
  const done = new Promise<UploadOutcome<T>[]>((resolve) => { resolveDone = resolve })

  const finishIfDone = () => {
    if (finished || settled < jobs.length) return
    finished = true
    options.signal?.removeEventListener("abort", onGlobalAbort)
    resolveDone(outcomes.slice())
  }

  const settle = (index: number, outcome: UploadOutcome<T>) => {
    if (outcomes[index]) return
    outcomes[index] = outcome
    settled += 1
    try { options.onSettle?.(outcome as UploadOutcome<unknown>) } catch { /* observer errors never stall the queue */ }
    finishIfDone()
  }

  const pump = () => {
    while (!finished && active < concurrency && next < jobs.length) {
      const index = next
      next += 1
      const job = jobs[index]
      if (cancelledPending.has(job.id) || options.signal?.aborted) {
        settle(index, { id: job.id, status: "cancelled" })
        continue
      }
      const controller = new AbortController()
      controllers.set(job.id, controller)
      active += 1
      try { options.onStart?.(job.id) } catch { /* observers never stall the queue */ }
      let promise: Promise<T>
      try {
        promise = Promise.resolve(job.run(controller.signal))
      } catch (err) {
        promise = Promise.reject(err)
      }
      promise.then(
        (value) => {
          active -= 1
          controllers.delete(job.id)
          settle(index, controller.signal.aborted ? { id: job.id, status: "cancelled" } : { id: job.id, status: "fulfilled", value })
          pump()
        },
        (reason) => {
          active -= 1
          controllers.delete(job.id)
          settle(index, controller.signal.aborted || isAbortLike(reason) ? { id: job.id, status: "cancelled" } : { id: job.id, status: "rejected", reason })
          pump()
        },
      )
    }
    if (jobs.length === 0) finishIfDone()
  }

  const cancel = (id: string): boolean => {
    const index = indexById.get(id)
    if (index === undefined || outcomes[index]) return false
    const controller = controllers.get(id)
    if (controller) {
      // Settled as cancelled at once: a job that ignores its signal must not
      // hold `done` hostage. Its slot is freed when its promise settles.
      controller.abort()
      settle(index, { id, status: "cancelled" })
      return true
    }
    cancelledPending.add(id)
    // A pending job that is cancelled settles at once (it never starts),
    // without taking a slot from the ones ahead of it.
    if (index >= next) {
      // Settled lazily by pump() when its turn comes, unless nothing else
      // runs: then settle it now so `done` can resolve.
      if (active === 0 && next >= jobs.length) settle(index, { id, status: "cancelled" })
    }
    return true
  }

  const cancelAll = () => {
    for (const job of jobs) cancel(job.id)
    // Pending jobs not yet reached by pump(): settle them now.
    for (let index = next; index < jobs.length; index += 1) {
      if (!outcomes[index]) settle(index, { id: jobs[index].id, status: "cancelled" })
    }
    next = jobs.length
  }

  const onGlobalAbort = () => cancelAll()
  if (options.signal) {
    if (options.signal.aborted) {
      jobs.forEach((job, index) => settle(index, { id: job.id, status: "cancelled" }))
      return { done, cancel, cancelAll, running: () => [] }
    }
    options.signal.addEventListener("abort", onGlobalAbort, { once: true })
  }
  pump()
  return { done, cancel, cancelAll, running: () => Array.from(controllers.keys()) }
}

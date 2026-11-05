import { describe, expect, it } from "vitest"

import { isAbortLike, runUploadQueue, uploadConcurrencyFor, type UploadJob } from "@/lib/composer/upload-scheduler"

/**
 * The composer's parallel upload scheduler: a FIFO of upload jobs with a
 * bounded number in flight, stable start order, per-job and global cancel,
 * outcomes in input order. Pure: jobs are deferred promises.
 */

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

function job(id: string, started: string[], signals: Map<string, AbortSignal>): { job: UploadJob<string>; gate: Deferred<string> } {
  const gate = deferred<string>()
  return {
    gate,
    job: {
      id,
      run: (signal) => {
        started.push(id)
        signals.set(id, signal)
        return new Promise<string>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })
          gate.promise.then(resolve, reject)
        })
      },
    },
  }
}

describe("runUploadQueue", () => {
  it("runs at most `concurrency` jobs at once, in input order, and reports outcomes in input order", async () => {
    const started: string[] = []
    const signals = new Map<string, AbortSignal>()
    const jobs = ["a", "b", "c", "d", "e"].map((id) => job(id, started, signals))
    const handle = runUploadQueue(jobs.map((j) => j.job), { concurrency: 2 })
    await tick()
    expect(started).toEqual(["a", "b"])
    expect(handle.running()).toEqual(["a", "b"])
    jobs[1].gate.resolve("B")
    await tick()
    expect(started).toEqual(["a", "b", "c"], "a freed slot starts the next job in order")
    jobs[0].gate.resolve("A")
    jobs[2].gate.reject(new Error("boom"))
    await tick()
    expect(started).toEqual(["a", "b", "c", "d", "e"])
    jobs[3].gate.resolve("D")
    jobs[4].gate.resolve("E")
    const outcomes = await handle.done
    expect(outcomes.map((o) => o.id)).toEqual(["a", "b", "c", "d", "e"])
    expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled"])
    expect((outcomes[0] as { value: string }).value).toBe("A")
    expect(String((outcomes[2] as { reason: Error }).reason.message)).toBe("boom")
    expect(handle.running()).toEqual([])
  })

  it("cancel(id): a pending job never starts, a running one is aborted through its signal; the rest continue", async () => {
    const started: string[] = []
    const signals = new Map<string, AbortSignal>()
    const jobs = ["a", "b", "c", "d"].map((id) => job(id, started, signals))
    const settled: string[] = []
    const handle = runUploadQueue(jobs.map((j) => j.job), { concurrency: 1, onSettle: (o) => settled.push(`${o.id}:${o.status}`) })
    await tick()
    expect(handle.cancel("c")).toBe(true)
    expect(handle.cancel("a")).toBe(true)
    await tick()
    expect(signals.get("a")?.aborted).toBe(true)
    expect(started).toEqual(["a", "b"], "a's abort freed the slot for b; c is skipped when its turn comes")
    jobs[1].gate.resolve("B")
    await tick()
    expect(started).toEqual(["a", "b", "d"])
    expect(handle.cancel("zzz")).toBe(false)
    expect(handle.cancel("a")).toBe(false, "already settled")
    jobs[3].gate.resolve("D")
    const outcomes = await handle.done
    expect(outcomes.map((o) => `${o.id}:${o.status}`)).toEqual(["a:cancelled", "b:fulfilled", "c:cancelled", "d:fulfilled"])
    expect(settled).toEqual(["a:cancelled", "b:fulfilled", "c:cancelled", "d:fulfilled"])
  })

  it("cancelAll and the global signal settle everything: running jobs abort, pending ones never start", async () => {
    const started: string[] = []
    const signals = new Map<string, AbortSignal>()
    const jobs = ["a", "b", "c"].map((id) => job(id, started, signals))
    const ctrl = new AbortController()
    const handle = runUploadQueue(jobs.map((j) => j.job), { concurrency: 1, signal: ctrl.signal })
    await tick()
    ctrl.abort()
    const outcomes = await handle.done
    expect(outcomes.map((o) => o.status)).toEqual(["cancelled", "cancelled", "cancelled"])
    expect(started).toEqual(["a"])

    const late = runUploadQueue(["x", "y"].map((id) => job(id, started, signals).job), { concurrency: 2 })
    await tick()
    late.cancelAll()
    expect((await late.done).map((o) => o.status)).toEqual(["cancelled", "cancelled"])

    const aborted = new AbortController()
    aborted.abort()
    const never = runUploadQueue(["n"].map((id) => job(id, started, signals).job), { signal: aborted.signal })
    expect((await never.done).map((o) => o.status)).toEqual(["cancelled"])
    expect(started.includes("n")).toBe(false)

    // A running job that ignores its signal is still settled as cancelled at once: `done` never waits for it.
    const deaf = runUploadQueue<string>([{ id: "deaf", run: () => new Promise(() => {}) }], { concurrency: 1 })
    await tick()
    expect(deaf.cancel("deaf")).toBe(true)
    expect((await deaf.done).map((o) => o.status)).toEqual(["cancelled"])
  })

  it("a job that throws synchronously or rejects with an abort-shaped error is classified without stalling the queue; an empty queue resolves", async () => {
    const outcomes = await runUploadQueue<string>([
      { id: "sync", run: () => { throw new Error("sync failure") } },
      { id: "abortish", run: () => Promise.reject(Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" })) },
      { id: "ok", run: async () => "fine" },
    ], { concurrency: 3 }).done
    expect(outcomes.map((o) => o.status)).toEqual(["rejected", "cancelled", "fulfilled"])
    expect((await runUploadQueue([], {}).done)).toEqual([])
    expect(isAbortLike(new DOMException("x", "AbortError"))).toBe(true)
    expect(isAbortLike(new Error("network"))).toBe(false)
  })

  it("uploadConcurrencyFor: one job needs no parallelism; the budget is bounded to 1–6 and never above the job count", () => {
    expect(uploadConcurrencyFor(1, 3)).toBe(1)
    expect(uploadConcurrencyFor(5, 3)).toBe(3)
    expect(uploadConcurrencyFor(2, 3)).toBe(2)
    expect(uploadConcurrencyFor(100, 99)).toBe(6)
    expect(uploadConcurrencyFor(100, 0)).toBe(1)
    expect(uploadConcurrencyFor(0, 3)).toBe(1)
  })
})

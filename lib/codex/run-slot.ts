import type { CodexRun } from "./codex-api"

const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "waiting_approval"])

type RunSlotOptions<T> = {
  projectId: string
  operation: () => Promise<T>
  listRuns: (projectId: string) => Promise<CodexRun[]>
  signal?: AbortSignal
  timeoutMs?: number
  pollMs?: number
  onWait?: (run: CodexRun | null) => void
}

function abortError() {
  return new DOMException("La generación fue detenida", "AbortError")
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export function activeCodexRun(runs: CodexRun[]): CodexRun | null {
  return (
    runs
      .filter((run) => ACTIVE_RUN_STATUSES.has(run.status))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] || null
  )
}

export function isCodexRunInProgressError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const candidate = error as {
    status?: number
    message?: string
    body?: { error?: string; message?: string }
  }
  return (
    candidate.status === 409 &&
    (candidate.body?.error === "run_in_progress" ||
      /\brun_in_progress\b/i.test(candidate.message || "") ||
      /\brun activo\b/i.test(candidate.body?.message || ""))
  )
}

/**
 * Retry a Codex mutation only after the previous department/project run has
 * released its single-run slot. We never cancel or approve that run here:
 * CEO Office keeps ownership, this caller simply waits and remains stoppable.
 */
export async function runWhenCodexProjectIdle<T>({
  projectId,
  operation,
  listRuns,
  signal,
  timeoutMs = 120_000,
  pollMs = 900,
  onWait,
}: RunSlotOptions<T>): Promise<T> {
  const startedAt = Date.now()
  let conflictCount = 0

  while (true) {
    if (signal?.aborted) throw abortError()
    try {
      return await operation()
    } catch (error) {
      if (!isCodexRunInProgressError(error)) throw error
      conflictCount += 1
    }

    while (true) {
      if (signal?.aborted) throw abortError()
      const elapsed = Date.now() - startedAt
      if (elapsed >= timeoutMs) {
        throw Object.assign(
          new Error("La tarea anterior sigue activa; el turno continúa protegido en la cola."),
          { code: "codex_run_slot_timeout", conflictCount },
        )
      }

      const active = activeCodexRun(await listRuns(projectId))
      onWait?.(active)
      if (!active) break
      await delay(Math.min(pollMs, timeoutMs - elapsed), signal)
    }

    // Close the small list/create race when two departments wake together.
    await delay(Math.min(180 + conflictCount * 40, 420), signal)
  }
}

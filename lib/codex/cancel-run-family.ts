export type CancellableCodexRun = {
  id: string
  status?: string | null
  planRunId?: string | null
}

export type ActiveCodexRun = {
  projectId: string
  runId: string
}

export type CancelCodexRunFamilyDeps = {
  cancelRun: (runId: string) => Promise<unknown>
  cancelFamily?: (runId: string) => Promise<{ cancelledRunIds?: string[] }>
  listRuns: (projectId: string) => Promise<CancellableCodexRun[]>
  settle?: () => Promise<void>
}

const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "waiting_approval"])

function isIdempotentCancelError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const candidate = error as {
    status?: number
    code?: string
    message?: string
    body?: { error?: string; message?: string }
  }
  const code = String(candidate.code || candidate.body?.error || "").toLowerCase()
  const message = `${candidate.message || ""} ${candidate.body?.message || ""}`.toLowerCase()
  return (
    candidate.status === 404
    || (candidate.status === 409 && (
      code === "run_already_terminal"
      || /already (?:done|error|cancelled|terminal)|ya (?:termin|cancel)/i.test(message)
    ))
    || code === "run_not_found"
  )
}

/**
 * Cancels the run visible in /code and any build that raced with automatic
 * plan continuation. Cancellation is intentionally idempotent: a terminal or
 * already-removed run must not prevent its still-active child from stopping.
 */
export async function cancelCodexRunFamily(
  active: ActiveCodexRun,
  deps: CancelCodexRunFamilyDeps,
): Promise<string[]> {
  if (deps.cancelFamily) {
    try {
      const result = await deps.cancelFamily(active.runId)
      return Array.isArray(result?.cancelledRunIds) ? result.cancelledRunIds : []
    } catch (error) {
      if (isIdempotentCancelError(error)) return []
      throw error
    }
  }

  const confirmed = new Set<string>()
  const failures = new Map<string, unknown>()
  let listFailure: unknown = null

  const cancel = async (runId: string) => {
    if (!runId || confirmed.has(runId)) return
    try {
      await deps.cancelRun(runId)
      confirmed.add(runId)
      failures.delete(runId)
    } catch (error) {
      if (isIdempotentCancelError(error)) {
        confirmed.add(runId)
        failures.delete(runId)
        return
      }
      // Keep real auth/network/server failures retryable and observable. A
      // local AbortController is not proof that the durable worker stopped.
      failures.set(runId, error)
    }
  }

  const cancelActiveChildren = async () => {
    let runs: CancellableCodexRun[] = []
    try {
      runs = await deps.listRuns(active.projectId)
      listFailure = null
    } catch (error) {
      listFailure = error
      return
    }
    for (const run of runs) {
      if (
        run.id !== active.runId
        && run.planRunId !== active.runId
      ) continue
      if (run.status && !ACTIVE_RUN_STATUSES.has(run.status)) continue
      await cancel(run.id)
    }
  }

  await cancel(active.runId)
  await cancelActiveChildren()
  if (deps.settle) await deps.settle()
  // Retry the parent too: a transient failure must not be turned into a false
  // success merely because the local stream already disappeared.
  await cancel(active.runId)
  await cancelActiveChildren()

  if (listFailure || failures.size > 0) {
    const error = new Error("No se pudo confirmar la cancelación durable de toda la ejecución.") as Error & {
      errors?: unknown[]
    }
    error.errors = [listFailure, ...failures.values()].filter(Boolean)
    throw error
  }

  return [...confirmed]
}

/**
 * A stop can land while POST /runs is still in flight, before the UI knows the
 * durable run id. Fence that response before any bind/SSE work: if the caller
 * stopped meanwhile, cancel the newly-known family atomically and return it as
 * non-streamable.
 */
export async function createCodexRunWithCancellationFence<T extends { id: string }>({
  projectId,
  createRun,
  isCancelled,
  cancelDeps,
}: {
  projectId: string
  createRun: () => Promise<T>
  isCancelled: () => boolean
  cancelDeps: CancelCodexRunFamilyDeps
}): Promise<{ run: T; cancelled: false } | { run: T; cancelled: true; cancellationError?: unknown }> {
  const run = await createRun()
  if (!isCancelled()) return { run, cancelled: false }

  try {
    await cancelCodexRunFamily({ projectId, runId: run.id }, cancelDeps)
    return { run, cancelled: true }
  } catch (cancellationError) {
    return { run, cancelled: true, cancellationError }
  }
}

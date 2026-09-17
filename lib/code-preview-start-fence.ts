export type PreviewStartFenceResult<T> =
  | { stale: false; value: T; cleaned: false }
  | { stale: true; value: T; cleaned: boolean }

export type PreviewResourceLease = {
  key: string
  generation: number
  active: boolean
}

/** A stale owner may clean up unless a newer active owner shares its resource. */
export function shouldCleanupStalePreviewStart(
  lease: PreviewResourceLease | null,
  key: string,
  generation: number,
): boolean {
  return !(
    lease
    && lease.key === key
    && lease.active
    && lease.generation !== generation
  )
}

/** Wait for an earlier /start so two runner boots never overlap. */
export async function waitForPreviousPreviewStart(
  previous: Promise<unknown> | null | undefined,
): Promise<void> {
  if (!previous) return
  try {
    await previous
  } catch {
    // A rejected predecessor must not block the successor /start.
  }
}

/** One in-flight start slot. settle() is idempotent so self-heal can re-enter runApp. */
export function trackPreviewStartFlight(): { flight: Promise<void>; settle: () => void } {
  let settled = false
  let release = () => {}
  const flight = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    flight,
    settle() {
      if (settled) return
      settled = true
      release()
    },
  }
}

/**
 * A stop/unmount request can reach the backend before a slow start request
 * finishes creating its server. Once that start settles, compensate again if
 * its owning UI generation is stale so the just-created server cannot leak.
 */
export async function startPreviewWithCleanupFence<T>({
  start,
  isCurrent,
  cleanup,
  shouldCleanup = () => true,
}: {
  start: () => Promise<T>
  isCurrent: () => boolean
  cleanup: () => Promise<unknown>
  shouldCleanup?: () => boolean
}): Promise<PreviewStartFenceResult<T>> {
  const value = await start()
  if (isCurrent()) return { stale: false, value, cleaned: false }

  // Start A and successor B may share one project/repo/run id. If B currently
  // owns that resource, A must discard its result without stopping B.
  if (!shouldCleanup()) return { stale: true, value, cleaned: false }

  try {
    await cleanup()
  } catch {
    // Best effort and idempotent. Backend idle reapers remain the final guard.
  }
  return { stale: true, value, cleaned: true }
}

const previewStartLocks = new Map<string, Promise<void>>()

/**
 * Exclusive start slot per resource key. Two overlapping /start calls for the
 * same preview never race: the successor waits, then the predecessor may only
 * clean up if shouldCleanupStalePreviewStart says so.
 */
export async function acquirePreviewStartFence(key: string): Promise<() => void> {
  const slot = String(key || "default")
  const previous = previewStartLocks.get(slot)
  let release = () => {}
  const mine = new Promise<void>((resolve) => {
    release = resolve
  })
  previewStartLocks.set(slot, mine)
  if (previous) {
    try { await previous } catch { /* predecessor must not block successor */ }
  }
  return () => {
    if (previewStartLocks.get(slot) === mine) previewStartLocks.delete(slot)
    release()
  }
}

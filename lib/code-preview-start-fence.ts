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

/** Discards a slow status response once a newer poll has already been issued. */
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

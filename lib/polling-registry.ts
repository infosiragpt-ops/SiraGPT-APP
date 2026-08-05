export type PollingTimer = ReturnType<typeof setTimeout>

export interface PollingRegistry {
  register: (key: string, timer: PollingTimer) => void
  clear: (key: string) => void
  clearAll: () => void
  get: (key: string) => PollingTimer | undefined
  has: (key: string) => boolean
  size: () => number
}

/**
 * Owns independent polling timers by operation id.
 *
 * Registering one operation never touches sibling operations. Registering a
 * replacement for the same id clears only the superseded timer, and provider
 * teardown can clear the complete registry in one place.
 */
export function createPollingRegistry(
  clearTimer: (timer: PollingTimer) => void = clearTimeout,
): PollingRegistry {
  const timers = new Map<string, PollingTimer>()

  const clear = (key: string) => {
    const timer = timers.get(key)
    if (timer !== undefined) clearTimer(timer)
    timers.delete(key)
  }

  return {
    register(key, timer) {
      const previous = timers.get(key)
      if (previous !== undefined && previous !== timer) clearTimer(previous)
      timers.set(key, timer)
    },
    clear,
    clearAll() {
      timers.forEach((timer) => clearTimer(timer))
      timers.clear()
    },
    get: (key) => timers.get(key),
    has: (key) => timers.has(key),
    size: () => timers.size,
  }
}

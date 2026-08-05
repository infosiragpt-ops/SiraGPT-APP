export type SerializedPreviewPollController = {
  stop: () => void
}

/**
 * Schedules the next status read only after the previous one settles. Slow
 * runners therefore make progress without overlapping requests or allowing an
 * older response to overwrite a newer state.
 */
export function startSerializedPreviewPoll<T, Timer>({
  read,
  intervalMs,
  isCurrent,
  onValue,
  onError,
  deadlineAtMs,
  onDeadline,
  now = Date.now,
  schedule,
  clear,
}: {
  read: (signal: AbortSignal) => Promise<T>
  intervalMs: number
  isCurrent: () => boolean
  onValue: (value: T) => boolean | void | Promise<boolean | void>
  onError?: (error: unknown) => boolean | void | Promise<boolean | void>
  deadlineAtMs?: number
  onDeadline?: () => void | Promise<void>
  now?: () => number
  schedule: (callback: () => void, delayMs: number) => Timer
  clear: (timer: Timer) => void
}): SerializedPreviewPollController {
  let stopped = false
  let timer: Timer | null = null
  let deadlineTimer: Timer | null = null
  let activeReadController: AbortController | null = null

  const clearTimer = () => {
    if (timer === null) return
    clear(timer)
    timer = null
  }

  const clearDeadlineTimer = () => {
    if (deadlineTimer === null) return
    clear(deadlineTimer)
    deadlineTimer = null
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    clearTimer()
    clearDeadlineTimer()
    activeReadController?.abort()
    activeReadController = null
  }

  const deadlineReached = () => deadlineAtMs !== undefined && now() >= deadlineAtMs

  const expire = async () => {
    if (stopped) return
    if (!isCurrent()) {
      stop()
      return
    }
    stop()
    try {
      await onDeadline?.()
    } catch {
      // Deadline cleanup is best-effort UI work. The poll is already stopped;
      // never turn a rendering callback into an unhandled rejection.
    }
  }

  const queueNext = () => {
    if (stopped) return
    if (!isCurrent()) {
      stop()
      return
    }
    if (deadlineReached()) {
      void expire()
      return
    }
    timer = schedule(() => {
      timer = null
      void tick()
    }, intervalMs)
  }

  const tick = async () => {
    if (stopped) return
    if (!isCurrent()) {
      stop()
      return
    }
    if (deadlineReached()) {
      await expire()
      return
    }

    const readController = new AbortController()
    activeReadController = readController
    let value: T
    try {
      value = await read(readController.signal)
    } catch (error) {
      // Status endpoints can fail transiently while the runner is booting or
      // reconnecting. Keep the loop serialized and retry only while this poll
      // still owns the current preview generation.
      if (activeReadController === readController) activeReadController = null
      if (stopped) return
      if (!isCurrent()) {
        stop()
        return
      }
      if (deadlineReached()) {
        await expire()
        return
      }
      if (onError && await onError(error) === false) {
        stop()
        return
      }
      if (deadlineReached()) {
        await expire()
        return
      }
      queueNext()
      return
    }
    if (activeReadController === readController) activeReadController = null
    if (stopped) return
    if (!isCurrent()) {
      stop()
      return
    }
    if (deadlineReached()) {
      await expire()
      return
    }
    if (await onValue(value) === false) {
      stop()
      return
    }
    if (stopped) return
    if (!isCurrent()) {
      stop()
      return
    }
    queueNext()
  }

  if (deadlineAtMs !== undefined) {
    deadlineTimer = schedule(() => {
      deadlineTimer = null
      void expire()
    }, Math.max(0, deadlineAtMs - now()))
  }
  queueNext()
  return { stop }
}

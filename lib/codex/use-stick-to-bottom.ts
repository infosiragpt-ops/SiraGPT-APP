// codex/use-stick-to-bottom — auto-scroll-to-bottom behavior for the streaming
// timeline (feature 10). While pinned, new content keeps the view at the
// bottom; if the user scrolls up, a floating "Scroll to latest" pill appears and
// auto-scroll disengages until they click it (or scroll back down).
//
// The threshold logic is a pure function so it can be unit-tested without a DOM.

import { useCallback, useEffect, useRef, useState } from 'react'

export const DEFAULT_STICK_THRESHOLD_PX = 80

/** True when the scroll position is within `threshold` px of the bottom. */
export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = DEFAULT_STICK_THRESHOLD_PX,
): boolean {
  const distanceFromBottom = scrollHeight - clientHeight - scrollTop
  return distanceFromBottom <= threshold
}

export interface StickToBottom {
  ref: React.RefObject<HTMLDivElement>
  pinned: boolean
  showPill: boolean
  /** Call after content changes to keep the view pinned if appropriate. */
  scrollToBottom: (smooth?: boolean) => void
  onScroll: () => void
}

/**
 * @param dep a value that changes whenever new content arrives (e.g. item count
 *            or last seq) — drives the auto-scroll effect.
 */
export function useStickToBottom(dep: unknown, threshold = DEFAULT_STICK_THRESHOLD_PX): StickToBottom {
  const ref = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  const [showPill, setShowPill] = useState(false)

  const scrollToBottom = useCallback((smooth = false) => {
    const el = ref.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    setPinned(true)
    setShowPill(false)
  }, [])

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    const near = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight, threshold)
    setPinned(near)
    setShowPill(!near)
  }, [threshold])

  // When new content arrives, keep the view at the bottom only if still pinned.
  useEffect(() => {
    if (pinned) {
      const el = ref.current
      if (el) el.scrollTop = el.scrollHeight
    } else {
      setShowPill(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep])

  return { ref, pinned, showPill, scrollToBottom, onScroll }
}

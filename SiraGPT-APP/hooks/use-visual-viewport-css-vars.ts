"use client"

import * as React from "react"

export type VisualViewportMetrics = {
  width: number
  height: number
  layoutWidth: number
  layoutHeight: number
  offsetLeft: number
  offsetTop: number
  keyboardHeight: number
}

type UseVisualViewportCssVarsOptions = {
  targetRef?: React.RefObject<HTMLElement | null>
  prefix: string
  enabled?: boolean
  onSync?: (metrics: VisualViewportMetrics) => void
}

const useIsoLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

const KEYBOARD_OPEN_HEIGHT_PX = 120

function setCssPx(target: HTMLElement, name: string, value: number) {
  target.style.setProperty(name, `${Math.max(0, Math.round(value))}px`)
}

export function readVisualViewportMetrics(): VisualViewportMetrics {
  const root = document.documentElement
  const visualViewport = window.visualViewport
  const layoutWidth = window.innerWidth || root.clientWidth
  const layoutHeight = window.innerHeight || root.clientHeight
  const rawWidth = visualViewport?.width || layoutWidth
  const rawHeight = visualViewport?.height || layoutHeight
  const rawOffsetLeft = visualViewport?.offsetLeft || 0
  const rawOffsetTop = visualViewport?.offsetTop || 0

  // Pinch- / double-tap-zoom shrinks the visual viewport WITHOUT an on-screen
  // keyboard: visualViewport.scale rises above 1. The on-screen keyboard, by
  // contrast, keeps scale at 1 and only reduces height. When the user is
  // zoomed in we must NOT mistake that shrink for a keyboard — doing so
  // collapses the app shell to the zoomed region, leaving dead space and
  // pushing the chat composer out of view (it disappears). While zoomed, fall
  // back to the layout viewport for size + offset and report no keyboard, so
  // the shell keeps filling the window and the user can pan the zoom freely.
  // Real mobile keyboards (scale === 1) are unaffected.
  const scale = visualViewport?.scale ?? 1
  const zoomed = scale > 1.01
  const width = zoomed ? layoutWidth : rawWidth
  const height = zoomed ? layoutHeight : rawHeight
  const offsetLeft = zoomed ? 0 : rawOffsetLeft
  const offsetTop = zoomed ? 0 : rawOffsetTop
  const keyboardHeight = zoomed
    ? 0
    : Math.max(0, layoutHeight - rawHeight - rawOffsetTop)

  return {
    width,
    height,
    layoutWidth,
    layoutHeight,
    offsetLeft,
    offsetTop,
    keyboardHeight,
  }
}

export function useVisualViewportCssVars({
  targetRef,
  prefix,
  enabled = true,
  onSync,
}: UseVisualViewportCssVarsOptions) {
  const onSyncRef = React.useRef(onSync)

  React.useEffect(() => {
    onSyncRef.current = onSync
  }, [onSync])

  useIsoLayoutEffect(() => {
    if (!enabled || typeof window === "undefined") return

    let frame = 0

    const syncViewportVars = () => {
      frame = 0
      const target = targetRef?.current || document.documentElement
      const metrics = readVisualViewportMetrics()

      setCssPx(target, `--${prefix}-viewport-width`, metrics.width)
      setCssPx(target, `--${prefix}-viewport-height`, metrics.height)
      setCssPx(target, `--${prefix}-layout-viewport-width`, metrics.layoutWidth)
      setCssPx(target, `--${prefix}-layout-viewport-height`, metrics.layoutHeight)
      setCssPx(target, `--${prefix}-viewport-offset-left`, metrics.offsetLeft)
      setCssPx(target, `--${prefix}-viewport-offset-top`, metrics.offsetTop)
      setCssPx(target, `--${prefix}-keyboard-height`, metrics.keyboardHeight)
      target.dataset[`${prefix}Keyboard`] =
        metrics.keyboardHeight >= KEYBOARD_OPEN_HEIGHT_PX ? "open" : "closed"

      onSyncRef.current?.(metrics)
    }

    const scheduleSync = () => {
      if (frame) return
      frame = window.requestAnimationFrame(syncViewportVars)
    }

    syncViewportVars()
    window.addEventListener("resize", scheduleSync, { passive: true })
    window.addEventListener("orientationchange", scheduleSync, { passive: true })
    window.visualViewport?.addEventListener("resize", scheduleSync, { passive: true })
    window.visualViewport?.addEventListener("scroll", scheduleSync, { passive: true })

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener("resize", scheduleSync)
      window.removeEventListener("orientationchange", scheduleSync)
      window.visualViewport?.removeEventListener("resize", scheduleSync)
      window.visualViewport?.removeEventListener("scroll", scheduleSync)
    }
  }, [enabled, prefix, targetRef])
}

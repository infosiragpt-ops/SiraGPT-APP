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

function setCssPx(target: HTMLElement, name: string, value: number) {
  target.style.setProperty(name, `${Math.max(0, Math.round(value))}px`)
}

export function readVisualViewportMetrics(): VisualViewportMetrics {
  const root = document.documentElement
  const visualViewport = window.visualViewport
  const layoutWidth = window.innerWidth || root.clientWidth
  const layoutHeight = window.innerHeight || root.clientHeight
  const width = visualViewport?.width || layoutWidth
  const height = visualViewport?.height || layoutHeight
  const offsetLeft = visualViewport?.offsetLeft || 0
  const offsetTop = visualViewport?.offsetTop || 0
  const keyboardHeight = Math.max(0, layoutHeight - height - offsetTop)

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
